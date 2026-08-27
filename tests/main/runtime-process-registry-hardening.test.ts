import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeProcessRegistry,
  RuntimeProcessScanCancelledError,
  type RuntimeProcessOwner,
  type RuntimeProcessStopTarget,
  type RuntimeProcessSystem,
  type WindowsProcessSnapshot,
} from '../../src/main/runtime/process-registry';
import {
  createRuntimeProcessSystem,
  type RuntimeProcessRunner,
} from '../../src/main/runtime/process-registry-system';
import type { RuntimeWebProcessView } from '../../src/shared/contracts';

const owner: RuntimeProcessOwner = {
  launchGeneration: 3,
  ptyGeneration: 5,
  rootPid: 10,
  sessionId: 'session-1',
};

const webSnapshot = (startedAt = 2_000, rootStartedAt = 1_000): WindowsProcessSnapshot => ({
  listeners: [{ address: '127.0.0.1', pid: 20, port: 3_080 }],
  processes: [
    { name: 'powershell.exe', parentPid: 1, pid: 10, startedAt: rootStartedAt },
    { name: 'node.exe', parentPid: 10, pid: 20, startedAt },
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

const inertStops = (): Pick<RuntimeProcessSystem, 'forceStop' | 'gracefulStop'> => ({
  forceStop: vi.fn(async () => undefined),
  gracefulStop: vi.fn(async () => undefined),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runtime process registry hardening', () => {
  it('keeps session cleanup valid while a sibling changes generation during the scan', async () => {
    vi.useFakeTimers();
    const sibling = { ...owner, rootPid: 110, sessionId: 'session-2' };
    let owners = [owner, sibling];
    let current: WindowsProcessSnapshot = {
      listeners: [...webSnapshot().listeners, { address: '127.0.0.1', pid: 120, port: 4_080 }],
      processes: [
        ...webSnapshot().processes,
        { name: 'powershell.exe', parentPid: 1, pid: 110, startedAt: 11_000 },
        { name: 'node.exe', parentPid: 110, pid: 120, startedAt: 12_000 },
      ],
    };
    let changeSibling = false;
    const capture = vi.fn(async () => {
      if (changeSibling) {
        changeSibling = false;
        owners = [owner, { ...sibling, ptyGeneration: sibling.ptyGeneration + 1 }];
      }
      return current;
    });
    const gracefulStop = vi.fn(async (targets: RuntimeProcessStopTarget[]) => {
      expect(targets).toEqual([{ pid: 20, startedAt: 2_000 }]);
      current = {
        listeners: current.listeners.filter(({ pid }) => pid !== 20),
        processes: current.processes.filter(({ pid }) => pid !== 20),
      };
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture,
      forceStop: vi.fn(async () => undefined),
      gracefulStop,
    });
    registry.start(() => owners);
    await registry.scan();
    const siblingView = registry.list().find(({ sessionId }) => sessionId === sibling.sessionId);
    changeSibling = true;
    const result = expect(registry.terminateSession(owner.sessionId)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    await result;
    expect(gracefulStop).toHaveBeenCalledOnce();
    expect(registry.list()).toEqual([siblingView]);
    registry.stop();
  });

  it('still rejects cleanup when its own session changes generation during the scan', async () => {
    let owners = [owner];
    let changeOwner = false;
    const stops = inertStops();
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => {
        if (changeOwner) owners = [{ ...owner, ptyGeneration: owner.ptyGeneration + 1 }];
        return webSnapshot();
      }),
      ...stops,
    });
    registry.start(() => owners);
    await registry.scan();
    changeOwner = true;
    await expect(registry.terminateSession(owner.sessionId)).rejects.toThrow('进程所有权');
    expect(stops.gracefulStop).not.toHaveBeenCalled();
    expect(stops.forceStop).not.toHaveBeenCalled();
    registry.stop();
  });

  it('passes PID and birth time into one exact-stop PowerShell boundary', async () => {
    const run = vi.fn<RuntimeProcessRunner>(async () => ({ stderr: '', stdout: '' }));
    const system = createRuntimeProcessSystem({ platform: 'win32', run });

    await system.forceStop([{ pid: 20, startedAt: 2_000 }]);

    expect(run).toHaveBeenCalledOnce();
    const [executable, argumentsList, environment] = run.mock.calls[0] ?? [];
    const command = argumentsList?.at(-1) ?? '';
    expect(executable).toBe('powershell.exe');
    expect(environment).toMatchObject({
      CLAUDEDOCK_RUNTIME_STOP_FORCE: '1',
      CLAUDEDOCK_RUNTIME_STOP_PID: '20',
      CLAUDEDOCK_RUNTIME_STOP_STARTED_AT: '2000',
    });
    expect(command).toContain('Get-CimInstance Win32_Process');
    expect(command).toContain('$startedAt -ne $expectedStartedAt');
    expect(command.indexOf('Get-CimInstance')).toBeLessThan(command.indexOf('taskkill.exe'));
    expect(command).not.toContain(' 2000 ');
  });

  it('surfaces process and listener query failures instead of publishing an empty snapshot', async () => {
    const queryFailure = new Error('listener query failed');
    const run = vi.fn<RuntimeProcessRunner>(async () => {
      throw queryFailure;
    });
    const system = createRuntimeProcessSystem({ platform: 'win32', run });

    await expect(system.capture()).rejects.toBe(queryFailure);
    const command = run.mock.calls[0]?.[1].at(-1) ?? '';
    expect(command).toContain("$ErrorActionPreference = 'Stop'");
    expect(command).toContain('Get-NetTCPConnection -State Listen -ErrorAction Stop');
    expect(command).not.toContain('SilentlyContinue');
  });

  it('does not let a post-mutation scan reuse a pre-mutation trailing scan', async () => {
    vi.useFakeTimers();
    const heldCapture = deferred<WindowsProcessSnapshot>();
    const heldCaptureStarted = deferred<void>();
    const gracefulStarted = deferred<void>();
    let holdNextCapture = false;
    let current = webSnapshot();
    const capture = vi.fn<RuntimeProcessSystem['capture']>(() => {
      if (holdNextCapture) {
        holdNextCapture = false;
        heldCaptureStarted.resolve();
        return heldCapture.promise;
      }
      return Promise.resolve(current);
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
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
    holdNextCapture = true;
    const runningScan = registry.scan();
    await heldCaptureStarted.promise;
    const preMutationTrailing = registry.scan();
    const termination = registry.terminate(owner.sessionId, processKey);
    const postMutationScan = registry.scan();

    expect(postMutationScan).not.toBe(preMutationTrailing);
    heldCapture.resolve(current);
    await Promise.all([runningScan, preMutationTrailing]);
    await gracefulStarted.promise;
    let postMutationSettled = false;
    void postMutationScan.then(() => {
      postMutationSettled = true;
    });
    await Promise.resolve();
    expect(postMutationSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    await termination;
    await postMutationScan;
    expect(registry.list()).toEqual([]);
    registry.stop();
  });

  it('keeps a pre-stop cleanup on its frozen owner scope after provider replacement', async () => {
    vi.useFakeTimers();
    const gracefulRelease = deferred<void>();
    const gracefulStarted = deferred<void>();
    const replacementProviderError = new Error('replacement provider was read');
    let current = webSnapshot();
    const gracefulStop = vi.fn(async (targets: RuntimeProcessStopTarget[]) => {
      gracefulStarted.resolve();
      await gracefulRelease.promise;
      const identities = new Set(targets.map((target) => `${target.pid}:${target.startedAt}`));
      current = {
        listeners: current.listeners.filter(
          (listener) =>
            !current.processes.some(
              (process) =>
                process.pid === listener.pid &&
                identities.has(`${process.pid}:${process.startedAt}`),
            ),
        ),
        processes: current.processes.filter(
          (process) => !identities.has(`${process.pid}:${process.startedAt}`),
        ),
      };
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop: vi.fn(async () => undefined),
      gracefulStop,
    });

    registry.start(() => [owner]);
    await registry.scan();
    const termination = registry.terminateAll();
    await gracefulStarted.promise;
    registry.stop();
    registry.start(() => {
      throw replacementProviderError;
    });
    gracefulRelease.resolve();
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(termination).resolves.toBeUndefined();
    expect(gracefulStop).toHaveBeenCalledWith([{ pid: 20, startedAt: 2_000 }]);
    registry.stop();
  });

  it('rejects same-owner root PID reuse until the owner generation changes', async () => {
    let owners = [owner];
    let current = webSnapshot();
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      ...inertStops(),
    });

    registry.start(() => owners);
    await registry.scan();
    expect(registry.list()).toHaveLength(1);

    current = webSnapshot(6_000, 5_000);
    await registry.scan();
    expect(registry.list()).toEqual([]);

    owners = [{ ...owner, launchGeneration: owner.launchGeneration + 1 }];
    await registry.scan();
    expect(registry.list()[0]?.view).toMatchObject({ pid: 20, startedAt: 6_000 });
    registry.stop();
  });

  it.each(['session', 'all'] as const)(
    'preserves a failed %s cleanup even after the target closes its listener',
    async (mode) => {
      vi.useFakeTimers();
      let current = webSnapshot();
      const forceStop = vi.fn(async () => {
        current = emptySnapshot();
        throw new Error('taskkill failed after listener closed');
      });
      const registry = new RuntimeProcessRegistry(() => undefined, {
        capture: vi.fn(async () => current),
        forceStop,
        gracefulStop: vi.fn(async () => undefined),
      });

      registry.start(() => [owner]);
      await registry.scan();
      const operation =
        mode === 'session' ? registry.terminateSession(owner.sessionId) : registry.terminateAll();
      const rejection = expect(operation).rejects.toThrow('taskkill failed after listener closed');
      await vi.advanceTimersByTimeAsync(1_500);

      await rejection;
      expect(forceStop).toHaveBeenCalledWith([{ pid: 20, startedAt: 2_000 }]);
      expect(registry.list()).toEqual([]);
      registry.stop();
    },
  );

  it('fails within the attempt budget under continuous descendant churn', async () => {
    vi.useFakeTimers();
    let current = webSnapshot();
    const forceStop = vi.fn(async ([target]: RuntimeProcessStopTarget[]) => {
      if (!target) return;
      const nextPid = target.pid + 1;
      const nextStartedAt = target.startedAt + 10;
      current = {
        listeners: [{ address: '127.0.0.1', pid: nextPid, port: 3_080 }],
        processes: [
          { name: 'powershell.exe', parentPid: 1, pid: 10, startedAt: 1_000 },
          {
            name: 'node.exe',
            parentPid: target.pid,
            pid: nextPid,
            startedAt: nextStartedAt,
          },
        ],
      };
      return [{ ...target, reuseSafeBefore: nextStartedAt }];
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop,
      gracefulStop: vi.fn(async () => undefined),
    });

    registry.start(() => [owner]);
    await registry.scan();
    const processKey = registry.list()[0]?.view.processKey ?? '';
    const operation = registry.terminate(owner.sessionId, processKey);
    const rejection = expect(operation).rejects.toThrow(/安全尝试上限|未完成/);
    await vi.advanceTimersByTimeAsync(1_500);

    await rejection;
    expect(forceStop.mock.calls.length).toBeLessThanOrEqual(256);
    expect(forceStop).toHaveBeenCalled();
    registry.stop();
  });

  it('adds a child spawned as its historical parent exits to the stop plan', async () => {
    vi.useFakeTimers();
    let current = webSnapshot();
    const gracefulStop = vi.fn(async ([target]: RuntimeProcessStopTarget[]) => {
      if (!target) return;
      if (target.pid === 20) {
        current = {
          listeners: [{ address: '127.0.0.1', pid: 21, port: 3_080 }],
          processes: [
            { name: 'powershell.exe', parentPid: 1, pid: 10, startedAt: 1_000 },
            { name: 'python.exe', parentPid: 20, pid: 21, startedAt: 2_100 },
          ],
        };
        return [{ ...target, reuseSafeBefore: 2_100 }];
      } else {
        current = emptySnapshot();
        return [{ ...target, reuseSafeBefore: 2_200 }];
      }
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop: vi.fn(async () => undefined),
      gracefulStop,
    });

    registry.start(() => [owner]);
    await registry.scan();
    const processKey = registry.list()[0]?.view.processKey ?? '';
    const termination = registry.terminate(owner.sessionId, processKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;

    expect(gracefulStop.mock.calls).toEqual([
      [[{ pid: 20, startedAt: 2_000 }]],
      [[{ pid: 21, startedAt: 2_100 }]],
    ]);
    expect(registry.list()).toEqual([]);
    registry.stop();
  });

  it('keeps a PID replacement alive when it appears inside the exact-stop call', async () => {
    vi.useFakeTimers();
    let current = webSnapshot();
    const forceStop = vi.fn(async (targets: RuntimeProcessStopTarget[]) => {
      expect(targets).toEqual([{ pid: 20, startedAt: 2_000 }]);
      current = webSnapshot(9_000);
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop,
      gracefulStop: vi.fn(async () => undefined),
    });

    registry.start(() => [owner]);
    await registry.scan();
    const originalKey = registry.list()[0]?.view.processKey ?? '';
    const termination = registry.terminate(owner.sessionId, originalKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await termination;

    expect(registry.list()[0]?.view).toMatchObject({ pid: 20, startedAt: 9_000 });
    expect(registry.list()[0]?.view.processKey).not.toBe(originalKey);
    registry.stop();
  });

  it('fails closed when a known PID has an unknown birth time in the final snapshot', async () => {
    vi.useFakeTimers();
    let current = webSnapshot();
    const forceStop = vi.fn(async () => {
      current = webSnapshot(0);
    });
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      forceStop,
      gracefulStop: vi.fn(async () => undefined),
    });

    registry.start(() => [owner]);
    await registry.scan();
    const processKey = registry.list()[0]?.view.processKey ?? '';
    const operation = registry.terminate(owner.sessionId, processKey);
    const rejection = expect(operation).rejects.toThrow(/创建时间|安全确认/);
    await vi.advanceTimersByTimeAsync(1_500);

    await rejection;
    expect(forceStop).toHaveBeenCalledWith([{ pid: 20, startedAt: 2_000 }]);
    registry.stop();
  });

  it('keeps the last publication when a later process query fails', async () => {
    let failCapture = false;
    const onChange = vi.fn();
    const capture = vi.fn(async () => {
      if (failCapture) throw new Error('process query failed');
      return webSnapshot();
    });
    const registry = new RuntimeProcessRegistry(onChange, { capture, ...inertStops() });

    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const before = registry.list();
    onChange.mockClear();
    failCapture = true;

    await expect(registry.scan()).rejects.toThrow('process query failed');
    expect(registry.list()).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects tree edges whose child predates its parent', async () => {
    let current: WindowsProcessSnapshot = {
      listeners: [{ address: '127.0.0.1', pid: 20, port: 3_080 }],
      processes: [
        { name: 'powershell.exe', parentPid: 1, pid: 10, startedAt: 1_000 },
        { name: 'node.exe', parentPid: 10, pid: 20, startedAt: 900 },
      ],
    };
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(async () => current),
      ...inertStops(),
    });

    registry.start(() => [owner]);
    await registry.scan();
    expect(registry.list()).toEqual([]);

    current = webSnapshot(2_000);
    await registry.scan();
    expect(registry.list()).toHaveLength(1);
    registry.stop();
  });

  it('does not apply a capture after its owner provider revision changes', async () => {
    const oldCapture = deferred<WindowsProcessSnapshot>();
    const captureStarted = deferred<void>();
    const replacementOwner: RuntimeProcessOwner = {
      launchGeneration: 8,
      ptyGeneration: 9,
      rootPid: 110,
      sessionId: 'session-2',
    };
    const replacementSnapshot: WindowsProcessSnapshot = {
      listeners: [{ address: '127.0.0.1', pid: 120, port: 4_080 }],
      processes: [
        { name: 'powershell.exe', parentPid: 1, pid: 110, startedAt: 11_000 },
        { name: 'node.exe', parentPid: 110, pid: 120, startedAt: 12_000 },
      ],
    };
    const published: Array<{ processes: RuntimeWebProcessView[]; sessionId: string }> = [];
    const capture = vi
      .fn<RuntimeProcessSystem['capture']>()
      .mockImplementationOnce(() => {
        captureStarted.resolve();
        return oldCapture.promise;
      })
      .mockResolvedValue(replacementSnapshot);
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.push({ processes, sessionId }),
      { capture, ...inertStops() },
    );

    registry.start(() => [owner]);
    await captureStarted.promise;
    registry.start(() => [replacementOwner]);
    oldCapture.resolve(webSnapshot());
    await registry.scan();

    expect(published.some((entry) => entry.sessionId === owner.sessionId)).toBe(false);
    expect(registry.list()).toEqual([
      expect.objectContaining({
        sessionId: replacementOwner.sessionId,
        view: expect.objectContaining({ pid: 120, startedAt: 12_000 }),
      }),
    ]);
    registry.stop();
  });

  it('refreshes confirmed URL timestamps and binds them to process identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    let current: WindowsProcessSnapshot = {
      listeners: [{ address: '127.0.0.1', pid: 20, port: 80 }],
      processes: webSnapshot().processes,
    };
    const published = new Map<string, RuntimeWebProcessView[]>();
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      { capture: vi.fn(async () => current), ...inertStops() },
    );

    registry.observeTerminalOutput(owner.sessionId, owner.ptyGeneration, 'http://localhost');
    registry.start(() => [owner]);
    await registry.scan();
    vi.setSystemTime(new Date('2026-08-20T23:00:00.000Z'));
    registry.observeTerminalOutput(owner.sessionId, owner.ptyGeneration, 'http://localhost');
    vi.setSystemTime(new Date('2026-08-21T01:00:00.000Z'));
    await registry.scan();
    expect(published.get(owner.sessionId)?.[0]?.urls).toEqual([
      { confirmed: true, url: 'http://localhost' },
    ]);

    current = { ...current, processes: webSnapshot(4_000).processes };
    await registry.scan();
    expect(published.get(owner.sessionId)?.[0]?.urls).toEqual([
      { confirmed: false, url: 'http://127.0.0.1:80' },
    ]);
    registry.stop();
  });

  it('normalizes IPv6 loopback, LAN, and wildcard listener URLs', async () => {
    const published = new Map<string, RuntimeWebProcessView[]>();
    const current: WindowsProcessSnapshot = {
      listeners: [
        { address: '::1', pid: 20, port: 3_080 },
        { address: '192.168.1.8', pid: 20, port: 4_080 },
        { address: '::', pid: 20, port: 5_080 },
      ],
      processes: webSnapshot().processes,
    };
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      { capture: vi.fn(async () => current), ...inertStops() },
    );

    registry.start(() => [owner]);
    await registry.scan();

    expect(published.get(owner.sessionId)?.[0]).toMatchObject({
      exposureWarning: expect.any(String),
      ports: [3_080, 4_080, 5_080],
      urls: [
        { confirmed: false, url: 'http://[::1]:3080' },
        { confirmed: false, url: 'http://192.168.1.8:4080' },
        { confirmed: false, url: 'http://[::]:5080' },
      ],
    });
    registry.stop();
  });

  it('immediately invalidates a deferred scan when stopped', async () => {
    const capture = deferred<WindowsProcessSnapshot>();
    const captureStarted = deferred<void>();
    const registry = new RuntimeProcessRegistry(() => undefined, {
      capture: vi.fn(() => {
        captureStarted.resolve();
        return capture.promise;
      }),
      ...inertStops(),
    });

    registry.start(() => [owner]);
    await captureStarted.promise;
    const pending = expect(registry.scan()).rejects.toBeInstanceOf(
      RuntimeProcessScanCancelledError,
    );
    registry.stop();
    await pending;
    capture.resolve(webSnapshot());
    await Promise.resolve();
    expect(registry.list()).toEqual([]);
  });
});
