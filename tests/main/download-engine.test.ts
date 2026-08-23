import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { DownloadEngine, type DownloadSession } from '../../src/main/download/engine';
import {
  calculateDownloadProgress,
  exponentialMovingAverage,
  mapDownloadItemState,
} from '../../src/main/download/metrics';

const DOWNLOAD_URL = 'https://downloads.example.com/tool.exe';
const STALL_TIMEOUT_MS = 45_000;

const createDownloadItem = (overrides: Record<string, unknown> = {}) =>
  Object.assign(
    new EventEmitter(),
    {
      canResume: vi.fn(() => true),
      cancel: vi.fn(),
      getReceivedBytes: vi.fn(() => 0),
      getETag: vi.fn(() => '"fixture"'),
      getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
      getStartTime: vi.fn(() => Date.now() / 1000),
      getState: vi.fn(() => 'progressing'),
      getTotalBytes: vi.fn(() => 1_000),
      getURL: vi.fn(() => DOWNLOAD_URL),
      getURLChain: vi.fn(() => [DOWNLOAD_URL]),
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
      resume: vi.fn(),
      setSavePath: vi.fn(),
    },
    overrides,
  );

const writeRecoveryFixture = (userDataPath: string, id = 'recovered-tool') => {
  const finalPath = path.join(userDataPath, 'downloads', `${id}.exe`);
  const savePath = `${finalPath}.partial`;
  mkdirSync(path.dirname(savePath), { recursive: true });
  writeFileSync(savePath, Buffer.alloc(100));
  const entry = {
    allowedHosts: ['downloads.example.com'],
    allowedPathPrefixes: ['/tool.exe'],
    eTag: '"fixture"',
    finalPath,
    id,
    label: '恢复测试工具',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    length: 1_000,
    maxBytes: 10_000,
    receivedBytes: 100,
    savePath,
    startTime: 1_700_000_000,
    urlChain: [DOWNLOAD_URL],
  };
  writeFileSync(path.join(userDataPath, 'download-journal.json'), JSON.stringify([entry]));
  return { entry, finalPath, savePath };
};

const readJournal = (userDataPath: string): Array<{ id: string }> =>
  JSON.parse(readFileSync(path.join(userDataPath, 'download-journal.json'), 'utf8')) as Array<{
    id: string;
  }>;

const createRequest = (userDataPath: string, id = 'tool') => ({
  allowedHosts: ['downloads.example.com'],
  allowedPathPrefixes: ['/tool.exe'],
  finalPath: path.join(userDataPath, 'outputs', `${id}.exe`),
  id,
  label: '测试工具',
  maxBytes: 10_000,
  url: DOWNLOAD_URL,
});

describe('download engine', () => {
  it('smooths speed with EMA and calculates ETA', () => {
    expect(exponentialMovingAverage(1_000, 1_000, 500)).toBe(1_300);
    expect(calculateDownloadProgress(250, 1_000, 250)).toEqual({
      percent: 25,
      remainingMs: 3_000,
    });
  });

  it('uses -1 for unknown length without inventing progress', () => {
    expect(calculateDownloadProgress(250, 0, 250)).toEqual({
      percent: -1,
      remainingMs: -1,
    });
  });

  it('maps Electron updates to stable domain states', () => {
    expect(mapDownloadItemState('progressing', false, true)).toBe('progressing');
    expect(mapDownloadItemState('progressing', true, true)).toBe('paused');
    expect(mapDownloadItemState('interrupted', false, true)).toBe('paused');
    expect(mapDownloadItemState('interrupted', false, false)).toBe('failed');
  });

  it('releases the busy lease when the initial journal write fails', async () => {
    const session = Object.assign(new EventEmitter(), {
      createInterruptedDownload: vi.fn(),
      downloadURL: vi.fn(),
    });
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-journal-fail-'));
    /*
     * The journal writes to `<userData>/download-journal.json.tmp` and renames it into place. A
     * directory at that exact path makes writeFileSync fail with EISDIR — a stand-in for ENOSPC or
     * EACCES — without mocking node:fs.
     */
    mkdirSync(path.join(userDataPath, 'download-journal.json.tmp'), { recursive: true });
    const busyRegistry = new BusyRegistry();
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      busyRegistry,
      userDataPath,
    );

    await expect(
      engine.start({
        allowedHosts: ['downloads.example.com'],
        allowedPathPrefixes: ['/tool.exe'],
        finalPath: path.join(userDataPath, 'downloads', 'tool.exe'),
        id: 'leaky-tool',
        label: '日志写入失败',
        maxBytes: 100,
        url: 'https://downloads.example.com/tool.exe',
      }),
    ).rejects.toThrow();

    // A leaked lease would sit in the quit confirmation dialog forever and permanently block retry,
    // because both the task id and the lease id are derived from the request id.
    expect(busyRegistry.list()).toEqual([]);
    expect(session.downloadURL).not.toHaveBeenCalled();
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('rolls back a synchronous interrupted-download creation throw without losing recovery state', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-restore-sync-'));
    const { entry } = writeRecoveryFixture(userDataPath);
    const createInterruptedDownload = vi.fn(() => {
      throw new Error('invalid recovery record');
    });
    const session = Object.assign(new EventEmitter(), {
      createInterruptedDownload,
      downloadURL: vi.fn(),
    });
    const busyRegistry = new BusyRegistry();
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      busyRegistry,
      userDataPath,
    );

    engine.restoreInterrupted();

    expect(createInterruptedDownload).toHaveBeenCalledOnce();
    expect(engine.list()).toEqual([]);
    expect(busyRegistry.list()).toEqual([]);
    expect(readJournal(userDataPath)).toEqual([expect.objectContaining({ id: entry.id })]);

    // The pending claim and task id must both be gone: a late item is refused and the record retries.
    const preventDefault = vi.fn();
    session.emit('will-download', { preventDefault }, createDownloadItem());
    expect(preventDefault).toHaveBeenCalledOnce();
    engine.restoreInterrupted();
    expect(createInterruptedDownload).toHaveBeenCalledTimes(2);
    expect(engine.list()).toEqual([]);
    expect(busyRegistry.list()).toEqual([]);
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('rolls back an asynchronously rejected interrupted-download creation', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-restore-async-'));
    const { entry } = writeRecoveryFixture(userDataPath);
    const session = Object.assign(new EventEmitter(), {
      createInterruptedDownload: vi.fn(() => Promise.reject(new Error('recovery rejected'))),
      downloadURL: vi.fn(),
    });
    const busyRegistry = new BusyRegistry();
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      busyRegistry,
      userDataPath,
    );

    engine.restoreInterrupted();
    await vi.waitFor(() => expect(busyRegistry.list()).toEqual([]));

    expect(engine.list()).toEqual([]);
    expect(readJournal(userDataPath)).toEqual([expect.objectContaining({ id: entry.id })]);
    const preventDefault = vi.fn();
    session.emit('will-download', { preventDefault }, createDownloadItem());
    expect(preventDefault).toHaveBeenCalledOnce();
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('rolls back an asynchronous restore item that fails while binding', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-restore-bind-'));
    const { entry } = writeRecoveryFixture(userDataPath);
    const session = Object.assign(new EventEmitter(), {
      createInterruptedDownload: vi.fn(),
      downloadURL: vi.fn(),
    });
    const busyRegistry = new BusyRegistry();
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      busyRegistry,
      userDataPath,
    );
    const item = createDownloadItem({
      getReceivedBytes: vi.fn(() => 100),
      setSavePath: vi.fn(() => {
        throw new Error('item binding failed');
      }),
    });

    engine.restoreInterrupted();
    await Promise.resolve();
    expect(() => session.emit('will-download', { preventDefault: vi.fn() }, item)).not.toThrow();

    expect(item.cancel).toHaveBeenCalledOnce();
    expect(engine.list()).toEqual([]);
    expect(busyRegistry.list()).toEqual([]);
    expect(readJournal(userDataPath)).toEqual([expect.objectContaining({ id: entry.id })]);
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('drops a recovery record only when a synchronous item violates an explicit safety policy', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-restore-policy-'));
    const { savePath } = writeRecoveryFixture(userDataPath);
    const item = createDownloadItem({
      getURLChain: vi.fn(() => [DOWNLOAD_URL, 'https://untrusted.example.net/tool.exe']),
    });
    const session = Object.assign(new EventEmitter(), {
      createInterruptedDownload: vi.fn(),
      downloadURL: vi.fn(),
    });
    session.createInterruptedDownload.mockImplementation(() => {
      session.emit('will-download', { preventDefault: vi.fn() }, item);
    });
    const busyRegistry = new BusyRegistry();
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      busyRegistry,
      userDataPath,
    );

    engine.restoreInterrupted();

    expect(item.cancel).toHaveBeenCalledOnce();
    expect(engine.list()[0]).toMatchObject({ state: 'failed' });
    expect(busyRegistry.list()).toEqual([]);
    expect(readJournal(userDataPath)).toEqual([]);
    expect(existsSync(savePath)).toBe(false);
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('settles a cancelled download even when the journal has become unwritable', async () => {
    /*
     * The counterpart to the start-path test above. A journal write at start is deliberately fatal,
     * but once `settled = true` has been set the trade-off inverts: a throwing write would skip
     * `releaseBusy()` and `reject()` while making the task ineligible for `fail()`, so the caller
     * would wait forever on a lease that blocks the quit dialog and can never be retried.
     */
    const session = new EventEmitter() as EventEmitter & { downloadURL: (url: string) => void };
    session.downloadURL = vi.fn();
    Object.assign(session, { createInterruptedDownload: vi.fn() });
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-download-'));
    const item = Object.assign(new EventEmitter(), {
      canResume: vi.fn(() => true),
      cancel: vi.fn(),
      getReceivedBytes: vi.fn(() => 100),
      getETag: vi.fn(() => '"fixture"'),
      getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
      getStartTime: vi.fn(() => Date.now() / 1000),
      getTotalBytes: vi.fn(() => 1_000),
      getURL: vi.fn(() => 'https://downloads.example.com/tool.exe'),
      getURLChain: vi.fn(() => ['https://downloads.example.com/tool.exe']),
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
      resume: vi.fn(),
      setSavePath: vi.fn(),
    });
    const busyRegistry = new BusyRegistry();
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      busyRegistry,
      userDataPath,
    );
    const completion = engine.start({
      allowedHosts: ['downloads.example.com'],
      allowedPathPrefixes: ['/tool.exe'],
      finalPath: path.join(userDataPath, 'outputs', 'tool.exe'),
      id: 'tool',
      label: '测试工具',
      maxBytes: 10_000,
      url: 'https://downloads.example.com/tool.exe',
    });
    session.emit('will-download', { preventDefault: vi.fn() }, item);
    expect(busyRegistry.list()).not.toEqual([]);

    // The start-time write already succeeded; the disk only turns hostile afterwards.
    mkdirSync(path.join(userDataPath, 'download-journal.json.tmp'), { recursive: true });
    engine.cancel('tool');
    item.emit('done', {}, 'cancelled');

    await expect(completion).rejects.toThrow('下载已取消。');
    expect(busyRegistry.list()).toEqual([]);
    expect(engine.list()[0]?.state).toBe('cancelled');
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('captures DownloadItem and exposes pause, resume and cancellation', async () => {
    const session = new EventEmitter() as EventEmitter & { downloadURL: (url: string) => void };
    session.downloadURL = vi.fn();
    Object.assign(session, { createInterruptedDownload: vi.fn() });
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-download-'));
    const item = Object.assign(new EventEmitter(), {
      canResume: vi.fn(() => true),
      cancel: vi.fn(),
      getReceivedBytes: vi.fn(() => 100),
      getETag: vi.fn(() => '"fixture"'),
      getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
      getStartTime: vi.fn(() => Date.now() / 1000),
      getTotalBytes: vi.fn(() => 1_000),
      getURL: vi.fn(() => 'https://downloads.example.com/tool.exe'),
      getURLChain: vi.fn(() => ['https://downloads.example.com/tool.exe']),
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
      resume: vi.fn(),
      setSavePath: vi.fn(),
    });
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      new BusyRegistry(),
      userDataPath,
    );
    const finalPath = path.join(userDataPath, 'outputs', 'test-tool.exe');
    const completion = engine
      .start({
        allowedHosts: ['downloads.example.com'],
        allowedPathPrefixes: ['/tool.exe'],
        finalPath,
        id: 'tool',
        label: '测试工具',
        maxBytes: 10_000,
        url: 'https://downloads.example.com/tool.exe',
      })
      .catch(() => undefined);
    session.emit('will-download', { preventDefault: vi.fn() }, item);

    expect(item.setSavePath).toHaveBeenCalledWith(`${finalPath}.partial`);
    expect(engine.list()[0]).toMatchObject({ percent: 10, state: 'progressing' });
    engine.pause('tool');
    expect(item.pause).toHaveBeenCalledOnce();
    engine.resume('tool');
    expect(item.resume).toHaveBeenCalledOnce();
    engine.cancel('tool');
    expect(item.cancel).toHaveBeenCalledOnce();
    item.emit('done', {}, 'cancelled');
    await completion;
    expect(engine.list()[0]?.state).toBe('cancelled');
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('continues a resumable interruption automatically instead of failing the task', async () => {
    vi.useFakeTimers();
    try {
      const session = new EventEmitter() as EventEmitter & { downloadURL: (url: string) => void };
      session.downloadURL = vi.fn();
      Object.assign(session, { createInterruptedDownload: vi.fn() });
      const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-download-'));
      let state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' = 'progressing';
      const item = Object.assign(new EventEmitter(), {
        canResume: vi.fn(() => true),
        cancel: vi.fn(),
        getReceivedBytes: vi.fn(() => 100),
        getETag: vi.fn(() => '"fixture"'),
        getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
        getStartTime: vi.fn(() => Date.now() / 1000),
        getState: vi.fn(() => state),
        getTotalBytes: vi.fn(() => 1_000),
        getURL: vi.fn(() => 'https://downloads.example.com/tool.exe'),
        getURLChain: vi.fn(() => ['https://downloads.example.com/tool.exe']),
        isPaused: vi.fn(() => false),
        pause: vi.fn(),
        resume: vi.fn(),
        setSavePath: vi.fn(),
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      const finalPath = path.join(userDataPath, 'outputs', 'test-tool.exe');
      const completion = engine
        .start({
          allowedHosts: ['downloads.example.com'],
          allowedPathPrefixes: ['/tool.exe'],
          finalPath,
          id: 'tool',
          label: '测试工具',
          maxBytes: 10_000,
          url: 'https://downloads.example.com/tool.exe',
        })
        .catch(() => undefined);
      session.emit('will-download', { preventDefault: vi.fn() }, item);

      state = 'interrupted';
      item.emit('done', {}, 'interrupted');
      expect(engine.list()[0]).toMatchObject({ state: 'paused' });
      expect(engine.list()[0]?.errorMessage).toContain('自动续传');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(item.resume).toHaveBeenCalledOnce();
      expect(engine.list()[0]).toMatchObject({ errorMessage: undefined, state: 'progressing' });

      engine.cancel('tool');
      state = 'cancelled';
      item.emit('done', {}, 'cancelled');
      await completion;
      expect(engine.list()[0]?.state).toBe('cancelled');
      rmSync(userDataPath, { force: true, recursive: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a user-requested continuation immediately without losing its rebind marker', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-stall-manual-'));
    try {
      let state = 'progressing';
      const firstItem = createDownloadItem({
        canResume: vi.fn(() => false),
        getState: vi.fn(() => state),
      });
      const secondItem = createDownloadItem();
      const session = Object.assign(new EventEmitter(), {
        createInterruptedDownload: vi.fn(),
        downloadURL: vi.fn(),
      });
      session.downloadURL.mockImplementation(() => {
        if (session.downloadURL.mock.calls.length === 2) {
          session.emit('will-download', { preventDefault: vi.fn() }, secondItem);
        }
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      engine.start(createRequest(userDataPath)).catch(() => undefined);
      session.emit('will-download', { preventDefault: vi.fn() }, firstItem);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);

      state = 'interrupted';
      engine.resume('tool');
      expect(firstItem.cancel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(400);
      expect(session.downloadURL).toHaveBeenCalledTimes(2);
      expect(engine.list()[0]).toMatchObject({ state: 'progressing' });
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it('cancels a pending stall continuation when the same item reports progress first', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-stall-progress-'));
    try {
      let receivedBytes = 0;
      const session = Object.assign(new EventEmitter(), {
        createInterruptedDownload: vi.fn(),
        downloadURL: vi.fn(),
      });
      const item = createDownloadItem({
        getReceivedBytes: vi.fn(() => receivedBytes),
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      const completion = engine.start(createRequest(userDataPath)).catch(() => undefined);
      session.emit('will-download', { preventDefault: vi.fn() }, item);

      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
      expect(engine.list()[0]).toMatchObject({ state: 'paused' });
      receivedBytes = 100;
      item.emit('updated', {}, 'progressing');
      expect(engine.list()[0]).toMatchObject({ errorMessage: undefined, state: 'progressing' });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(item.resume).not.toHaveBeenCalled();
      expect(item.cancel).not.toHaveBeenCalled();
      expect(session.downloadURL).toHaveBeenCalledOnce();

      engine.cancel('tool');
      item.emit('done', {}, 'cancelled');
      await completion;
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.clearAllTimers();
      rmSync(userDataPath, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it('rearms stall detection across repeated stall and progress cycles', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-stall-cycles-'));
    try {
      let receivedBytes = 0;
      const session = Object.assign(new EventEmitter(), {
        createInterruptedDownload: vi.fn(),
        downloadURL: vi.fn(),
      });
      const item = createDownloadItem({
        getReceivedBytes: vi.fn(() => receivedBytes),
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      const completion = engine.start(createRequest(userDataPath)).catch(() => undefined);
      session.emit('will-download', { preventDefault: vi.fn() }, item);
      let untilNextStall = STALL_TIMEOUT_MS;

      // More cycles than the retry budget proves cancelled false stalls do not consume attempts.
      for (let cycle = 0; cycle < 14; cycle += 1) {
        await vi.advanceTimersByTimeAsync(untilNextStall);
        expect(engine.list()[0]).toMatchObject({ state: 'paused' });
        receivedBytes += 100;
        item.emit('updated', {}, 'progressing');
        expect(engine.list()[0]).toMatchObject({ errorMessage: undefined, state: 'progressing' });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(item.cancel).not.toHaveBeenCalled();
        expect(session.downloadURL).toHaveBeenCalledOnce();
        untilNextStall = STALL_TIMEOUT_MS - 1_000;
      }

      engine.cancel('tool');
      item.emit('done', {}, 'cancelled');
      await completion;
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it('fences a cleared old-item stall timer from a replacement item generation', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-stall-generation-'));
    try {
      let firstState = 'progressing';
      const firstItem = createDownloadItem({
        canResume: vi.fn(() => false),
        getState: vi.fn(() => firstState),
      });
      const secondItem = createDownloadItem();
      const session = Object.assign(new EventEmitter(), {
        createInterruptedDownload: vi.fn(),
        downloadURL: vi.fn(),
      });
      session.downloadURL.mockImplementation(() => {
        if (session.downloadURL.mock.calls.length === 2) {
          session.emit('will-download', { preventDefault: vi.fn() }, secondItem);
        }
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      engine.start(createRequest(userDataPath)).catch(() => undefined);
      session.emit('will-download', { preventDefault: vi.fn() }, firstItem);

      firstState = 'interrupted';
      firstItem.emit('done', {}, 'interrupted');
      await vi.advanceTimersByTimeAsync(1_400);
      expect(session.downloadURL).toHaveBeenCalledTimes(2);
      expect(engine.list()[0]).toMatchObject({ state: 'progressing' });
      const replacementMessage = engine.list()[0]?.errorMessage;

      // clearTimeout is deliberately ineffective, so the first generation's watchdog really fires.
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 1_400);
      expect(engine.list()[0]).toMatchObject({
        errorMessage: replacementMessage,
        state: 'progressing',
      });
      expect(secondItem.cancel).not.toHaveBeenCalled();
      expect(secondItem.resume).not.toHaveBeenCalled();
      firstItem.emit('updated', {}, 'progressing');
      expect(engine.list()[0]?.receivedBytes).toBe(0);
      engine.dispose();
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.clearAllTimers();
      rmSync(userDataPath, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it('makes pending retry timers and future item events inert during quit disposal', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-stall-dispose-'));
    try {
      const session = Object.assign(new EventEmitter(), {
        createInterruptedDownload: vi.fn(),
        downloadURL: vi.fn(),
      });
      const item = createDownloadItem();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      engine.start(createRequest(userDataPath)).catch(() => undefined);
      session.emit('will-download', { preventDefault: vi.fn() }, item);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
      expect(engine.list()[0]).toMatchObject({ state: 'paused' });

      engine.flushJournal();
      item.emit('updated', {}, 'progressing');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(item.cancel).toHaveBeenCalledOnce();
      expect(item.resume).not.toHaveBeenCalled();
      expect(session.downloadURL).toHaveBeenCalledOnce();
      expect(item.listenerCount('updated')).toBe(0);
      expect(item.listenerCount('done')).toBe(0);
      const preventDefault = vi.fn();
      session.emit('will-download', { preventDefault }, createDownloadItem());
      expect(preventDefault).not.toHaveBeenCalled();
      expect(() => engine.dispose()).not.toThrow();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  /*
   * Some regional download mirrors are prefix reverse proxies, so the whole GitHub URL —
   * scheme and all — ends up inside the mirror's path. `acceptItem` claims a `will-download` event
   * by exact URL string, and the engine validates every hop against `url.hostname` +
   * `url.pathname`. If Chromium normalized that empty `https://` segment differently on the way
   * out and back, the event would be claimed by nothing and silently dropped by `preventDefault`.
   */
  it('claims a prefix-proxy mirror download whose path contains a full https URL', async () => {
    const mirrorUrl =
      'https://ghproxy.net/https://github.com/example/project/releases/download/v1.2.3/Example-Tool.zip';
    expect(new URL(mirrorUrl).toString()).toBe(mirrorUrl);
    const session = new EventEmitter() as EventEmitter & { downloadURL: (url: string) => void };
    session.downloadURL = vi.fn();
    Object.assign(session, { createInterruptedDownload: vi.fn() });
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-download-'));
    const item = Object.assign(new EventEmitter(), {
      canResume: vi.fn(() => true),
      cancel: vi.fn(),
      getReceivedBytes: vi.fn(() => 0),
      getETag: vi.fn(() => '"fixture"'),
      getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
      getStartTime: vi.fn(() => Date.now() / 1000),
      getTotalBytes: vi.fn(() => 20_913_304),
      getURL: vi.fn(() => mirrorUrl),
      // The mirror answers with a 302 back to the origin, so both hops must pass the whitelist.
      getURLChain: vi.fn(() => [
        mirrorUrl,
        'https://github.com/example/project/releases/download/v1.2.3/Example-Tool.zip',
      ]),
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
      resume: vi.fn(),
      setSavePath: vi.fn(),
    });
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      new BusyRegistry(),
      userDataPath,
    );
    const finalPath = path.join(userDataPath, 'downloads', 'Example-Tool.zip');
    const preventDefault = vi.fn();
    const completion = engine
      .start({
        allowedHosts: ['ghproxy.net', 'github.com', 'release-assets.githubusercontent.com'],
        allowedPathPrefixes: [
          '/https://github.com/example/project/releases/download/v1.2.3/',
          '/example/project/releases/download/v1.2.3/',
          '/',
        ],
        finalPath,
        id: 'release-fixture',
        label: 'Release fixture',
        maxBytes: 64 * 1024 * 1024,
        url: mirrorUrl,
      })
      .catch(() => undefined);
    session.emit('will-download', { preventDefault }, item);

    expect(session.downloadURL).toHaveBeenCalledWith(mirrorUrl);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalledWith(`${finalPath}.partial`);
    expect(engine.list()[0]).toMatchObject({ id: 'release-fixture', state: 'progressing' });

    engine.cancel('release-fixture');
    item.emit('done', {}, 'cancelled');
    await completion;
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('claims a GitHub download when Electron reports the redirected release asset URL', async () => {
    const originalUrl =
      'https://github.com/example/project/releases/download/v1.2.3/Example-Tool.zip';
    const finalUrl =
      'https://release-assets.githubusercontent.com/github-production-release-asset/example/tool.zip?token=short-lived';
    const session = new EventEmitter() as EventEmitter & { downloadURL: (url: string) => void };
    session.downloadURL = vi.fn();
    Object.assign(session, { createInterruptedDownload: vi.fn() });
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-download-'));
    const item = Object.assign(new EventEmitter(), {
      canResume: vi.fn(() => true),
      cancel: vi.fn(),
      getReceivedBytes: vi.fn(() => 0),
      getETag: vi.fn(() => '"fixture"'),
      getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
      getStartTime: vi.fn(() => Date.now() / 1000),
      getTotalBytes: vi.fn(() => 20_913_304),
      getURL: vi.fn(() => finalUrl),
      getURLChain: vi.fn(() => [originalUrl, finalUrl]),
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
      resume: vi.fn(),
      setSavePath: vi.fn(),
    });
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      new BusyRegistry(),
      userDataPath,
    );
    const finalPath = path.join(userDataPath, 'downloads', 'Example-Tool.zip');
    const preventDefault = vi.fn();
    const completion = engine
      .start({
        allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
        allowedPathPrefixes: ['/example/project/releases/download/v1.2.3/', '/'],
        finalPath,
        id: 'redirected-release-fixture',
        label: 'Redirected release fixture',
        maxBytes: 64 * 1024 * 1024,
        url: originalUrl,
      })
      .catch(() => undefined);
    session.emit('will-download', { preventDefault }, item);

    expect(session.downloadURL).toHaveBeenCalledWith(originalUrl);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalledWith(`${finalPath}.partial`);
    expect(engine.list()[0]).toMatchObject({ state: 'progressing' });

    engine.cancel('redirected-release-fixture');
    item.emit('done', {}, 'cancelled');
    await completion;
    rmSync(userDataPath, { force: true, recursive: true });
  });
});
