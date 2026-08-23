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
import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { DownloadEngine, type DownloadSession } from '../../src/main/download/engine';

const DOWNLOAD_URL = 'https://downloads.example.com/tool.exe';
const GITHUB_URL = 'https://github.com/example/project/releases/download/v1.0.0/tool.exe';
const STALL_TIMEOUT_MS = 45_000;

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

const createRequest = (userDataPath: string, id = 'tool') => ({
  allowedHosts: ['downloads.example.com'],
  allowedPathPrefixes: ['/tool.exe'],
  finalPath: path.join(userDataPath, 'downloads', `${id}.exe`),
  id,
  label: '生命周期测试下载',
  maxBytes: 10_000,
  url: DOWNLOAD_URL,
});

const createGitHubRequest = (userDataPath: string) => ({
  allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
  allowedPathPrefixes: ['/example/project/releases/download/v1.0.0/', '/'],
  finalPath: path.join(userDataPath, 'downloads', 'github-tool.exe'),
  id: 'github-tool',
  label: 'GitHub 生命周期测试下载',
  maxBytes: 10_000,
  url: GITHUB_URL,
});

interface RecoveryEntry {
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  eTag?: string;
  finalPath: string;
  id: string;
  label: string;
  lastModified?: string;
  length: number;
  maxBytes: number;
  receivedBytes: number;
  savePath: string;
  startTime: number;
  urlChain: string[];
}

const writeRecoveryFixture = (userDataPath: string, id = 'recovered-tool'): RecoveryEntry => {
  const finalPath = path.join(userDataPath, 'downloads', `${id}.exe`);
  const savePath = `${finalPath}.partial`;
  mkdirSync(path.dirname(savePath), { recursive: true });
  writeFileSync(savePath, Buffer.alloc(100));
  const entry: RecoveryEntry = {
    allowedHosts: ['downloads.example.com'],
    allowedPathPrefixes: ['/tool.exe'],
    eTag: '"fixture"',
    finalPath,
    id,
    label: '恢复生命周期测试下载',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    length: 1_000,
    maxBytes: 10_000,
    receivedBytes: 100,
    savePath,
    startTime: 1_700_000_000,
    urlChain: [DOWNLOAD_URL],
  };
  writeFileSync(path.join(userDataPath, 'download-journal.json'), JSON.stringify([entry]));
  return entry;
};

const readJournal = (userDataPath: string): RecoveryEntry[] =>
  JSON.parse(
    readFileSync(path.join(userDataPath, 'download-journal.json'), 'utf8'),
  ) as RecoveryEntry[];

const responseWithSample = (): Response => new Response(new Uint8Array([1, 2, 3]), { status: 206 });

describe('download engine disposal and race fencing', () => {
  it('disposes every owner while preserving a startup-recoverable partial', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-dispose-owned-'));
    try {
      const session = createSession();
      const item = createItem({ getReceivedBytes: vi.fn(() => 100) });
      const busyRegistry = new BusyRegistry();
      const listener = vi.fn();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
        listener,
      );
      const request = createRequest(userDataPath);
      const completion = engine.start(request);
      session.emit('will-download', { preventDefault: vi.fn() }, item);
      writeFileSync(`${request.finalPath}.partial`, Buffer.alloc(100));
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
      expect(engine.list()[0]).toMatchObject({ state: 'paused' });

      engine.dispose();

      await expect(completion).rejects.toThrow('下载引擎已经关闭');
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(item.listenerCount('updated')).toBe(0);
      expect(item.listenerCount('done')).toBe(0);
      expect(session.listenerCount('will-download')).toBe(0);
      expect(busyRegistry.list()).toEqual([]);
      expect(engine.list()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(existsSync(`${request.finalPath}.partial.resume`)).toBe(true);
      expect(readJournal(userDataPath)).toEqual([
        expect.objectContaining({ id: request.id, receivedBytes: 100 }),
      ]);

      const preventDefault = vi.fn();
      session.emit('will-download', { preventDefault }, createItem());
      item.emit('updated', {}, 'progressing');
      item.emit('done', {}, 'interrupted');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(session.downloadURL).toHaveBeenCalledOnce();
      const callsAfterDispose = listener.mock.calls.length;
      engine.onChange(listener);
      expect(listener).toHaveBeenCalledTimes(callsAfterDispose);
      for (const mutation of [
        () => engine.cancel(request.id),
        () => engine.pause(request.id),
        () => engine.resume(request.id),
        () => engine.clearHistory(),
        () => engine.deleteHistory(request.id),
      ]) {
        expect(mutation).toThrow('下载引擎已经关闭');
      }

      // Electron cancellation may delete `.partial` after dispose. The durable sibling snapshot is
      // promoted before journal validation on the next engine instance.
      try {
        unlinkSync(`${request.finalPath}.partial`);
      } catch {
        // The fixture models either synchronous or asynchronous Chromium deletion.
      }
      const recoverySession = createSession();
      const recoveryEngine = new DownloadEngine(
        recoverySession as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      recoveryEngine.restoreInterrupted();
      expect(recoverySession.createInterruptedDownload).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 100, path: `${request.finalPath}.partial` }),
      );
      recoveryEngine.dispose();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('keeps a failed journal flush retryable before latching disposal', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-dispose-retry-'));
    try {
      const session = createSession();
      const item = createItem();
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );
      const completion = engine.start(createRequest(userDataPath));
      session.emit('will-download', { preventDefault: vi.fn() }, item);
      const temporaryPath = path.join(userDataPath, 'download-journal.json.tmp');
      mkdirSync(temporaryPath, { recursive: true });

      expect(() => engine.dispose()).toThrow();
      expect(item.cancel).not.toHaveBeenCalled();
      expect(item.listenerCount('done')).toBe(1);
      expect(session.listenerCount('will-download')).toBe(1);
      expect(busyRegistry.list()).not.toEqual([]);
      expect(() => engine.pause('tool')).not.toThrow();

      rmSync(temporaryPath, { force: true, recursive: true });
      engine.dispose();
      await expect(completion).rejects.toThrow('下载引擎已经关闭');
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(busyRegistry.list()).toEqual([]);
      expect(session.listenerCount('will-download')).toBe(0);
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('fences verification publication after dispose and exact-generation cancellation', async () => {
    for (const mode of ['cancel', 'dispose'] as const) {
      const userDataPath = mkdtempSync(path.join(tmpdir(), `claudedock-verify-${mode}-`));
      try {
        const session = createSession();
        const item = createItem({
          getReceivedBytes: vi.fn(() => 4),
          getTotalBytes: vi.fn(() => 4),
        });
        const engine = new DownloadEngine(
          session as unknown as DownloadSession,
          new BusyRegistry(),
          userDataPath,
        );
        const request = createRequest(userDataPath, `verify-${mode}`);
        const completion = engine.start(request);
        session.emit('will-download', { preventDefault: vi.fn() }, item);
        writeFileSync(`${request.finalPath}.partial`, 'data');
        item.emit('done', {}, 'completed');

        if (mode === 'cancel') engine.cancel(request.id);
        else engine.dispose();

        await expect(completion).rejects.toThrow(
          mode === 'cancel' ? '下载已取消' : '下载引擎已经关闭',
        );
        await Promise.resolve();
        expect(existsSync(request.finalPath)).toBe(false);
      } finally {
        rmSync(userDataPath, { force: true, recursive: true });
      }
    }
  });

  it('rejects GitHub starts disposed during sampling or launch notification', async () => {
    const firstPath = mkdtempSync(path.join(tmpdir(), 'claudedock-github-sample-'));
    try {
      let resolveFetch!: (response: Response) => void;
      const session = createSession({
        fetch: vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        ),
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        firstPath,
      );
      const completion = engine.start(createGitHubRequest(firstPath));
      engine.dispose();
      resolveFetch(responseWithSample());

      await expect(completion).rejects.toThrow('下载引擎已经关闭');
      expect(session.downloadURL).not.toHaveBeenCalled();
      expect(engine.list()).toEqual([]);
    } finally {
      rmSync(firstPath, { force: true, recursive: true });
    }

    const secondPath = mkdtempSync(path.join(tmpdir(), 'claudedock-github-notify-'));
    try {
      const session = createSession({ fetch: vi.fn(async () => responseWithSample()) });
      const busyRegistry = new BusyRegistry();
      const engineRef: { current?: DownloadEngine } = {};
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        secondPath,
        (tasks) => {
          if (tasks.some(({ state }) => state === 'queued')) engineRef.current?.dispose();
        },
      );
      engineRef.current = engine;

      await expect(engine.start(createGitHubRequest(secondPath))).rejects.toThrow(
        '下载引擎已经关闭',
      );
      expect(session.downloadURL).not.toHaveBeenCalled();
      expect(engine.list()).toEqual([]);
      expect(busyRegistry.list()).toEqual([]);
    } finally {
      rmSync(secondPath, { force: true, recursive: true });
    }
  });

  it('does not assign an auto-resume timer after notification disposes reentrantly', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-retry-notify-'));
    try {
      const session = createSession();
      const item = createItem();
      const engineRef: { current?: DownloadEngine } = {};
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
        (tasks) => {
          if (tasks.some(({ errorMessage }) => errorMessage?.includes('自动续传'))) {
            engineRef.current?.dispose();
          }
        },
      );
      engineRef.current = engine;
      const completion = engine.start(createRequest(userDataPath));
      const settled = expect(completion).rejects.toThrow('下载引擎已经关闭');
      session.emit('will-download', { preventDefault: vi.fn() }, item);

      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
      await settled;
      expect(vi.getTimerCount()).toBe(0);
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(session.downloadURL).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('isolates throwing observers so retry timers and completion ownership remain live', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-observer-throw-'));
    try {
      const session = createSession();
      const item = createItem({ getState: vi.fn(() => 'interrupted') });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
        () => {
          throw new Error('renderer notification failed');
        },
      );
      const completion = engine.start(createRequest(userDataPath));
      expect(session.downloadURL).toHaveBeenCalledOnce();
      session.emit('will-download', { preventDefault: vi.fn() }, item);

      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1_000);
      expect(item.resume).toHaveBeenCalledOnce();
      expect(engine.list()[0]).toMatchObject({ state: 'progressing' });

      engine.cancel('tool');
      await expect(completion).rejects.toThrow('下载已取消');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('requires byte growth before noisy progressing events reset stall or retry state', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-byte-growth-'));
    try {
      const session = createSession();
      const item = createItem({ getState: vi.fn(() => 'interrupted') });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      const completion = engine.start(createRequest(userDataPath));
      session.emit('will-download', { preventDefault: vi.fn() }, item);

      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 5_000);
      item.emit('updated', {}, 'progressing');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(engine.list()[0]).toMatchObject({ state: 'paused' });

      item.emit('updated', {}, 'progressing');
      expect(engine.list()[0]).toMatchObject({ state: 'paused' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(item.resume).toHaveBeenCalledOnce();
      expect(engine.list()[0]).toMatchObject({ state: 'progressing' });

      engine.cancel('tool');
      await expect(completion).rejects.toThrow('下载已取消');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('recovers when native auto-resume state or resume calls throw', async () => {
    vi.useFakeTimers();
    try {
      for (const operation of ['getState', 'canResume', 'resume'] as const) {
        const userDataPath = mkdtempSync(path.join(tmpdir(), `claudedock-native-${operation}-`));
        try {
          let throwNative = false;
          const item = createItem({
            canResume: vi.fn(() => {
              if (throwNative && operation === 'canResume') throw new Error('canResume failed');
              return true;
            }),
            getState: vi.fn(() => {
              if (throwNative && operation === 'getState') throw new Error('getState failed');
              return 'interrupted';
            }),
            resume: vi.fn(() => {
              if (throwNative && operation === 'resume') throw new Error('resume failed');
            }),
          });
          const session = createSession();
          const engine = new DownloadEngine(
            session as unknown as DownloadSession,
            new BusyRegistry(),
            userDataPath,
          );
          const completion = engine.start(createRequest(userDataPath));
          session.emit('will-download', { preventDefault: vi.fn() }, item);
          throwNative = true;

          await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1_000 + 400);
          expect(item.cancel).toHaveBeenCalledOnce();
          expect(session.downloadURL).toHaveBeenCalledTimes(2);

          engine.cancel('tool');
          await expect(completion).rejects.toThrow('下载已取消');
        } finally {
          vi.clearAllTimers();
          rmSync(userDataPath, { force: true, recursive: true });
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('generation-binds retry ownership so two late items cannot replace each other', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-late-items-'));
    try {
      const session = createSession();
      const firstItem = createItem();
      const secondItem = createItem();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      const completion = engine.start(createRequest(userDataPath));

      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1_000 + 400);
      expect(session.downloadURL).toHaveBeenCalledTimes(2);
      const firstPreventDefault = vi.fn();
      const secondPreventDefault = vi.fn();
      session.emit('will-download', { preventDefault: firstPreventDefault }, firstItem);
      session.emit('will-download', { preventDefault: secondPreventDefault }, secondItem);

      expect(firstPreventDefault).not.toHaveBeenCalled();
      expect(firstItem.setSavePath).toHaveBeenCalledOnce();
      expect(secondPreventDefault).toHaveBeenCalledOnce();
      expect(secondItem.setSavePath).not.toHaveBeenCalled();
      engine.pause('tool');
      expect(firstItem.pause).toHaveBeenCalledOnce();

      engine.cancel('tool');
      await expect(completion).rejects.toThrow('下载已取消');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('cancels and detaches the live item before retry exhaustion fails', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-retry-exhausted-'));
    try {
      const session = createSession();
      const item = createItem({
        getReceivedBytes: vi.fn(() => 100),
        getState: vi.fn(() => 'interrupted'),
      });
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );
      const request = createRequest(userDataPath);
      const completion = engine.start(request);
      session.emit('will-download', { preventDefault: vi.fn() }, item);
      writeFileSync(`${request.finalPath}.partial`, Buffer.alloc(100));

      for (let attempt = 0; attempt < 12; attempt += 1) {
        item.emit('done', {}, 'interrupted');
        const delay = Math.min(15_000, 1_000 * 2 ** attempt);
        await vi.advanceTimersByTimeAsync(delay);
      }
      item.emit('done', {}, 'interrupted');

      await expect(completion).rejects.toThrow('已自动续传 12 次仍未完成');
      expect(item.resume).toHaveBeenCalledTimes(12);
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(item.listenerCount('updated')).toBe(0);
      expect(item.listenerCount('done')).toBe(0);
      expect(busyRegistry.list()).toEqual([]);
      expect(readJournal(userDataPath)).toEqual([expect.objectContaining({ id: request.id })]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('clears delayed restore retry state so the rebound item still gets a watchdog', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-delayed-bind-'));
    try {
      let firstState = 'progressing';
      const firstItem = createItem({
        canResume: vi.fn(() => false),
        getReceivedBytes: vi.fn(() => 100),
        getState: vi.fn(() => firstState),
      });
      const secondItem = createItem({
        getReceivedBytes: vi.fn(() => 100),
        getState: vi.fn(() => 'interrupted'),
      });
      const session = createSession();
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
      firstState = 'interrupted';
      firstItem.emit('done', {}, 'interrupted');

      await vi.advanceTimersByTimeAsync(1_400);
      expect(session.createInterruptedDownload).toHaveBeenCalledOnce();
      // Let the unbound restore itself stall and enter backoff before its delayed item arrives.
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
      expect(engine.list()[0]?.errorMessage).toContain('自动续传');
      session.emit('will-download', { preventDefault: vi.fn() }, secondItem);
      expect(secondItem.resume).toHaveBeenCalledOnce();

      // clearTimeout is ineffective, so the stale unbound-generation callback really runs. It must
      // not clear the rebound item's watchdog or leave pendingAutoResume stuck.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(secondItem.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 2_000);
      expect(engine.list()[0]?.errorMessage).toContain('自动续传');

      engine.cancel('tool');
      await expect(completion).rejects.toThrow('下载已取消');
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('preserves recovery when a rebound item throws from setSavePath', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-rebind-savepath-'));
    try {
      let firstState = 'progressing';
      const firstItem = createItem({
        canResume: vi.fn(() => false),
        getReceivedBytes: vi.fn(() => 100),
        getState: vi.fn(() => firstState),
      });
      const reboundItem = createItem({
        getReceivedBytes: vi.fn(() => 100),
        setSavePath: vi.fn(() => {
          throw new Error('rebound setSavePath failed');
        }),
      });
      const session = createSession();
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
      firstState = 'interrupted';
      firstItem.emit('done', {}, 'interrupted');
      await vi.advanceTimersByTimeAsync(1_400);

      expect(() =>
        session.emit('will-download', { preventDefault: vi.fn() }, reboundItem),
      ).not.toThrow();
      expect(reboundItem.cancel).toHaveBeenCalledOnce();
      expect(session.downloadURL).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(400);
      expect(session.downloadURL).toHaveBeenCalledTimes(2);
      expect(statSync(`${request.finalPath}.partial.resume`).size).toBe(100);
      expect(readJournal(userDataPath)).toEqual([
        expect.objectContaining({ id: request.id, receivedBytes: 100 }),
      ]);

      engine.cancel('tool');
      await expect(completion).rejects.toThrow('下载已取消');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('recovers the durable snapshot when quit lands inside the 400ms rebind window', async () => {
    vi.useFakeTimers();
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-rebind-quit-'));
    try {
      let state = 'progressing';
      const item = createItem({
        canResume: vi.fn(() => false),
        getReceivedBytes: vi.fn(() => 100),
        getState: vi.fn(() => state),
      });
      const session = createSession();
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
      await vi.advanceTimersByTimeAsync(1_000);
      expect(existsSync(`${request.finalPath}.partial.resume`)).toBe(true);

      engine.dispose();
      await expect(completion).rejects.toThrow('下载引擎已经关闭');
      unlinkSync(`${request.finalPath}.partial`);
      const recoverySession = createSession();
      const recoveryEngine = new DownloadEngine(
        recoverySession as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      recoveryEngine.restoreInterrupted();
      expect(recoverySession.createInterruptedDownload).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 100 }),
      );
      recoveryEngine.dispose();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('rolls back deferred startup creation failure even after an item bound', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-create-after-bind-'));
    try {
      writeRecoveryFixture(userDataPath);
      const item = createItem({ getReceivedBytes: vi.fn(() => 100) });
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

      engine.restoreInterrupted();
      expect(item.setSavePath).toHaveBeenCalledOnce();
      rejectCreation(new Error('deferred create failure'));
      await vi.waitFor(() => expect(engine.list()).toEqual([]));

      expect(item.cancel).toHaveBeenCalledOnce();
      expect(item.listenerCount('done')).toBe(0);
      expect(busyRegistry.list()).toEqual([]);
      expect(readJournal(userDataPath)).toEqual([
        expect.objectContaining({ id: 'recovered-tool', receivedBytes: 100 }),
      ]);
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('restores original journal metadata when post-setSavePath binding fails', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-bind-journal-'));
    try {
      const original = writeRecoveryFixture(userDataPath);
      const item = createItem({
        getETag: vi.fn(() => '"mutated"'),
        getReceivedBytes: vi.fn(() => {
          writeFileSync(original.savePath, Buffer.alloc(10));
          throw new Error('post-setSavePath bind failure');
        }),
      });
      const session = createSession();
      session.createInterruptedDownload.mockImplementation(() => {
        session.emit('will-download', { preventDefault: vi.fn() }, item);
      });
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );

      expect(() => engine.restoreInterrupted()).not.toThrow();

      expect(item.setSavePath).toHaveBeenCalledOnce();
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(engine.list()).toEqual([]);
      expect(busyRegistry.list()).toEqual([]);
      expect(readJournal(userDataPath)).toEqual([
        expect.objectContaining({
          eTag: original.eTag,
          id: original.id,
          receivedBytes: original.receivedBytes,
        }),
      ]);
      expect(statSync(`${original.savePath}.resume`).size).toBe(100);
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('rolls back a BusyRegistry lease when acquire notification throws', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-busy-acquire-'));
    try {
      const session = createSession();
      const busyRegistry = new BusyRegistry(() => {
        throw new Error('busy listener failed');
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        userDataPath,
      );

      expect(() => engine.start(createRequest(userDataPath))).toThrow('busy listener failed');
      expect(busyRegistry.list()).toEqual([]);
      expect(engine.list()).toEqual([]);
      expect(session.downloadURL).not.toHaveBeenCalled();
      engine.dispose();
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('filters an invalid journal before creating any restore task and skips no-op replace', () => {
    const firstPath = mkdtempSync(path.join(tmpdir(), 'claudedock-restore-filter-'));
    try {
      const valid = writeRecoveryFixture(firstPath);
      const invalid: RecoveryEntry = {
        ...valid,
        finalPath: path.join(firstPath, 'downloads', 'missing.exe'),
        id: 'missing-tool',
        savePath: path.join(firstPath, 'downloads', 'missing.exe.partial'),
      };
      writeFileSync(
        path.join(firstPath, 'download-journal.json'),
        JSON.stringify([valid, invalid]),
      );
      const temporaryPath = path.join(firstPath, 'download-journal.json.tmp');
      mkdirSync(temporaryPath, { recursive: true });
      const session = createSession();
      const busyRegistry = new BusyRegistry();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        busyRegistry,
        firstPath,
      );

      expect(() => engine.restoreInterrupted()).toThrow();
      expect(session.createInterruptedDownload).not.toHaveBeenCalled();
      expect(engine.list()).toEqual([]);
      expect(busyRegistry.list()).toEqual([]);
      rmSync(temporaryPath, { force: true, recursive: true });
      engine.restoreInterrupted();
      expect(session.createInterruptedDownload).toHaveBeenCalledOnce();
      engine.dispose();
    } finally {
      rmSync(firstPath, { force: true, recursive: true });
    }

    const secondPath = mkdtempSync(path.join(tmpdir(), 'claudedock-restore-noop-'));
    try {
      writeRecoveryFixture(secondPath);
      const temporaryPath = path.join(secondPath, 'download-journal.json.tmp');
      mkdirSync(temporaryPath, { recursive: true });
      const session = createSession();
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        secondPath,
      );

      expect(() => engine.restoreInterrupted()).not.toThrow();
      expect(session.createInterruptedDownload).toHaveBeenCalledOnce();
      rmSync(temporaryPath, { force: true, recursive: true });
      engine.dispose();
    } finally {
      rmSync(secondPath, { force: true, recursive: true });
    }
  });
});
