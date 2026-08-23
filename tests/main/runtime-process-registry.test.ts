import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseWindowsProcessSnapshot,
  RuntimeProcessRegistry,
  RuntimeProcessScanCancelledError,
  type RuntimeProcessOwner,
  type RuntimeProcessStopTarget,
  type RuntimeProcessSystem,
  type WindowsProcessSnapshot,
} from '../../src/main/runtime/process-registry';
import type { RuntimeWebProcessView } from '../../src/shared/contracts';

const owner: RuntimeProcessOwner = {
  launchGeneration: 3,
  ptyGeneration: 5,
  rootPid: 10,
  sessionId: 'session-1',
};

const snapshot = (startedAt = 2_000, rootStartedAt = 1_000): WindowsProcessSnapshot => ({
  listeners: [
    { address: '127.0.0.1', pid: 20, port: 3080 },
    { address: '0.0.0.0', pid: 30, port: 9222 },
    { address: '127.0.0.1', pid: 40, port: 4_000 },
  ],
  processes: [
    {
      name: 'powershell.exe',
      parentPid: 1,
      pid: 10,
      startedAt: rootStartedAt,
    },
    {
      name: 'node.exe',
      parentPid: 10,
      pid: 20,
      startedAt,
    },
    {
      name: 'chrome.exe',
      parentPid: 10,
      pid: 30,
      startedAt: 3_000,
    },
    {
      name: 'node.exe',
      parentPid: 30,
      pid: 40,
      startedAt: 3_100,
    },
  ],
});

const emptySnapshot = (): WindowsProcessSnapshot => ({ listeners: [], processes: [] });

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('runtime process registry', () => {
  it('drops command lines while retaining unknown birth times for conservative verification', () => {
    const parsed = parseWindowsProcessSnapshot(
      JSON.stringify({
        listeners: { address: '127.0.0.1', pid: 20, port: 3080 },
        processes: [
          {
            commandLine: 'node app.js --token secret',
            name: 'node.exe',
            parentPid: 10,
            pid: 20,
            startedAt: 2_000,
          },
          {
            commandLine: 'node reused.js --token secret',
            name: 'node.exe',
            parentPid: 10,
            pid: 21,
            startedAt: 0,
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      listeners: [{ address: '127.0.0.1', pid: 20, port: 3080 }],
      processes: [
        { name: 'node.exe', parentPid: 10, pid: 20, startedAt: 2_000 },
        { name: 'node.exe', parentPid: 10, pid: 21, startedAt: 0 },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('serializes an explicit refresh behind a deferred startup scan', async () => {
    const firstCapture = deferred<WindowsProcessSnapshot>();
    const captureStarted = deferred<void>();
    const published: RuntimeWebProcessView[][] = [];
    const capture = vi
      .fn<RuntimeProcessSystem['capture']>()
      .mockImplementationOnce(() => {
        captureStarted.resolve();
        return firstCapture.promise;
      })
      .mockResolvedValueOnce(emptySnapshot());
    const registry = new RuntimeProcessRegistry(
      (_sessionId, processes) => published.push(processes),
      {
        capture,
        forceStop: vi.fn(async () => undefined),
        gracefulStop: vi.fn(async () => undefined),
      },
    );

    registry.start(() => [owner]);
    await captureStarted.promise;
    const refreshes = Array.from({ length: 100 }, () => registry.scan());
    expect(new Set(refreshes)).toHaveLength(1);
    expect(capture).toHaveBeenCalledTimes(1);

    firstCapture.resolve(snapshot());
    await Promise.all(refreshes);
    registry.stop();

    expect(capture).toHaveBeenCalledTimes(2);
    expect(published.at(-1)).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('keeps a deferred refresh behind the verified terminate transaction', async () => {
    vi.useFakeTimers();
    const deferredRefresh = deferred<WindowsProcessSnapshot>();
    const gracefulPassCaptured = deferred<void>();
    const gracefulStarted = deferred<void>();
    let duringGraceDelay = false;
    let gracefulIssued = false;
    let processAlive = true;
    const capture = vi.fn<RuntimeProcessSystem['capture']>(() => {
      if (duringGraceDelay) return deferredRefresh.promise;
      if (gracefulIssued) gracefulPassCaptured.resolve();
      return Promise.resolve(processAlive ? snapshot() : emptySnapshot());
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture,
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => {
        gracefulIssued = true;
        gracefulStarted.resolve();
      }),
    });

    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const processKey = registry.list()[0]?.view.processKey ?? '';
    const termination = registry.terminate(owner.sessionId, processKey);
    await gracefulStarted.promise;
    await gracefulPassCaptured.promise;
    await Promise.resolve();

    duringGraceDelay = true;
    const refresh = registry.scan();
    await Promise.resolve();
    duringGraceDelay = false;
    processAlive = false;
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;

    deferredRefresh.resolve(snapshot());
    await refresh;
    expect(registry.list()).toEqual([]);
  });

  it('pauses scheduled polling while terminateAll owns the process queue', async () => {
    vi.useFakeTimers();
    const gracefulRelease = deferred<void>();
    const gracefulStarted = deferred<void>();
    let processAlive = true;
    const capture = vi.fn<RuntimeProcessSystem['capture']>(() =>
      Promise.resolve(processAlive ? snapshot() : emptySnapshot()),
    );
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture,
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => {
        gracefulStarted.resolve();
        await gracefulRelease.promise;
      }),
    });

    registry.start(() => [owner]);
    await registry.scan();
    expect(vi.getTimerCount()).toBe(1);
    capture.mockClear();
    const termination = registry.terminateAll();
    await gracefulStarted.promise;
    expect(vi.getTimerCount()).toBe(0);
    const capturesAtGracefulStop = capture.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(capture).toHaveBeenCalledTimes(capturesAtGracefulStop);

    processAlive = false;
    gracefulRelease.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;
    registry.stop();
    expect(registry.list()).toEqual([]);
  });

  it('generation-fences a stopped scan behind a newer empty refresh', async () => {
    vi.useFakeTimers();
    const firstCapture = deferred<WindowsProcessSnapshot>();
    const captureStarted = deferred<void>();
    const onChange = vi.fn();
    const capture = vi
      .fn<RuntimeProcessSystem['capture']>()
      .mockImplementationOnce(() => {
        captureStarted.resolve();
        return firstCapture.promise;
      })
      .mockResolvedValueOnce(emptySnapshot());
    const registry = new RuntimeProcessRegistry(onChange, {
      capture,
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => undefined),
    });

    registry.start(() => [owner]);
    await captureStarted.promise;
    const staleRefresh = expect(registry.scan()).rejects.toBeInstanceOf(
      RuntimeProcessScanCancelledError,
    );
    registry.stop();
    await staleRefresh;
    const currentRefresh = registry.scan();
    expect(capture).toHaveBeenCalledOnce();
    firstCapture.resolve(snapshot());
    await currentRefresh;
    expect(onChange).toHaveBeenLastCalledWith(owner.sessionId, []);
    expect(registry.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('isolates a reentrant listener failure from queued scans', async () => {
    const onChange = vi.fn(() => {
      registry.stop();
      throw new Error('listener failed');
    });
    const capture = vi.fn(async () => snapshot());
    const registry = new RuntimeProcessRegistry(onChange, {
      capture,
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => undefined),
    });

    registry.start(() => [owner]);
    const queuedRefresh = expect(registry.scan()).rejects.toBeInstanceOf(
      RuntimeProcessScanCancelledError,
    );
    await queuedRefresh;

    expect(onChange).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
  });

  it('suppresses unchanged polling publications but publishes ownership changes', async () => {
    vi.useFakeTimers();
    let owners = [owner];
    const onChange = vi.fn();
    const registry = new RuntimeProcessRegistry(onChange, {
      capture: vi.fn(async () => snapshot()),
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => undefined),
    });

    registry.start(() => owners);
    await registry.scan();
    expect(onChange).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onChange).toHaveBeenCalledOnce();

    owners = [{ ...owner, ptyGeneration: 6 }];
    await registry.scan();
    expect(onChange).toHaveBeenCalledTimes(2);
    registry.stop();
  });

  it('prunes historical and expired URLs and normalizes default ports', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    let owners = [owner];
    const published = new Map<string, RuntimeWebProcessView[]>();
    const port80Snapshot: WindowsProcessSnapshot = {
      listeners: [{ address: '127.0.0.1', pid: 20, port: 80 }],
      processes: snapshot().processes,
    };
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      {
        capture: vi.fn(async () => port80Snapshot),
        forceStop: vi.fn(async () => undefined),
        gracefulStop: vi.fn(async () => undefined),
      },
    );

    registry.observeTerminalOutput(owner.sessionId, owner.ptyGeneration, 'http://localhost');
    registry.start(() => owners);
    await registry.scan();
    expect(published.get(owner.sessionId)?.[0]?.urls).toEqual([
      { confirmed: true, url: 'http://localhost' },
    ]);

    owners = [{ ...owner, ptyGeneration: 6 }];
    await registry.scan();
    owners = [owner];
    await registry.scan();
    expect(published.get(owner.sessionId)?.[0]?.urls).toEqual([
      { confirmed: false, url: 'http://127.0.0.1:80' },
    ]);

    registry.observeTerminalOutput(owner.sessionId, owner.ptyGeneration, 'http://localhost');
    await registry.scan();
    vi.setSystemTime(new Date('2026-08-21T00:00:00.001Z'));
    await registry.scan();
    expect(published.get(owner.sessionId)?.[0]?.urls).toEqual([
      { confirmed: false, url: 'http://127.0.0.1:80' },
    ]);
    registry.stop();
  });

  it('shows only listening verified descendants, redacts commands, and changes keys on PID reuse', async () => {
    let current = snapshot();
    const published = new Map<string, RuntimeWebProcessView[]>();
    const system: RuntimeProcessSystem = {
      capture: vi.fn(async () => current),
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => undefined),
    };
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      system,
    );
    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const first = published.get(owner.sessionId)?.[0];
    expect(first).toMatchObject({ name: 'node', pid: 20, ports: [3080] });
    expect(first?.commandSummary).not.toContain('secret');
    expect(first?.urls).toEqual([{ confirmed: false, url: 'http://127.0.0.1:3080' }]);
    expect(published.get(owner.sessionId)).toHaveLength(1);

    current = snapshot(4_000);
    await registry.scan();
    const reused = published.get(owner.sessionId)?.[0];
    expect(reused?.processKey).not.toBe(first?.processKey);

    current = snapshot(4_000, 5_000);
    await registry.scan();
    expect(registry.list()).toEqual([]);

    current = snapshot(0, 5_000);
    await registry.scan();
    expect(registry.list()).toEqual([]);
  });

  it('lets an owned termination finish after observer stop without late publication', async () => {
    vi.useFakeTimers();
    const gracefulStarted = deferred<void>();
    let current = snapshot();
    const onChange = vi.fn();
    const capture = vi.fn(async () => current);
    const registry = new RuntimeProcessRegistry(onChange, {
      capture,
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => {
        current = emptySnapshot();
        gracefulStarted.resolve();
      }),
    });

    registry.start(() => [owner]);
    await registry.scan();
    const processKey = registry.list()[0]?.view.processKey ?? '';
    onChange.mockClear();
    const termination = registry.terminate(owner.sessionId, processKey);
    await gracefulStarted.promise;
    registry.stop();
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;

    expect(registry.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledOnce();
    const capturesAfterTermination = capture.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(capture).toHaveBeenCalledTimes(capturesAfterTermination);
  });

  it('force-stops a verified child after its target root exits', async () => {
    vi.useFakeTimers();
    const targetExited = deferred<void>();
    let current: WindowsProcessSnapshot = {
      listeners: snapshot().listeners,
      processes: [
        ...snapshot().processes,
        { name: 'python.exe', parentPid: 20, pid: 21, startedAt: 2_100 },
      ],
    };
    const gracefulStop = vi.fn(async (targets: RuntimeProcessStopTarget[]) => {
      if (!targets.some((target) => target.pid === 20)) return;
      current = {
        listeners: current.listeners.filter((listener) => listener.pid !== 20),
        processes: current.processes.filter((process) => process.pid !== 20),
      };
      targetExited.resolve();
    });
    const forceStop = vi.fn(async (targets: RuntimeProcessStopTarget[]) => {
      const pids = new Set(targets.map((target) => target.pid));
      current = {
        listeners: current.listeners.filter((listener) => !pids.has(listener.pid)),
        processes: current.processes.filter((process) => !pids.has(process.pid)),
      };
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop,
      gracefulStop,
    });

    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const processKey = registry.list()[0]?.view.processKey ?? '';
    const termination = registry.terminate(owner.sessionId, processKey);
    await targetExited.promise;
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;

    expect(gracefulStop).toHaveBeenCalledWith([
      { pid: 21, startedAt: 2_100 },
      { pid: 20, startedAt: 2_000 },
    ]);
    expect(forceStop).toHaveBeenCalledWith([{ pid: 21, startedAt: 2_100 }]);
    expect(registry.list()).toEqual([]);
  });

  it('does not kill a PID-reused process after the verified target exits', async () => {
    vi.useFakeTimers();
    const targetExited = deferred<void>();
    let current = snapshot();
    const forceStop = vi.fn(async () => undefined);
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop,
      gracefulStop: vi.fn(async () => {
        current = snapshot(9_000);
        targetExited.resolve();
      }),
    });

    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const original = registry.list()[0]?.view;
    const termination = registry.terminate(owner.sessionId, original?.processKey ?? '');
    await targetExited.promise;
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;

    expect(forceStop).not.toHaveBeenCalled();
    expect(registry.list()[0]?.view).toMatchObject({ pid: 20, startedAt: 9_000 });
    expect(registry.list()[0]?.view.processKey).not.toBe(original?.processKey);
  });

  it('rejects an unverified force-stop result and restores running status', async () => {
    vi.useFakeTimers();
    const gracefulStarted = deferred<void>();
    const published = new Map<string, RuntimeWebProcessView[]>();
    const forceStop = vi.fn(async () => {
      throw new Error('taskkill failed');
    });
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      {
        capture: vi.fn(async () => snapshot()),
        forceStop,
        gracefulStop: vi.fn(async () => {
          gracefulStarted.resolve();
        }),
      },
    );

    registry.start(() => [owner]);
    await registry.scan();
    const processKey = registry.list()[0]?.view.processKey ?? '';
    const termination = expect(registry.terminate(owner.sessionId, processKey)).rejects.toThrow(
      'taskkill failed',
    );
    await gracefulStarted.promise;
    await vi.advanceTimersByTimeAsync(1_500);

    await termination;
    expect(forceStop).toHaveBeenCalledWith([{ pid: 20, startedAt: 2_000 }]);
    expect(registry.list()[0]?.view.status).toBe('running');
    expect(published.get(owner.sessionId)?.[0]?.status).toBe('running');
    registry.stop();
  });

  it('terminateAll rescans and cleans sessions that appear during cleanup', async () => {
    vi.useFakeTimers();
    const firstStopped = deferred<void>();
    const secondStopped = deferred<void>();
    const secondOwner: RuntimeProcessOwner = {
      launchGeneration: 4,
      ptyGeneration: 6,
      rootPid: 110,
      sessionId: 'session-2',
    };
    let owners = [owner];
    let current = snapshot();
    const gracefulStop = vi.fn(async ([target]: RuntimeProcessStopTarget[]) => {
      const pid = target?.pid;
      if (pid === 20) {
        owners = [owner, secondOwner];
        current = {
          listeners: [{ address: '127.0.0.1', pid: 120, port: 4_080 }],
          processes: [
            { name: 'powershell.exe', parentPid: 1, pid: 10, startedAt: 1_000 },
            { name: 'powershell.exe', parentPid: 1, pid: 110, startedAt: 11_000 },
            { name: 'node.exe', parentPid: 110, pid: 120, startedAt: 12_000 },
          ],
        };
        firstStopped.resolve();
      } else if (pid === 120) {
        current = {
          listeners: [],
          processes: current.processes.filter((process) => process.pid !== 120),
        };
        secondStopped.resolve();
      }
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop: vi.fn(async () => undefined),
      gracefulStop,
    });

    registry.start(() => owners);
    await registry.scan();
    const termination = registry.terminateAll();
    await firstStopped.promise;
    await vi.advanceTimersByTimeAsync(1_500);
    await secondStopped.promise;
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;

    expect(gracefulStop).toHaveBeenCalledWith([{ pid: 20, startedAt: 2_000 }]);
    expect(gracefulStop).toHaveBeenCalledWith([{ pid: 120, startedAt: 12_000 }]);
    expect(registry.list()).toEqual([]);
    registry.stop();
  });

  it('revalidates the opaque key and ownership before stopping the exact subtree', async () => {
    let current = snapshot();
    const published = new Map<string, RuntimeWebProcessView[]>();
    const gracefulStop = vi.fn(async () => {
      current = { listeners: [], processes: current.processes.slice(0, 1) };
    });
    const forceStop = vi.fn(async () => undefined);
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      { capture: vi.fn(async () => current), forceStop, gracefulStop },
    );
    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const processKey = published.get(owner.sessionId)?.[0]?.processKey ?? '';

    current = {
      listeners: [...current.listeners, { address: '127.0.0.1', pid: 60, port: 5_080 }],
      processes: [
        ...current.processes,
        {
          name: 'claude.exe',
          parentPid: 20,
          pid: 50,
          startedAt: 5_000,
        },
        {
          name: 'node.exe',
          parentPid: 50,
          pid: 60,
          startedAt: 6_000,
        },
      ],
    };

    await expect(registry.terminate(owner.sessionId, 'not-a-real-key')).rejects.toThrow(/不再属于/);
    await registry.terminate(owner.sessionId, processKey);
    expect(gracefulStop).toHaveBeenCalledWith([{ pid: 20, startedAt: 2_000 }]);
    expect(forceStop).not.toHaveBeenCalled();
    expect(published.get(owner.sessionId)).toEqual([]);
  });
});
