import type { ChildProcess, spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ManagedChatGptGateway } from '../../src/main/claude/managed-chatgpt-gateway';
import type { ManagedGatewayProcessBirthIdentity } from '../../src/main/claude/managed-chatgpt-process-identity';
import type { ManagedGatewaySpawnedProcessOwnership } from '../../src/main/claude/managed-chatgpt-process-lifecycle';
import type { PersistedGatewayState } from '../../src/main/claude/managed-chatgpt-state';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { DownloadEngine } from '../../src/main/download/engine';

class FakeChildProcess extends EventEmitter {
  public exitCode: number | null = null;
  public readonly kill = vi.fn(() => true);
  public readonly stderr = new PassThrough();
  public readonly stdout = new PassThrough();
  public signalCode: NodeJS.Signals | null = null;

  public constructor(public readonly pid: number | undefined) {
    super();
  }
}

const identity: ManagedGatewayProcessBirthIdentity = {
  startedAtTicks: '638900000000000042',
  version: 1,
};

const state = (process?: PersistedGatewayState['process']): PersistedGatewayState => ({
  encryptedClientKey: 'encrypted-client-key',
  executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
  executableSha256: 'a'.repeat(64),
  installedVersion: '7.2.117',
  port: 0,
  ...(process ? { process } : {}),
  releaseDigest: 'b'.repeat(64),
  version: 1,
});

const startingState = (processId = 42): PersistedGatewayState =>
  state({ identity, phase: 'starting', processId, version: 1 });

const snapshot = { environment: {}, signature: 'environment-signature' };

interface StartupInternals {
  controlledRuntimeDirectory: () => string;
  decryptClientKey: (state: PersistedGatewayState) => string | undefined;
  environmentSnapshot: () => typeof snapshot;
  modelReconciliation: {
    probeReadiness: (
      state: PersistedGatewayState,
      processId: number,
      credential: string,
      timeoutMs?: number,
    ) => Promise<{ availableModels: string[]; failure?: unknown }>;
    rememberModelsForChild: (
      state: PersistedGatewayState,
      processId: number,
      models: string[],
      child: ChildProcess,
    ) => boolean;
  };
  ownedProcessId: (state: PersistedGatewayState) => Promise<number | undefined>;
  persistedProcess: {
    clearOwnership: (ownership: NonNullable<PersistedGatewayState['process']>) => boolean;
    persistStarting: (
      state: PersistedGatewayState,
      processId: number,
      identity: ManagedGatewayProcessBirthIdentity,
    ) => PersistedGatewayState;
    stop: (state: PersistedGatewayState, occupiedPortMessage: string) => Promise<boolean>;
  };
  processIdentity: {
    capture: (descriptor: {
      configPath: string;
      executablePath: string;
      port: number;
      processId: number;
    }) => Promise<ManagedGatewayProcessBirthIdentity | undefined>;
    terminate: (
      descriptor: {
        configPath: string;
        executablePath: string;
        identity: ManagedGatewayProcessBirthIdentity;
        port: number;
        processId: number;
      },
      timeoutMs?: number,
    ) => Promise<'inaccessible' | 'mismatch' | 'terminated' | 'timeout'>;
  };
  processLifecycle: {
    complete: (ownership: ManagedGatewaySpawnedProcessOwnership) => void;
    currentOwnership: () => ManagedGatewaySpawnedProcessOwnership | undefined;
    start: (
      child: ChildProcess,
      metadata: {
        configSignature: string;
        environmentSignature: string;
        executablePath: string;
      },
    ) => ManagedGatewaySpawnedProcessOwnership;
    stop: () => ManagedGatewaySpawnedProcessOwnership | undefined;
  };
  start: (
    prepared: { config: string; configSignature: string; state: PersistedGatewayState },
    configPath: string,
    activeSnapshot: typeof snapshot,
    signal?: AbortSignal,
  ) => Promise<PersistedGatewayState>;
  stopProcessesForState: (
    state: PersistedGatewayState,
    occupiedPortMessage: string,
  ) => Promise<void>;
}

const createFixture = (child: FakeChildProcess) => {
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-gateway-startup-'));
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  const manager = new ManagedChatGptGateway(
    userDataPath,
    {} as DownloadEngine,
    new BusyRegistry(),
    {
      decryptString: vi.fn(),
      encryptString: vi.fn(),
      isEncryptionAvailable: vi.fn(() => true),
    },
    vi.fn() as unknown as typeof fetch,
    () => ({}),
    undefined,
    spawn as unknown as typeof spawnProcess,
  );
  const internals = manager as unknown as StartupInternals;
  vi.spyOn(internals, 'controlledRuntimeDirectory').mockReturnValue(userDataPath);
  vi.spyOn(internals, 'decryptClientKey').mockReturnValue('local-client-credential');
  vi.spyOn(internals, 'environmentSnapshot').mockReturnValue(snapshot);
  vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(undefined);
  return {
    internals,
    manager,
    remove: () => {
      const ownership = internals.processLifecycle.currentOwnership();
      if (ownership) internals.processLifecycle.complete(ownership);
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    },
    spawn,
  };
};

const prepared = {
  config: 'config',
  configSignature: 'config-signature',
  state: state(),
};

describe('managed gateway transactional child startup', () => {
  it('completes the stopping-process barrier before any authenticated probe or replacement spawn', async () => {
    const replacementChild = new FakeChildProcess(undefined);
    const oldChild = new FakeChildProcess(41);
    const { internals, remove, spawn } = createFixture(replacementChild);
    const oldOwnership = internals.processLifecycle.start(oldChild as unknown as ChildProcess, {
      configSignature: 'old-config',
      environmentSignature: 'old-environment',
      executablePath: path.resolve('old-gateway.exe'),
    });
    internals.processLifecycle.stop();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    vi.spyOn(internals, 'stopProcessesForState').mockImplementation(async () => {
      await barrier;
      oldChild.exitCode = 0;
      internals.processLifecycle.complete(oldOwnership);
    });
    const probe = vi.spyOn(internals.modelReconciliation, 'probeReadiness');

    try {
      const startup = internals.start(prepared, path.resolve('config.yaml'), snapshot);
      await vi.waitFor(() => expect(internals.stopProcessesForState).toHaveBeenCalledOnce());
      expect(probe).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();

      releaseBarrier();
      await expect(startup).rejects.toThrow('没有返回有效进程标识');
      expect(probe).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
  });

  it('blocks retry and authenticated probing when the stopping-process barrier times out', async () => {
    const replacementChild = new FakeChildProcess(undefined);
    const oldChild = new FakeChildProcess(41);
    const { internals, remove, spawn } = createFixture(replacementChild);
    internals.processLifecycle.start(oldChild as unknown as ChildProcess, {
      configSignature: 'old-config',
      environmentSignature: 'old-environment',
      executablePath: path.resolve('old-gateway.exe'),
    });
    internals.processLifecycle.stop();
    vi.spyOn(internals, 'stopProcessesForState').mockRejectedValue(
      new Error('injected stopping barrier timeout'),
    );
    const probe = vi.spyOn(internals.modelReconciliation, 'probeReadiness');

    try {
      await expect(
        internals.start(prepared, path.resolve('config.yaml'), snapshot),
      ).rejects.toThrow('injected stopping barrier timeout');
      expect(probe).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(internals.processLifecycle.currentOwnership()?.child).toBe(oldChild);
    } finally {
      remove();
    }
  });

  it('consumes an asynchronous pre-spawn error when no PID was assigned', async () => {
    const child = new FakeChildProcess(undefined);
    const { internals, remove, spawn } = createFixture(child);

    try {
      await expect(
        internals.start(prepared, path.resolve('config.yaml'), snapshot),
      ).rejects.toThrow('没有返回有效进程标识');
      expect(spawn).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.listenerCount('error')).toBe(1);
      expect(() => child.emit('error', new Error('asynchronous spawn failure'))).not.toThrow();
      expect(internals.processLifecycle.currentOwnership()).toBeUndefined();
    } finally {
      remove();
    }
  });

  it('does not treat a post-spawn error event as proof that the exact child exited', async () => {
    const child = new FakeChildProcess(42);
    const { internals, remove } = createFixture(child);
    vi.spyOn(internals.processIdentity, 'capture').mockResolvedValue(identity);
    vi.spyOn(internals.persistedProcess, 'persistStarting').mockReturnValue(startingState());
    vi.spyOn(internals.persistedProcess, 'clearOwnership').mockReturnValue(true);
    vi.spyOn(internals.persistedProcess, 'stop').mockResolvedValue(true);
    let releaseProbe!: (result: { availableModels: string[]; failure?: unknown }) => void;
    vi.spyOn(internals.modelReconciliation, 'probeReadiness').mockImplementation(
      () =>
        new Promise<{ availableModels: string[]; failure?: unknown }>((resolve) => {
          releaseProbe = resolve;
        }),
    );

    try {
      const startup = internals.start(prepared, path.resolve('config.yaml'), snapshot);
      await vi.waitFor(() => expect(releaseProbe).toBeTypeOf('function'));
      child.emit('error', new Error('post-spawn transport error'));
      expect(internals.processLifecycle.currentOwnership()?.child).toBe(child);

      child.exitCode = 1;
      child.emit('exit', 1, null);
      releaseProbe({ availableModels: [] });
      await expect(startup).rejects.toThrow('未能在 20 秒内完成');
      expect(internals.processLifecycle.currentOwnership()).toBeUndefined();
    } finally {
      remove();
    }
  });

  it('uses the bounded production readiness budget and reports a sanitized probe failure', async () => {
    const child = new FakeChildProcess(42);
    const { internals, remove } = createFixture(child);
    const credential = `sk-claudedock-${'r'.repeat(43)}`;
    vi.spyOn(internals, 'decryptClientKey').mockReturnValue(credential);
    vi.spyOn(internals.processIdentity, 'capture').mockResolvedValue(identity);
    vi.spyOn(internals.persistedProcess, 'persistStarting').mockReturnValue(startingState());
    vi.spyOn(internals, 'stopProcessesForState').mockResolvedValue();
    const probe = vi
      .spyOn(internals.modelReconciliation, 'probeReadiness')
      .mockImplementation(async () => {
        child.exitCode = 1;
        return {
          availableModels: [],
          failure: new Error(`post-response identity timeout ${credential}`),
        };
      });

    try {
      const failure = await internals
        .start(prepared, path.resolve('config.yaml'), snapshot)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('模型检查：post-response identity timeout [已隐藏]');
      expect(String(failure)).not.toContain(credential);
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({ process: expect.objectContaining({ processId: 42 }) }),
        42,
        credential,
        8_000,
      );
    } finally {
      remove();
    }
  });

  it('keeps a full-budget probe failure when a truncated tail probe fails afterward', async () => {
    const child = new FakeChildProcess(42);
    const { internals, remove } = createFixture(child);
    const credential = `sk-claudedock-${'f'.repeat(43)}`;
    vi.spyOn(internals, 'decryptClientKey').mockReturnValue(credential);
    vi.spyOn(internals.processIdentity, 'capture').mockResolvedValue(identity);
    vi.spyOn(internals.persistedProcess, 'persistStarting').mockReturnValue(startingState());
    vi.spyOn(internals, 'stopProcessesForState').mockResolvedValue();
    let now = 10_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const probe = vi
      .spyOn(internals.modelReconciliation, 'probeReadiness')
      .mockImplementationOnce(async () => {
        now = 22_500;
        return {
          availableModels: [],
          failure: new Error(`full-budget HTTP 401 ${credential}`),
        };
      })
      .mockImplementationOnce(async () => {
        child.exitCode = 1;
        return {
          availableModels: [],
          failure: new Error(`truncated-tail timeout ${credential}`),
        };
      });

    try {
      const failure = await internals
        .start(prepared, path.resolve('config.yaml'), snapshot)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('模型检查：full-budget HTTP 401 [已隐藏]');
      expect(String(failure)).not.toContain('truncated-tail timeout');
      expect(String(failure)).not.toContain(credential);
      expect(probe.mock.calls.map((call) => call[3])).toEqual([8_000, 7_500]);
    } finally {
      dateNow.mockRestore();
      remove();
    }
  });

  it('combines and sanitizes readiness and cleanup failures', async () => {
    const child = new FakeChildProcess(42);
    const { internals, remove } = createFixture(child);
    const credential = `sk-claudedock-${'c'.repeat(43)}`;
    const cleanupCredential = `sk-cleanup-${'d'.repeat(43)}`;
    vi.spyOn(internals, 'decryptClientKey').mockReturnValue(credential);
    vi.spyOn(internals.processIdentity, 'capture').mockResolvedValue(identity);
    vi.spyOn(internals.persistedProcess, 'persistStarting').mockReturnValue(startingState());
    vi.spyOn(internals, 'stopProcessesForState').mockRejectedValue(
      new Error(`cleanup transport failed ${cleanupCredential}`),
    );
    vi.spyOn(internals.modelReconciliation, 'probeReadiness').mockImplementation(async () => {
      child.exitCode = 1;
      return {
        availableModels: [],
        failure: new Error(`readiness HTTP 503 ${credential}`),
      };
    });

    try {
      const failure = await internals
        .start(prepared, path.resolve('config.yaml'), snapshot)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('模型检查：readiness HTTP 503 [已隐藏]');
      expect(String(failure)).toContain(
        '启动失败后的本机网关清理也未完成：cleanup transport failed [已隐藏]',
      );
      expect(String(failure)).not.toContain(credential);
      expect(String(failure)).not.toContain(cleanupCredential);
      expect((failure as Error).cause).toBeInstanceOf(Error);
      expect(((failure as Error).cause as Error).message).toContain(
        'cleanup transport failed [已隐藏]',
      );
      expect(((failure as Error).cause as Error).message).not.toContain(credential);
      expect(((failure as Error).cause as Error).message).not.toContain(cleanupCredential);
    } finally {
      remove();
    }
  });

  it('terminates a PID-bearing child when its exact birth identity cannot be captured', async () => {
    const child = new FakeChildProcess(42);
    child.kill.mockImplementation(() => {
      child.exitCode = 1;
      return true;
    });
    const { internals, remove } = createFixture(child);
    vi.spyOn(internals.processIdentity, 'capture').mockResolvedValue(undefined);
    const persistStarting = vi.spyOn(internals.persistedProcess, 'persistStarting');

    try {
      await expect(
        internals.start(prepared, path.resolve('config.yaml'), snapshot),
      ).rejects.toThrow('启动进程身份无法确认');
      expect(child.kill).toHaveBeenCalledOnce();
      expect(persistStarting).not.toHaveBeenCalled();
      expect(internals.processLifecycle.currentOwnership()).toBeUndefined();
    } finally {
      remove();
    }
  });

  it('uses exact identity termination when the starting ownership commit fails', async () => {
    const child = new FakeChildProcess(42);
    const { internals, remove } = createFixture(child);
    vi.spyOn(internals.processIdentity, 'capture').mockResolvedValue(identity);
    vi.spyOn(internals.persistedProcess, 'persistStarting').mockImplementation(() => {
      throw new Error('injected atomic state rename failure');
    });
    const terminate = vi
      .spyOn(internals.processIdentity, 'terminate')
      .mockImplementation(async () => {
        child.exitCode = 1;
        return 'terminated';
      });

    try {
      await expect(
        internals.start(prepared, path.resolve('config.yaml'), snapshot),
      ).rejects.toThrow('启动所有权无法安全保存');
      expect(terminate).toHaveBeenCalledWith(
        expect.objectContaining({ identity, port: 0, processId: 42 }),
      );
      expect(internals.processLifecycle.currentOwnership()).toBeUndefined();
    } finally {
      remove();
    }
  });
});
