import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedGatewayAuthenticationInspection } from '../../src/main/claude/managed-chatgpt-auth';
import { ManagedChatGptGateway } from '../../src/main/claude/managed-chatgpt-gateway';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { DownloadEngine } from '../../src/main/download/engine';

interface TestGatewayState {
  authorization?: {
    artifactCount: number;
    fingerprint: string;
    provider: 'openai-codex';
    validatedAt: number;
    version: 1;
  };
  encryptedClientKey: string;
  encryptedManagementKey?: string;
  executableRelativePath: string;
  executableSha256: string;
  installedVersion: string;
  port: number;
  process?: {
    identity: { startedAtTicks: string; version: 1 };
    phase: 'ready' | 'starting';
    processId: number;
    version: 1;
  };
  processId?: number;
  releaseDigest: string;
  version: 1;
}

interface ManagedGatewayModelReconciliationInternals {
  availableModels: (
    state: TestGatewayState,
    processId: number,
    credential: string,
    timeoutMs?: number,
  ) => Promise<string[]>;
  rememberModelsForChild: (
    state: TestGatewayState,
    processId: number,
    availableModels: readonly string[],
    expectedChild: {
      exitCode: number | null;
      kill: () => boolean;
      pid: number;
      signalCode: string | null;
    },
  ) => boolean;
}

interface ManagedGatewayReconciliationInternals {
  decryptClientKey: (state: TestGatewayState) => string | undefined;
  decryptManagementKey: (state: TestGatewayState) => string | undefined;
  executableIsValid: (state: TestGatewayState) => boolean;
  inspectAuthentication: () => Promise<ManagedGatewayAuthenticationInspection | undefined>;
  loadState: () => TestGatewayState | undefined;
  modelReconciliation: ManagedGatewayModelReconciliationInternals;
  ownedProcessId: (state: TestGatewayState) => Promise<number | undefined>;
  persistedProcess: {
    promoteReady: (
      state: TestGatewayState,
      authorization: TestGatewayState['authorization'],
    ) => TestGatewayState;
  };
  processLifecycle: {
    complete: (ownership: unknown) => void;
    start: (
      child: {
        exitCode: number | null;
        kill: () => boolean;
        pid: number;
        signalCode: string | null;
      },
      metadata: {
        configSignature: string;
        environmentSignature: string;
        executablePath: string;
      },
    ) => unknown;
    stop: () => unknown;
  };
}

const testAuthentication = (): ManagedGatewayAuthenticationInspection => ({
  artifacts: [
    {
      changedAt: 1,
      filePath: path.resolve('C:\\Users\\Tester\\ClaudeDock\\auth\\codex-user.json'),
      size: 512,
    },
  ],
  manifest: {
    artifactCount: 1,
    fingerprint: 'c'.repeat(64),
    provider: 'openai-codex',
    validatedAt: 1,
    version: 1,
  },
});

const gatewayState = (overrides: Partial<TestGatewayState> = {}): TestGatewayState => {
  const processId = overrides.process?.processId ?? overrides.processId ?? 42;
  return {
    encryptedClientKey: 'encrypted-client-key',
    executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
    executableSha256: 'a'.repeat(64),
    installedVersion: '7.2.117',
    port: 8317,
    process: overrides.process ?? {
      identity: { startedAtTicks: String(638900000000000000n + BigInt(processId)), version: 1 },
      phase: 'ready',
      processId,
      version: 1,
    },
    processId,
    releaseDigest: 'b'.repeat(64),
    version: 1,
    ...overrides,
  };
};

const gatewayChild = (processId: number) => ({
  exitCode: null,
  kill: vi.fn(() => true),
  pid: processId,
  signalCode: null,
});

const createManager = (
  suffix: string,
  fetchImplementation: typeof fetch = vi.fn() as unknown as typeof fetch,
): {
  internals: ManagedGatewayReconciliationInternals;
  manager: ManagedChatGptGateway;
  remove: () => void;
} => {
  const userDataPath = mkdtempSync(
    path.join(tmpdir(), `claudedock-managed-gateway-reconcile-${suffix}-`),
  );
  const manager = new ManagedChatGptGateway(
    userDataPath,
    {} as DownloadEngine,
    new BusyRegistry(),
    {
      decryptString: vi.fn(),
      encryptString: vi.fn(),
      isEncryptionAvailable: vi.fn(() => true),
    },
    fetchImplementation,
  );
  return {
    internals: manager as unknown as ManagedGatewayReconciliationInternals,
    manager,
    remove: () => {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    },
  };
};

const mockOwnedState = (
  internals: ManagedGatewayReconciliationInternals,
  state: TestGatewayState,
  credential: string,
): ReturnType<typeof vi.spyOn> => {
  vi.spyOn(internals, 'loadState').mockReturnValue(state);
  vi.spyOn(internals, 'executableIsValid').mockReturnValue(true);
  vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
  vi.spyOn(internals, 'decryptClientKey').mockReturnValue(credential);
  return vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(state.processId);
};

describe('managed ChatGPT gateway restart reconciliation', () => {
  it('reuses an owned process model cache for public state and management access', async () => {
    const fetchImplementation = vi.fn();
    const { internals, manager, remove } = createManager(
      'cache',
      fetchImplementation as unknown as typeof fetch,
    );
    const state = gatewayState({ encryptedManagementKey: 'encrypted-management-key' });
    vi.spyOn(internals, 'loadState').mockReturnValue(state);
    vi.spyOn(internals, 'executableIsValid').mockReturnValue(true);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'decryptManagementKey').mockReturnValue(
      `mgmt-claudedock-${'m'.repeat(43)}`,
    );
    vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(42);
    const child = gatewayChild(42);
    internals.processLifecycle.start(child, {
      configSignature: 'config-signature',
      environmentSignature: 'environment-signature',
      executablePath: 'C:\\gateway.exe',
    });
    internals.modelReconciliation.rememberModelsForChild(state, 42, ['gpt-5.6-sol'], child);

    try {
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['gpt-5.6-sol'],
        managementAvailable: true,
        phase: 'ready',
        running: true,
      });
      await expect(manager.managementAccess()).resolves.toEqual({
        url: 'http://127.0.0.1:8317/management.html',
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('reconstructs restart models from one bounded probe of the verified owned process', async () => {
    const { internals, manager, remove } = createManager('success');
    const state: TestGatewayState & { availableModels: string[] } = {
      ...gatewayState(),
      availableModels: ['persisted-stale-model'],
    };
    const credential = `sk-claudedock-${'x'.repeat(43)}`;
    const ownedProcessId = mockOwnedState(internals, state, credential);
    const availableModels = vi
      .spyOn(internals.modelReconciliation, 'availableModels')
      .mockResolvedValue(['gpt-5.6-sol', 'gpt-5.4-mini']);

    try {
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['gpt-5.6-sol', 'gpt-5.4-mini'],
        phase: 'ready',
        running: true,
      });
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['gpt-5.6-sol', 'gpt-5.4-mini'],
        phase: 'ready',
        running: true,
      });
      expect(availableModels).toHaveBeenCalledOnce();
      expect(availableModels).toHaveBeenCalledWith(
        expect.objectContaining({ port: 8317 }),
        42,
        credential,
        8_000,
      );
      expect(ownedProcessId).toHaveBeenCalledTimes(3);
    } finally {
      remove();
    }
  });

  it('atomically promotes a reconciled persisted starting record after restart', async () => {
    const { internals, manager, remove } = createManager('starting-ready');
    const state = gatewayState({
      authorization: testAuthentication().manifest,
      process: {
        identity: { startedAtTicks: '638900000000000042', version: 1 },
        phase: 'starting',
        processId: 42,
        version: 1,
      },
    });
    mockOwnedState(internals, state, `sk-claudedock-${'r'.repeat(43)}`);
    vi.spyOn(internals.modelReconciliation, 'availableModels').mockResolvedValue(['gpt-5.6-sol']);
    const promoteReady = vi.spyOn(internals.persistedProcess, 'promoteReady').mockReturnValue({
      ...state,
      process: { ...state.process!, phase: 'ready' },
    });

    try {
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['gpt-5.6-sol'],
        phase: 'ready',
        running: true,
      });
      expect(promoteReady).toHaveBeenCalledOnce();
      expect(promoteReady).toHaveBeenCalledWith(state, state.authorization);
    } finally {
      remove();
    }
  });

  it('keeps a restart starting record degraded when atomic ready promotion fails', async () => {
    const { internals, manager, remove } = createManager('starting-promotion-failure');
    const state = gatewayState({
      authorization: testAuthentication().manifest,
      process: {
        identity: { startedAtTicks: '638900000000000042', version: 1 },
        phase: 'starting',
        processId: 42,
        version: 1,
      },
    });
    mockOwnedState(internals, state, `sk-claudedock-${'f'.repeat(43)}`);
    vi.spyOn(internals.modelReconciliation, 'availableModels').mockResolvedValue(['gpt-5.6-sol']);
    vi.spyOn(internals.persistedProcess, 'promoteReady').mockImplementation(() => {
      throw new Error('injected atomic ready rename failure');
    });

    try {
      const publicState = await manager.getState();
      expect(publicState).toMatchObject({
        availableModels: [],
        phase: 'stopped',
        running: false,
      });
      expect(publicState.message).toContain('模型接口未通过就绪检查');
      expect(state.process?.phase).toBe('starting');
    } finally {
      remove();
    }
  });

  it('rejects stale model state when the bounded restart probe fails without exposing auth data', async () => {
    const { internals, manager, remove } = createManager('failed');
    const state: TestGatewayState & { availableModels: string[] } = {
      ...gatewayState(),
      availableModels: ['persisted-stale-model'],
    };
    const credential = `sk-claudedock-${'s'.repeat(43)}`;
    mockOwnedState(internals, state, credential);
    const availableModels = vi
      .spyOn(internals.modelReconciliation, 'availableModels')
      .mockRejectedValue(new Error(`probe failed with ${credential}`));
    try {
      const publicState = await manager.getState();
      expect(publicState).toMatchObject({
        availableModels: [],
        managementAvailable: false,
        phase: 'stopped',
        running: false,
      });
      expect(publicState.message).toContain('模型接口未通过就绪检查');
      expect(JSON.stringify(publicState)).not.toContain(credential);
      expect(JSON.stringify(publicState)).not.toContain('persisted-stale-model');
      expect(JSON.stringify(publicState)).not.toContain('process-local-stale-model');
      expect(availableModels).toHaveBeenCalledWith(
        expect.objectContaining({ port: 8317 }),
        42,
        credential,
        8_000,
      );
    } finally {
      remove();
    }
  });

  it('reports a timed-out stopping child as degraded without probing it again', async () => {
    const fetchImplementation = vi.fn();
    const { internals, manager, remove } = createManager(
      'stopping-child',
      fetchImplementation as unknown as typeof fetch,
    );
    const state = gatewayState();
    vi.spyOn(internals, 'loadState').mockReturnValue(state);
    vi.spyOn(internals, 'executableIsValid').mockReturnValue(true);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    const child = {
      exitCode: null,
      kill: vi.fn(() => true),
      pid: 42,
      signalCode: null,
    };
    internals.processLifecycle.start(child, {
      configSignature: 'config-signature',
      environmentSignature: 'environment-signature',
      executablePath: 'C:\\gateway.exe',
    });
    internals.processLifecycle.stop();

    try {
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: [],
        phase: 'stopped',
        running: false,
      });
      expect((await manager.getState()).message).toContain('模型接口未通过就绪检查');
      expect(fetchImplementation).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('discards a successful restart probe when process ownership becomes stale', async () => {
    const { internals, manager, remove } = createManager('stale-owner');
    const state = gatewayState();
    vi.spyOn(internals, 'loadState').mockReturnValue(state);
    vi.spyOn(internals, 'executableIsValid').mockReturnValue(true);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'decryptClientKey').mockReturnValue(`sk-claudedock-${'x'.repeat(43)}`);
    vi.spyOn(internals.modelReconciliation, 'availableModels').mockResolvedValue(['gpt-5.6-sol']);
    vi.spyOn(internals, 'ownedProcessId')
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(undefined);

    try {
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: [],
        managementAvailable: false,
        phase: 'stopped',
        running: false,
      });
    } finally {
      remove();
    }
  });

  it('does not let a stale restart probe replace models from a replacement process', async () => {
    const { internals, manager, remove } = createManager('replacement');
    const oldState = gatewayState({
      encryptedClientKey: 'old-encrypted-client-key',
      process: {
        identity: { startedAtTicks: '638900000000000042', version: 1 },
        phase: 'starting',
        processId: 42,
        version: 1,
      },
    });
    const replacementState = gatewayState({
      encryptedClientKey: 'replacement-encrypted-client-key',
      processId: 43,
    });
    let currentState = oldState;
    vi.spyOn(internals, 'loadState').mockImplementation(() => currentState);
    vi.spyOn(internals, 'executableIsValid').mockReturnValue(true);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'decryptClientKey').mockImplementation((state) =>
      state.processId === 42
        ? `sk-claudedock-${'o'.repeat(43)}`
        : `sk-claudedock-${'n'.repeat(43)}`,
    );
    vi.spyOn(internals, 'ownedProcessId').mockImplementation(async (state) => state.processId);
    let resolveOldProbe!: (models: string[]) => void;
    const oldProbe = new Promise<string[]>((resolve) => {
      resolveOldProbe = resolve;
    });
    const availableModels = vi
      .spyOn(internals.modelReconciliation, 'availableModels')
      .mockReturnValueOnce(oldProbe)
      .mockResolvedValueOnce(['replacement-model']);
    const promoteReady = vi.spyOn(internals.persistedProcess, 'promoteReady');

    try {
      const staleState = manager.getState();
      await vi.waitFor(() => {
        expect(availableModels).toHaveBeenCalledOnce();
      });
      currentState = replacementState;
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['replacement-model'],
        phase: 'ready',
        running: true,
      });

      resolveOldProbe(['stale-old-model']);
      await expect(staleState).resolves.toMatchObject({
        availableModels: [],
        phase: 'stopped',
        running: false,
      });
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['replacement-model'],
        phase: 'ready',
        running: true,
      });
      expect(availableModels).toHaveBeenCalledTimes(2);
      expect(promoteReady).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('does not let a stale reader evict a replacement cache published before it resumes', async () => {
    const { internals, manager, remove } = createManager('stale-reader');
    const oldState = gatewayState({ encryptedClientKey: 'old-encrypted-client-key' });
    const replacementState = gatewayState({
      encryptedClientKey: 'replacement-encrypted-client-key',
      processId: 43,
    });
    let currentState = oldState;
    let releaseOldInspection!: (value: ManagedGatewayAuthenticationInspection) => void;
    const oldInspection = new Promise<ManagedGatewayAuthenticationInspection>((resolve) => {
      releaseOldInspection = resolve;
    });
    vi.spyOn(internals, 'loadState').mockImplementation(() => currentState);
    vi.spyOn(internals, 'executableIsValid').mockReturnValue(true);
    const inspectAuthentication = vi
      .spyOn(internals, 'inspectAuthentication')
      .mockReturnValueOnce(oldInspection)
      .mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'decryptClientKey').mockImplementation((state) =>
      state.process?.processId === 42
        ? `sk-claudedock-${'o'.repeat(43)}`
        : `sk-claudedock-${'n'.repeat(43)}`,
    );
    vi.spyOn(internals, 'ownedProcessId').mockImplementation(
      async (state) => state.process?.processId,
    );
    const availableModels = vi
      .spyOn(internals.modelReconciliation, 'availableModels')
      .mockImplementation(async (_state, processId) =>
        processId === 42 ? ['stale-old-model'] : ['replacement-model'],
      );

    try {
      const staleRead = manager.getState();
      await vi.waitFor(() => expect(inspectAuthentication).toHaveBeenCalledOnce());
      currentState = replacementState;
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['replacement-model'],
        phase: 'ready',
        running: true,
      });

      releaseOldInspection(testAuthentication());
      await expect(staleRead).resolves.toMatchObject({
        availableModels: [],
        phase: 'stopped',
        running: false,
      });
      await expect(manager.getState()).resolves.toMatchObject({
        availableModels: ['replacement-model'],
        phase: 'ready',
        running: true,
      });
      expect(availableModels).toHaveBeenCalledOnce();
      expect(availableModels).toHaveBeenCalledWith(
        expect.objectContaining({ process: expect.objectContaining({ processId: 43 }) }),
        43,
        expect.any(String),
        8_000,
      );
    } finally {
      remove();
    }
  });

  it('shares one authoritative probe across concurrent readers of the same ownership', async () => {
    const { internals, manager, remove } = createManager('shared-probe');
    const state = gatewayState();
    mockOwnedState(internals, state, `sk-claudedock-${'q'.repeat(43)}`);
    let resolveProbe!: (models: string[]) => void;
    const pendingProbe = new Promise<string[]>((resolve) => {
      resolveProbe = resolve;
    });
    const availableModels = vi
      .spyOn(internals.modelReconciliation, 'availableModels')
      .mockReturnValue(pendingProbe);

    try {
      const first = manager.getState();
      const second = manager.getState();
      await vi.waitFor(() => expect(availableModels).toHaveBeenCalledOnce());
      resolveProbe(['gpt-5.6-sol']);
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ availableModels: ['gpt-5.6-sol'], running: true }),
        expect.objectContaining({ availableModels: ['gpt-5.6-sol'], running: true }),
      ]);
      expect(availableModels).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
  });

  it.each([{ failure: 'malformed' }, { failure: 'failed' }, { failure: 'timeout' }])(
    'keeps restart state degraded after a $failure models probe',
    async ({ failure }) => {
      const { internals, manager, remove } = createManager('probe-failure');
      const state: TestGatewayState & { availableModels: string[] } = {
        ...gatewayState(),
        availableModels: ['persisted-stale-model'],
      };
      const credential = `sk-claudedock-${'p'.repeat(43)}`;
      mockOwnedState(internals, state, credential);
      const availableModels = vi
        .spyOn(internals.modelReconciliation, 'availableModels')
        .mockRejectedValue(new Error(`${failure} probe failed with ${credential}`));

      try {
        const publicState = await manager.getState();
        expect(publicState).toMatchObject({
          availableModels: [],
          managementAvailable: false,
          phase: 'stopped',
          running: false,
        });
        expect(publicState.message).toContain('模型接口未通过就绪检查');
        expect(JSON.stringify(publicState)).not.toContain(credential);
        expect(JSON.stringify(publicState)).not.toContain('persisted-stale-model');
        expect(availableModels).toHaveBeenCalledOnce();
        expect(availableModels).toHaveBeenCalledWith(
          expect.objectContaining({ port: 8317 }),
          42,
          credential,
          8_000,
        );
      } finally {
        remove();
      }
    },
  );
});
