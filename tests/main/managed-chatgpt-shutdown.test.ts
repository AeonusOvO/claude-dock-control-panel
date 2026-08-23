import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedChatGptGateway } from '../../src/main/claude/managed-chatgpt-gateway';
import type { PersistedGatewayState } from '../../src/main/claude/managed-chatgpt-state';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { DownloadEngine } from '../../src/main/download/engine';

const processOwnership = (processId: number): NonNullable<PersistedGatewayState['process']> => ({
  identity: { startedAtTicks: String(638900000000000000n + BigInt(processId)), version: 1 },
  phase: 'ready',
  processId,
  version: 1,
});

const gatewayState = (processId?: number): PersistedGatewayState => ({
  encryptedClientKey: 'encrypted-client-key',
  executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
  executableSha256: 'a'.repeat(64),
  installedVersion: '7.2.117',
  port: 8317,
  ...(processId ? { process: processOwnership(processId) } : {}),
  releaseDigest: 'b'.repeat(64),
  version: 1,
});

interface ShutdownInternals {
  environmentSnapshot: () => { environment: NodeJS.ProcessEnv; signature: string };
  inspectAuthentication: () => Promise<unknown>;
  installLatest: () => Promise<PersistedGatewayState | undefined>;
  loadState: () => PersistedGatewayState | undefined;
  modelReconciliation: {
    projectConfiguration: (state: PersistedGatewayState) => Promise<{
      availableModels: string[];
      baseUrl: string;
      credential: string;
      model: string;
      modelFast: string;
    }>;
  };
  persistedProcess: {
    stop: (state: PersistedGatewayState, occupiedPortMessage: string) => Promise<boolean>;
  };
  prepareConfiguration: (state: PersistedGatewayState | undefined) => Promise<{
    config: string;
    configSignature: string;
    state: PersistedGatewayState;
  }>;
  processLifecycle: {
    currentOwnership: () => unknown;
    start: (
      child: ChildProcess,
      metadata: {
        configSignature: string;
        environmentSignature: string;
        executablePath: string;
      },
    ) => unknown;
  };
  startWithStableEnvironment: (
    prepared: { config: string; configSignature: string; state: PersistedGatewayState },
    beforeStart?: (
      configPath: string,
      snapshot: { environment: NodeJS.ProcessEnv; signature: string },
    ) => Promise<void>,
    signal?: AbortSignal,
  ) => Promise<PersistedGatewayState>;
}

const createManager = (runProcessImplementation?: never) => {
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-gateway-shutdown-'));
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
    runProcessImplementation,
  );
  return {
    internals: manager as unknown as ShutdownInternals,
    manager,
    remove: () => {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    },
    userDataPath,
  };
};

const localChild = (processId: number): ChildProcess =>
  ({
    exitCode: null,
    kill: vi.fn(() => true),
    pid: processId,
    signalCode: null,
  }) as unknown as ChildProcess;

afterEach(() => {
  vi.useRealTimers();
});

describe('managed gateway shutdown ownership', () => {
  it('terminates reconciled persisted ownership even when there is no local ChildProcess', async () => {
    const { internals, manager, remove } = createManager();
    let current = gatewayState(42);
    vi.spyOn(internals, 'loadState').mockImplementation(() => current);
    const stopPersisted = vi
      .spyOn(internals.persistedProcess, 'stop')
      .mockImplementation(async () => {
        current = { ...current, process: undefined };
        return true;
      });

    try {
      await expect(manager.shutdownForQuit()).resolves.toBe(true);
      await expect(manager.shutdownForQuit()).resolves.toBe(true);
      expect(stopPersisted).toHaveBeenCalledOnce();
      expect(stopPersisted).toHaveBeenCalledWith(
        expect.objectContaining({ process: processOwnership(42) }),
        '退出时托管网关端口未能及时释放。',
      );
    } finally {
      remove();
    }
  });

  it('reports residual persisted ownership after bounded exact termination failure', async () => {
    const { internals, manager, remove } = createManager();
    const current = gatewayState(42);
    vi.spyOn(internals, 'loadState').mockReturnValue(current);
    vi.spyOn(internals.persistedProcess, 'stop').mockRejectedValue(
      new Error('injected exact termination timeout'),
    );

    try {
      await expect(manager.shutdownForQuit()).resolves.toBe(false);
      expect(current.process?.processId).toBe(42);
    } finally {
      remove();
    }
  });

  it('awaits an unpersisted local child exit and reports a timeout as residual ownership', async () => {
    vi.useFakeTimers();
    const first = createManager();
    vi.spyOn(first.internals, 'loadState').mockReturnValue(undefined);
    const exitingChild = localChild(42);
    first.internals.processLifecycle.start(exitingChild, {
      configSignature: 'config',
      environmentSignature: 'environment',
      executablePath: 'C:\\gateway.exe',
    });

    const cleanShutdown = first.manager.shutdownForQuit();
    expect(exitingChild.kill).toHaveBeenCalledOnce();
    (exitingChild as unknown as { exitCode: number | null }).exitCode = 0;
    await vi.advanceTimersByTimeAsync(100);
    await expect(cleanShutdown).resolves.toBe(true);
    expect(first.internals.processLifecycle.currentOwnership()).toBeUndefined();
    first.remove();

    const second = createManager();
    vi.spyOn(second.internals, 'loadState').mockReturnValue(undefined);
    const stuckChild = localChild(43);
    second.internals.processLifecycle.start(stuckChild, {
      configSignature: 'config',
      environmentSignature: 'environment',
      executablePath: 'C:\\gateway.exe',
    });
    const residualShutdown = second.manager.shutdownForQuit();
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(residualShutdown).resolves.toBe(false);
    expect(stuckChild.kill).toHaveBeenCalledOnce();
    second.remove();
  });

  it('queues a later setup as a fresh generation after stop invalidates the current setup', async () => {
    const { internals, manager, remove } = createManager();
    const installed = gatewayState();
    const ready = gatewayState(42);
    const prepared = { config: 'config', configSignature: 'signature', state: installed };
    vi.spyOn(internals, 'installLatest').mockResolvedValue(installed);
    vi.spyOn(internals, 'prepareConfiguration').mockResolvedValue(prepared);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue({ authenticated: true });
    vi.spyOn(internals, 'loadState').mockReturnValue(undefined);
    vi.spyOn(internals.modelReconciliation, 'projectConfiguration').mockResolvedValue({
      availableModels: ['gpt-5.6-sol'],
      baseUrl: 'http://127.0.0.1:8317',
      credential: 'local-client-key',
      model: 'gpt-5.6-sol',
      modelFast: 'gpt-5.4-mini',
    });
    let firstSignal: AbortSignal | undefined;
    let attempts = 0;
    const start = vi
      .spyOn(internals, 'startWithStableEnvironment')
      .mockImplementation(async (_activePrepared, _beforeStart, signal) => {
        attempts += 1;
        if (attempts > 1) return ready;
        firstSignal = signal;
        return new Promise<PersistedGatewayState>((_resolve, reject) => {
          const rejectForAbort = (): void => reject(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) rejectForAbort();
          else signal?.addEventListener('abort', rejectForAbort, { once: true });
        });
      });

    try {
      const obsoleteSetup = manager.setup();
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      const stop = manager.stop();
      const replacementSetup = manager.setup();
      expect(replacementSetup).not.toBe(obsoleteSetup);
      expect(firstSignal?.aborted).toBe(true);

      await expect(obsoleteSetup).rejects.toThrow();
      await expect(stop).resolves.toBeUndefined();
      await expect(replacementSetup).resolves.toMatchObject({ model: 'gpt-5.6-sol' });
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      remove();
    }
  });

  it('aborts an in-flight OAuth subprocess before the queued stop completes', async () => {
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn(
      async (
        _executable: string,
        _argumentsList: string[],
        _environment: NodeJS.ProcessEnv,
        options: { signal?: AbortSignal },
      ) =>
        new Promise<{ stderr: string; stdout: string }>((_resolve, reject) => {
          observedSignal = options.signal;
          const rejectForAbort = (): void => reject(options.signal?.reason ?? new Error('aborted'));
          if (options.signal?.aborted) rejectForAbort();
          else options.signal?.addEventListener('abort', rejectForAbort, { once: true });
        }),
    );
    const { internals, manager, remove, userDataPath } = createManager(run as never);
    const root = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    mkdirSync(path.join(root, 'auth'), { recursive: true });
    const state = gatewayState();
    const prepared = { config: 'config', configSignature: 'signature', state };
    vi.spyOn(internals, 'installLatest').mockResolvedValue(state);
    vi.spyOn(internals, 'prepareConfiguration').mockResolvedValue(prepared);
    vi.spyOn(internals, 'startWithStableEnvironment').mockImplementation(
      async (_prepared, beforeStart) => {
        const snapshot = internals.environmentSnapshot();
        await beforeStart?.(path.join(root, 'config.yaml'), snapshot);
        return state;
      },
    );

    try {
      const setup = manager.setup(true);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      const stop = manager.stop();
      await expect(setup).rejects.toThrow('OpenAI 授权已取消');
      await expect(stop).resolves.toBeUndefined();
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      remove();
    }
  });
});
