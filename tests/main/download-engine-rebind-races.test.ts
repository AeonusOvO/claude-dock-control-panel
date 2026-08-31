import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { DownloadEngine, type DownloadSession } from '../../src/main/download/engine';
import {
  promoteRecoverySnapshot,
  snapshotPartialForRecovery,
} from '../../src/main/download/engine-state';
import { DownloadJournal, type DownloadJournalEntry } from '../../src/main/download/journal';

const DOWNLOAD_URL = 'https://downloads.example.com/tool.exe';
const STALL_TIMEOUT_MS = 45_000;
const REBIND_SETTLE_MS = 400;

const createSession = (overrides: Record<string, unknown> = {}) =>
  Object.assign(
    new EventEmitter(),
    {
      createInterruptedDownload: vi.fn(),
      downloadURL: vi.fn(),
    },
    overrides,
  );

const createItem = (overrides: Record<string, unknown> = {}) =>
  Object.assign(
    new EventEmitter(),
    {
      canResume: vi.fn(() => true),
      cancel: vi.fn(),
      getETag: vi.fn(() => '"fixture"'),
      getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
      getReceivedBytes: vi.fn(() => 0),
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

const createRequest = (userDataPath: string) => ({
  allowedHosts: ['downloads.example.com'],
  allowedPathPrefixes: ['/tool.exe'],
  finalPath: path.join(userDataPath, 'downloads', 'tool.exe'),
  id: 'tool',
  label: '重绑定竞态测试下载',
  maxBytes: 10_000,
  url: DOWNLOAD_URL,
});

const writeRecoveryFixture = (userDataPath: string): DownloadJournalEntry => {
  const finalPath = path.join(userDataPath, 'downloads', 'recovered.exe');
  const savePath = `${finalPath}.partial`;
  mkdirSync(path.dirname(savePath), { recursive: true });
  writeFileSync(savePath, Buffer.alloc(100));
  const entry: DownloadJournalEntry = {
    allowedHosts: ['downloads.example.com'],
    allowedPathPrefixes: ['/tool.exe'],
    eTag: '"fixture"',
    finalPath,
    id: 'recovered-tool',
    label: '恢复竞态测试下载',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    length: 1_000,
    maxBytes: 10_000,
    receivedBytes: 100,
    savePath,
    startTime: 1_700_000_000,
    urlChain: [DOWNLOAD_URL],
  };
  new DownloadJournal(userDataPath).upsert(entry);
  return entry;
};

const readJournal = (userDataPath: string): DownloadJournalEntry[] =>
  JSON.parse(
    readFileSync(path.join(userDataPath, 'download-journal.json'), 'utf8'),
  ) as DownloadJournalEntry[];

const startAutomaticRebind = async (
  userDataPath: string,
  session: ReturnType<typeof createSession>,
): Promise<{
  completion: Promise<unknown>;
  engine: DownloadEngine;
  request: ReturnType<typeof createRequest>;
}> => {
  let state = 'progressing';
  const item = createItem({
    canResume: vi.fn(() => false),
    getReceivedBytes: vi.fn(() => 100),
    getState: vi.fn(() => state),
  });
  const engine = new DownloadEngine(
    session as unknown as DownloadSession,
    new BusyRegistry(),
    userDataPath,
  );
  const request = createRequest(userDataPath);
  const completion = engine.start(request);
  session.emit('will-download', { preventDefault: vi.fn() }, item);
  writeFileSync(`${request.finalPath}.partial`, Buffer.alloc(100));
  await vi.advanceTimersByTimeAsync(1_001);
  item.emit('updated', {}, 'progressing');
  state = 'interrupted';
  item.emit('done', {}, 'interrupted');
  await vi.advanceTimersByTimeAsync(1_000 + REBIND_SETTLE_MS);
  return { completion, engine, request };
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('download rebind ownership races', () => {
  it('retains a sufficient snapshot and journal when startup promotion is transiently blocked', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-promotion-lock-'));
    try {
      const entry = writeRecoveryFixture(userDataPath);
      writeFileSync(`${entry.savePath}.resume`, Buffer.alloc(100));
      unlinkSync(entry.savePath);
      mkdirSync(entry.savePath);
      const session = createSession();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );

      await engine.restoreInterrupted();

      expect(session.createInterruptedDownload).not.toHaveBeenCalled();
      expect(engine.list()).toEqual([]);
      expect(statSync(`${entry.savePath}.resume`).size).toBe(100);
      expect(readJournal(userDataPath)).toEqual([
        expect.objectContaining({ id: entry.id, receivedBytes: 100 }),
      ]);
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('does not discard a snapshot when an existing partial has the wrong prefix', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-promotion-identity-'));
    try {
      const entry = writeRecoveryFixture(userDataPath);
      writeFileSync(entry.savePath, Buffer.alloc(100, 2));
      writeFileSync(`${entry.savePath}.resume`, Buffer.alloc(100, 1));

      await expect(promoteRecoverySnapshot(userDataPath, entry)).resolves.toBe('ready');
      expect(readFileSync(entry.savePath)).toEqual(Buffer.alloc(100, 1));
      expect(existsSync(`${entry.savePath}.resume`)).toBe(false);
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('keeps recovery consent pending when the native item rejects resume', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-recovery-resume-failure-'));
    try {
      const entry = writeRecoveryFixture(userDataPath);
      const item = createItem({ getReceivedBytes: vi.fn(() => 100) });
      const session = createSession();
      session.createInterruptedDownload.mockImplementation(() => {
        session.emit('will-download', { preventDefault: vi.fn() }, item);
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );

      await engine.restoreInterrupted();
      item.canResume.mockImplementation(() => {
        throw new Error('native resume failed');
      });
      expect(engine.listRecoveryPending()).toEqual([
        expect.objectContaining({ id: entry.id, recoveryPending: true }),
      ]);

      expect(() => engine.resumeRecovery(entry.id)).toThrow('native resume failed');
      expect(engine.listRecoveryPending()).toEqual([
        expect.objectContaining({ id: entry.id, recoveryPending: true }),
      ]);
      expect(item.resume).not.toHaveBeenCalled();
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('keeps a delayed startup recovery task after native resume throws', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-recovery-delayed-resume-failure-'),
    );
    try {
      const entry = writeRecoveryFixture(userDataPath);
      const item = createItem({ getReceivedBytes: vi.fn(() => entry.receivedBytes) });
      item.resume.mockImplementationOnce(() => {
        throw new Error('delayed native resume failed');
      });
      let rejectCreation!: (error: Error) => void;
      const creation = new Promise<void>((_resolve, reject) => {
        rejectCreation = reject;
      });
      const session = createSession();
      session.createInterruptedDownload.mockReturnValue(creation);
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );

      const completion = engine.restoreInterrupted();
      await completion;
      engine.resumeRecovery(entry.id);
      const preventDefault = vi.fn();
      session.emit('will-download', { preventDefault }, item);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(item.pause).toHaveBeenCalledOnce();
      expect(item.cancel).not.toHaveBeenCalled();
      expect(engine.listRecoveryPending()).toEqual([
        expect.objectContaining({ id: entry.id, recoveryPending: true }),
      ]);

      rejectCreation(new Error('late create rejection'));
      await Promise.resolve();
      expect(engine.listRecoveryPending()).toEqual([
        expect.objectContaining({ id: entry.id, recoveryPending: true }),
      ]);

      engine.resumeRecovery(entry.id);
      expect(item.resume).toHaveBeenCalledTimes(2);
      expect(engine.listRecoveryPending()).toEqual([]);
      engine.cancel(entry.id);
      expect(engine.list()[0]).toMatchObject({ id: entry.id, state: 'cancelled' });
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('clears recovery consent after a late native item resumes successfully', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-recovery-late-success-'));
    try {
      const entry = writeRecoveryFixture(userDataPath);
      const item = createItem({ getReceivedBytes: vi.fn(() => 100) });
      const session = createSession();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );

      await engine.restoreInterrupted();
      engine.resumeRecovery(entry.id);
      expect(engine.listRecoveryPending()).toEqual([]);

      session.emit('will-download', { preventDefault: vi.fn() }, item);

      expect(item.resume).toHaveBeenCalledOnce();
      expect(engine.listRecoveryPending()).toEqual([]);
      expect(engine.list()[0]).toMatchObject({ id: entry.id, recoveryPending: false });
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('routes a consented late native item that cannot resume through retry', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-recovery-late-failure-'));
    try {
      const entry = writeRecoveryFixture(userDataPath);
      const item = createItem({
        canResume: vi.fn(() => false),
        getReceivedBytes: vi.fn(() => 100),
      });
      const session = createSession();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );

      await engine.restoreInterrupted();
      expect(engine.listRecoveryPending()).toEqual([
        expect.objectContaining({ id: entry.id, recoveryPending: true }),
      ]);
      engine.resumeRecovery(entry.id);
      expect(engine.listRecoveryPending()).toEqual([]);

      session.emit('will-download', { preventDefault: vi.fn() }, item);

      expect(engine.listRecoveryPending()).toEqual([]);
      expect(item.resume).not.toHaveBeenCalled();
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('settles disposal even when the BusyRegistry release observer throws', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-busy-release-'));
    try {
      const session = createSession();
      const item = createItem();
      const busyRegistry = new BusyRegistry((leases) => {
        if (leases.length === 0) throw new Error('busy release listener failed');
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );
      const completion = engine.start(createRequest(userDataPath));
      session.emit('will-download', { preventDefault: vi.fn() }, item);

      expect(() => engine.dispose()).not.toThrow();
      await expect(completion).rejects.toThrow('下载引擎已经关闭');
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(busyRegistry.list()).toEqual([]);
      expect(engine.list()).toEqual([]);
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('cancels a reentrantly bound item when downloadURL throws', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-launch-throw-'));
    try {
      const item = createItem();
      const session = createSession();
      session.downloadURL.mockImplementation(() => {
        session.emit('will-download', { preventDefault: vi.fn() }, item);
        throw new Error('downloadURL failed after bind');
      });
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );

      await expect(engine.start(createRequest(userDataPath))).rejects.toThrow(
        'downloadURL failed after bind',
      );
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(item.listenerCount('updated')).toBe(0);
      expect(item.listenerCount('done')).toBe(0);
      expect(busyRegistry.list()).toEqual([]);
      expect(existsSync(path.join(userDataPath, 'download-journal.json'))).toBe(true);
      expect(readJournal(userDataPath)).toEqual([]);
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('rolls back a startup restore whose item cannot be claimed', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-startup-claim-'));
    try {
      const entry = writeRecoveryFixture(userDataPath);
      const item = createItem({
        getURLChain: vi.fn(() => {
          throw new Error('native URL chain unavailable');
        }),
      });
      const preventDefault = vi.fn();
      const session = createSession();
      session.createInterruptedDownload.mockImplementation(() => {
        session.emit('will-download', { preventDefault }, item);
      });
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );

      await engine.restoreInterrupted();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(busyRegistry.list()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);

      expect(engine.list()).toEqual([]);
      expect(busyRegistry.list()).toEqual([]);
      expect(readJournal(userDataPath)).toEqual([
        expect.objectContaining({ id: entry.id, receivedBytes: 100 }),
      ]);
      expect(existsSync(entry.savePath)).toBe(true);
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it.each(['synchronous', 'asynchronous'] as const)(
    'rolls back an automatically rebound item after %s creation failure',
    async (mode) => {
      vi.useFakeTimers();
      const userDataPath = mkdtempSync(path.join(tmpdir(), `claudedock-rebind-${mode}-`));
      try {
        const reboundItem = createItem({ getReceivedBytes: vi.fn(() => 100) });
        const session = createSession();
        let rejectCreation: ((error: Error) => void) | undefined;
        session.createInterruptedDownload.mockImplementation(() => {
          session.emit('will-download', { preventDefault: vi.fn() }, reboundItem);
          if (mode === 'synchronous') throw new Error('sync creation failure');
          return new Promise<void>((_resolve, reject) => {
            rejectCreation = reject;
          });
        });
        const { completion, engine, request } = await startAutomaticRebind(userDataPath, session);
        if (mode === 'asynchronous') {
          rejectCreation!(new Error('async creation failure'));
          await Promise.resolve();
        }

        expect(reboundItem.cancel).toHaveBeenCalledOnce();
        expect(reboundItem.listenerCount('done')).toBe(0);
        await vi.advanceTimersByTimeAsync(REBIND_SETTLE_MS);
        expect(session.downloadURL).toHaveBeenCalledTimes(2);
        expect(statSync(`${request.finalPath}.partial.resume`).size).toBe(100);
        expect(readJournal(userDataPath)).toEqual([
          expect.objectContaining({ id: request.id, receivedBytes: 100 }),
        ]);

        engine.cancel(request.id);
        await expect(completion).rejects.toThrow('下载已取消');
      } finally {
        rmSync(userDataPath, { force: true, recursive: true });
      }
    },
  );

  it('does not overwrite a valid snapshot when promotion is blocked during automatic rebind', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-rebind-lock-'));
    try {
      const session = createSession();
      const firstItem = createItem({
        canResume: vi.fn(() => false),
        getReceivedBytes: vi.fn(() => 100),
        getState: vi.fn(() => 'interrupted'),
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      const request = createRequest(userDataPath);
      const completion = engine.start(request);
      session.emit('will-download', { preventDefault: vi.fn() }, firstItem);
      writeFileSync(`${request.finalPath}.partial`, Buffer.alloc(100));
      await vi.advanceTimersByTimeAsync(1_001);
      firstItem.emit('updated', {}, 'progressing');
      firstItem.emit('done', {}, 'interrupted');
      await vi.advanceTimersByTimeAsync(1_000);

      unlinkSync(`${request.finalPath}.partial`);
      mkdirSync(`${request.finalPath}.partial`);
      await vi.advanceTimersByTimeAsync(REBIND_SETTLE_MS);

      expect(session.createInterruptedDownload).not.toHaveBeenCalled();
      expect(session.downloadURL).toHaveBeenCalledTimes(2);
      expect(statSync(`${request.finalPath}.partial.resume`).size).toBe(100);
      expect(readJournal(userDataPath)).toEqual([
        expect.objectContaining({ id: request.id, receivedBytes: 100 }),
      ]);
      engine.cancel(request.id);
      await expect(completion).rejects.toThrow('下载已取消');
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('replaces snapshots through a temporary file without truncating the prior recovery copy', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-snapshot-atomic-'));
    try {
      const request = createRequest(userDataPath);
      const partialPath = `${request.finalPath}.partial`;
      const snapshotPath = `${partialPath}.resume`;
      mkdirSync(path.dirname(partialPath), { recursive: true });
      writeFileSync(partialPath, Buffer.alloc(200, 2));
      writeFileSync(snapshotPath, Buffer.alloc(100, 1));
      mkdirSync(`${snapshotPath}.tmp`);

      expect(snapshotPartialForRecovery(request, false)).toBe(100);
      expect(readFileSync(snapshotPath)).toEqual(Buffer.alloc(100, 1));
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('does not arm a terminal watchdog when resume completes reentrantly', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-resume-complete-'));
    try {
      const reboundItem = createItem({
        getReceivedBytes: vi.fn(() => 100),
        getTotalBytes: vi.fn(() => 100),
      });
      reboundItem.resume.mockImplementation(() => {
        reboundItem.emit('done', {}, 'completed');
      });
      const session = createSession();
      session.createInterruptedDownload.mockImplementation(() => {
        session.emit('will-download', { preventDefault: vi.fn() }, reboundItem);
      });

      const { completion, engine, request } = await startAutomaticRebind(userDataPath, session);

      await expect(completion).resolves.toEqual({
        filePath: request.finalPath,
        id: request.id,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(engine.list()[0]).toMatchObject({ state: 'completed' });
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('restores immutable pre-create metadata after a deferred rebound rejection', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-rebind-metadata-'));
    try {
      const reboundItem = createItem({ getReceivedBytes: vi.fn(() => 150) });
      let rejectCreation!: (error: Error) => void;
      const creation = new Promise<void>((_resolve, reject) => {
        rejectCreation = reject;
      });
      const session = createSession();
      session.createInterruptedDownload.mockImplementation(() => {
        session.emit('will-download', { preventDefault: vi.fn() }, reboundItem);
        return creation;
      });
      const { completion, engine, request } = await startAutomaticRebind(userDataPath, session);
      expect(readJournal(userDataPath)).toEqual([expect.objectContaining({ receivedBytes: 150 })]);

      rejectCreation(new Error('creation rejected after persistence'));
      await Promise.resolve();

      expect(reboundItem.cancel).toHaveBeenCalledOnce();
      expect(statSync(`${request.finalPath}.partial.resume`).size).toBe(100);
      expect(readJournal(userDataPath)).toEqual([expect.objectContaining({ receivedBytes: 100 })]);
      await vi.advanceTimersByTimeAsync(REBIND_SETTLE_MS);
      engine.cancel(request.id);
      await expect(completion).rejects.toThrow('下载已取消');
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('ignores a late startup creation rejection after the item completed', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-startup-late-reject-'));
    try {
      const entry = writeRecoveryFixture(userDataPath);
      const item = createItem({
        getReceivedBytes: vi.fn(() => 100),
        getTotalBytes: vi.fn(() => 100),
      });
      let rejectCreation!: (error: Error) => void;
      const creation = new Promise<void>((_resolve, reject) => {
        rejectCreation = reject;
      });
      const session = createSession();
      session.createInterruptedDownload.mockImplementation(() => {
        session.emit('will-download', { preventDefault: vi.fn() }, item);
        return creation;
      });
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );
      await engine.restoreInterrupted();
      item.emit('done', {}, 'completed');
      await vi.waitFor(() => expect(engine.list()[0]).toMatchObject({ state: 'completed' }));

      rejectCreation(new Error('late startup creation rejection'));
      await Promise.resolve();

      expect(engine.list()[0]).toMatchObject({ id: entry.id, state: 'completed' });
      expect(busyRegistry.list()).toEqual([]);
      expect(readJournal(userDataPath)).toEqual([]);
      expect(existsSync(entry.finalPath)).toBe(true);
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('finishes safety cleanup even when native cancellation throws', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-safety-cancel-'));
    try {
      const session = createSession();
      const item = createItem({
        cancel: vi.fn(() => {
          throw new Error('native cancel failed');
        }),
        getTotalBytes: vi.fn(() => 20_000),
      });
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );
      const request = createRequest(userDataPath);
      const completion = engine.start(request);

      expect(() => session.emit('will-download', { preventDefault: vi.fn() }, item)).not.toThrow();
      await expect(completion).rejects.toThrow('下载内容超过安全上限');
      expect(item.cancel).toHaveBeenCalled();
      expect(engine.list()[0]).toMatchObject({ state: 'failed' });
      expect(busyRegistry.list()).toEqual([]);
      expect(existsSync(`${request.finalPath}.partial`)).toBe(false);
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });
});
