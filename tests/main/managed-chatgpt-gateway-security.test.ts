import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ManagedGatewayAuthenticationTransaction } from '../../src/main/claude/managed-chatgpt-auth-transaction';
import { ManagedChatGptGateway } from '../../src/main/claude/managed-chatgpt-gateway';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { DownloadEngine } from '../../src/main/download/engine';

interface TestGatewayState {
  encryptedClientKey: string;
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
  releaseDigest: string;
  version: 1;
}

const testProcess = (
  processId: number,
  phase: 'ready' | 'starting' = 'ready',
): NonNullable<TestGatewayState['process']> => ({
  identity: { startedAtTicks: String(638900000000000000n + BigInt(processId)), version: 1 },
  phase,
  processId,
  version: 1,
});

const writeAccount = (filePath: string, account: string): void => {
  writeFileSync(
    filePath,
    JSON.stringify({
      access_token: `access-${account}`,
      account_id: account,
      disabled: false,
      email: `${account}@example.com`,
      expired: '2027-08-20T00:00:00Z',
      id_token: `identity-${account}`,
      last_refresh: '2026-08-20T00:00:00Z',
      refresh_token: `refresh-${account}`,
      type: 'codex',
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
};

const accountValues = (authDirectory: string): string[] =>
  readdirSync(authDirectory)
    .filter((name) => /^codex-.+\.json$/i.test(name))
    .map(
      (name) =>
        (JSON.parse(readFileSync(path.join(authDirectory, name), 'utf8')) as { account_id: string })
          .account_id,
    )
    .sort();

interface TestPreparedGatewayConfiguration {
  config: string;
  configSignature: string;
  state: TestGatewayState;
}

interface TestEnvironmentSnapshot {
  environment: NodeJS.ProcessEnv;
  signature: string;
}

interface ManagedGatewaySecurityInternals {
  activateConfiguration: (pendingConfigPath: string) => Promise<{
    committed: boolean;
  }>;
  assertEnvironmentCurrent: (snapshot: TestEnvironmentSnapshot) => void;
  commitConfiguration: (
    transaction: { committed: boolean },
    state: TestGatewayState,
    snapshot: TestEnvironmentSnapshot,
  ) => Promise<void>;
  environmentSnapshot: () => TestEnvironmentSnapshot;
  inspectAuthentication: (
    inspectedTransaction?: ManagedGatewayAuthenticationTransaction,
  ) => Promise<unknown>;
  installLatest: () => Promise<TestGatewayState | undefined>;
  login: (
    state: TestGatewayState,
    configPath: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ commit: () => void; rollback: () => void }>;
  ownedProcessId: (state: TestGatewayState) => Promise<number | undefined>;
  prepareConfiguration: (
    state: TestGatewayState | undefined,
  ) => Promise<TestPreparedGatewayConfiguration>;
  processLifecycle: {
    stopForReplacement: (port: number, timeoutMessage: string) => Promise<void>;
  };
  removeStagedConfig: (pendingConfigPath: string) => void;
  rollbackConfiguration: (transaction: { committed: boolean }) => void;
  stageConfiguration: (config: string) => Promise<string>;
  start: (
    prepared: TestPreparedGatewayConfiguration,
    configPath: string,
    snapshot: TestEnvironmentSnapshot,
  ) => Promise<TestGatewayState>;
  modelReconciliation: {
    projectConfiguration: (state: TestGatewayState) => Promise<{
      availableModels: string[];
      baseUrl: string;
      credential: string;
      model: string;
      modelFast: string;
    }>;
  };
  startWithStableEnvironment: (
    prepared: TestPreparedGatewayConfiguration,
    beforeStart?: (
      configPath: string,
      snapshot: TestEnvironmentSnapshot,
    ) => Promise<{ commit: () => void; rollback: () => void } | void>,
  ) => Promise<TestGatewayState>;
  stopProcessesForState: (state: TestGatewayState, occupiedPortMessage: string) => Promise<void>;
}

describe('managed ChatGPT gateway security', () => {
  it('repeats OAuth when startup retries with a different environment signature', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-oauth-route-'),
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
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewaySecurityInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared: TestPreparedGatewayConfiguration = {
      config: 'config',
      configSignature: 'config-signature',
      state,
    };
    const firstSnapshot: TestEnvironmentSnapshot = {
      environment: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      signature: 'environment-a',
    };
    const secondSnapshot: TestEnvironmentSnapshot = {
      environment: { HTTPS_PROXY: 'http://127.0.0.1:7891' },
      signature: 'environment-b',
    };
    const firstTransaction = { commit: vi.fn(), rollback: vi.fn() };
    const secondTransaction = { commit: vi.fn(), rollback: vi.fn() };
    const login = vi
      .spyOn(internals, 'login')
      .mockResolvedValueOnce(firstTransaction)
      .mockResolvedValueOnce(secondTransaction);
    vi.spyOn(internals, 'installLatest').mockResolvedValue(state);
    vi.spyOn(internals, 'prepareConfiguration').mockResolvedValue(prepared);
    vi.spyOn(internals, 'environmentSnapshot')
      .mockReturnValueOnce(firstSnapshot)
      .mockReturnValueOnce(secondSnapshot);
    vi.spyOn(internals, 'startWithStableEnvironment').mockImplementation(
      async (_activePrepared, beforeStart) => {
        await beforeStart?.(path.join(userDataPath, 'config.yaml'), firstSnapshot);
        await beforeStart?.(path.join(userDataPath, 'config.yaml'), secondSnapshot);
        return { ...state, process: testProcess(42) };
      },
    );
    vi.spyOn(internals.modelReconciliation, 'projectConfiguration').mockResolvedValue({
      availableModels: ['gpt-5.6-sol'],
      baseUrl: 'http://127.0.0.1:8317',
      credential: 'local-client-key',
      model: 'gpt-5.6-sol',
      modelFast: 'gpt-5.4-mini',
    });

    try {
      await expect(manager.setup(true)).resolves.toMatchObject({
        model: 'gpt-5.6-sol',
      });
      expect(login).toHaveBeenCalledTimes(2);
      expect(login.mock.calls[0]?.[2]).toBe(firstSnapshot.environment);
      expect(login.mock.calls[1]?.[2]).toBe(secondSnapshot.environment);
      expect(firstTransaction.rollback).toHaveBeenCalledOnce();
      expect(firstTransaction.commit).not.toHaveBeenCalled();
      expect(secondTransaction.commit).toHaveBeenCalledOnce();
      expect(secondTransaction.rollback).not.toHaveBeenCalled();
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('waits for the replacement barrier before retrying a changed environment', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-environment-barrier-'),
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
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewaySecurityInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared: TestPreparedGatewayConfiguration = {
      config: 'config',
      configSignature: 'config-signature',
      state,
    };
    const firstSnapshot: TestEnvironmentSnapshot = {
      environment: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      signature: 'environment-a',
    };
    const secondSnapshot: TestEnvironmentSnapshot = {
      environment: { HTTPS_PROXY: 'http://127.0.0.1:7891' },
      signature: 'environment-b',
    };
    const firstTransaction = { committed: false };
    const secondTransaction = { committed: false };
    let releaseBarrier!: () => void;
    const pendingBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    vi.spyOn(internals, 'environmentSnapshot')
      .mockReturnValueOnce(firstSnapshot)
      .mockReturnValueOnce(firstSnapshot)
      .mockReturnValueOnce(secondSnapshot)
      .mockReturnValue(secondSnapshot);
    vi.spyOn(internals, 'stageConfiguration').mockResolvedValue(
      path.join(userDataPath, 'config.pending.yaml'),
    );
    const activate = vi
      .spyOn(internals, 'activateConfiguration')
      .mockResolvedValueOnce(firstTransaction)
      .mockResolvedValueOnce(secondTransaction);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue({
      manifest: { provider: 'openai-codex', version: 1 },
    });
    const start = vi
      .spyOn(internals, 'start')
      .mockImplementationOnce(async (_activePrepared, _configPath, snapshot) => {
        internals.assertEnvironmentCurrent(snapshot);
        return state;
      })
      .mockResolvedValueOnce({ ...state, process: testProcess(42, 'starting') });
    const barrier = vi
      .spyOn(internals.processLifecycle, 'stopForReplacement')
      .mockReturnValueOnce(pendingBarrier)
      .mockResolvedValue();
    vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(42);
    vi.spyOn(internals, 'commitConfiguration').mockImplementation(async (transaction) => {
      transaction.committed = true;
    });
    vi.spyOn(internals, 'rollbackConfiguration').mockImplementation(() => {});
    vi.spyOn(internals, 'removeStagedConfig').mockImplementation(() => {});

    try {
      const operation = internals.startWithStableEnvironment(prepared);
      await vi.waitFor(() => {
        expect(barrier).toHaveBeenCalledOnce();
      });
      expect(start).toHaveBeenCalledOnce();
      expect(activate).toHaveBeenCalledOnce();

      releaseBarrier();

      await expect(operation).resolves.toMatchObject({
        process: { phase: 'ready', processId: 42 },
      });
      expect(start).toHaveBeenCalledTimes(2);
      expect(activate).toHaveBeenCalledTimes(2);
      expect(barrier).toHaveBeenCalledWith(
        8317,
        '托管网关运行环境变化后，旧启动进程未能及时退出或释放端口。',
      );
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('fails authentication closed while an OAuth replacement transaction is pending', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-pending-auth-'),
    );
    const authDirectory = path.join(userDataPath, 'managed-gateways', 'cliproxyapi', 'auth');
    mkdirSync(authDirectory, { recursive: true });
    writeAccount(path.join(authDirectory, 'codex-account-a.json'), 'account-a');
    const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
    writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');
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
    );
    const internals = manager as unknown as ManagedGatewaySecurityInternals;

    try {
      await expect(internals.inspectAuthentication()).resolves.toBeUndefined();
      expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(true);
      expect(accountValues(authDirectory)).toEqual(['account-b']);
    } finally {
      transaction.rollback();
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('uses only the login-owned transaction during startup and commits it after readiness', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-owned-auth-'));
    const authDirectory = path.join(userDataPath, 'managed-gateways', 'cliproxyapi', 'auth');
    mkdirSync(authDirectory, { recursive: true });
    writeAccount(path.join(authDirectory, 'codex-account-a.json'), 'account-a');
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
    );
    const internals = manager as unknown as ManagedGatewaySecurityInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared = { config: 'config', configSignature: 'signature', state };
    const configTransaction = { committed: false };
    const events: string[] = [];
    let authenticationTransaction: ManagedGatewayAuthenticationTransaction | undefined;
    vi.spyOn(internals, 'installLatest').mockResolvedValue(state);
    vi.spyOn(internals, 'prepareConfiguration').mockResolvedValue(prepared);
    vi.spyOn(internals, 'login').mockImplementation(async () => {
      authenticationTransaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
      writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');
      const commit = authenticationTransaction.commit.bind(authenticationTransaction);
      vi.spyOn(authenticationTransaction, 'commit').mockImplementation(() => {
        events.push('auth-commit');
        commit();
      });
      return authenticationTransaction;
    });
    vi.spyOn(internals, 'stageConfiguration').mockResolvedValue(
      path.join(userDataPath, 'config-0123456789abcdef01234567.pending.yaml'),
    );
    vi.spyOn(internals, 'activateConfiguration').mockResolvedValue(configTransaction);
    const start = vi.spyOn(internals, 'start').mockImplementation(async () => {
      expect(await internals.inspectAuthentication()).toBeUndefined();
      expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(true);
      events.push('gateway-ready');
      return { ...state, process: testProcess(42, 'starting') };
    });
    vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(42);
    vi.spyOn(internals, 'commitConfiguration').mockImplementation(async (transaction) => {
      transaction.committed = true;
      events.push('config-commit');
    });
    vi.spyOn(internals, 'rollbackConfiguration').mockImplementation(() => {});
    vi.spyOn(internals, 'removeStagedConfig').mockImplementation(() => {});
    vi.spyOn(internals.modelReconciliation, 'projectConfiguration').mockImplementation(async () => {
      events.push('models');
      return {
        availableModels: ['gpt-5.6-sol'],
        baseUrl: 'http://127.0.0.1:8317',
        credential: 'local-client-key',
        model: 'gpt-5.6-sol',
        modelFast: 'gpt-5.4-mini',
      };
    });
    const stop = vi.spyOn(internals, 'stopProcessesForState').mockResolvedValue();

    try {
      await expect(manager.setup(true)).resolves.toMatchObject({ model: 'gpt-5.6-sol' });
      expect(start).toHaveBeenCalledOnce();
      expect(events).toEqual(['gateway-ready', 'config-commit', 'models', 'auth-commit']);
      await expect(internals.inspectAuthentication()).resolves.toBeDefined();
      expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(false);
      expect(accountValues(authDirectory)).toEqual(['account-b']);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      authenticationTransaction?.rollback();
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('stops a failed replacement gateway before restoring the prior OAuth account', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-auth-rollback-'),
    );
    const authDirectory = path.join(userDataPath, 'managed-gateways', 'cliproxyapi', 'auth');
    mkdirSync(authDirectory, { recursive: true });
    writeAccount(path.join(authDirectory, 'codex-account-a.json'), 'account-a');
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
    );
    const internals = manager as unknown as ManagedGatewaySecurityInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared = { config: 'config', configSignature: 'signature', state };
    const events: string[] = [];
    vi.spyOn(internals, 'installLatest').mockResolvedValue(state);
    vi.spyOn(internals, 'prepareConfiguration').mockResolvedValue(prepared);
    vi.spyOn(internals, 'login').mockImplementation(async () => {
      const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
      writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');
      const rollback = transaction.rollback.bind(transaction);
      vi.spyOn(transaction, 'rollback').mockImplementation(() => {
        events.push('rollback');
        rollback();
      });
      return transaction;
    });
    vi.spyOn(internals, 'startWithStableEnvironment').mockImplementation(
      async (_activePrepared, beforeStart) => {
        await beforeStart?.(
          path.join(userDataPath, 'config.yaml'),
          internals.environmentSnapshot(),
        );
        throw new Error('injected readiness failure');
      },
    );
    vi.spyOn(internals, 'stopProcessesForState').mockImplementation(async () => {
      events.push('stop');
    });

    try {
      await expect(manager.setup(true)).rejects.toThrow('injected readiness failure');
      expect(events).toEqual(['stop', 'rollback']);
      expect(accountValues(authDirectory)).toEqual(['account-a']);
      expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(false);
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('keeps the active OAuth account and quarantine when exact gateway stop fails', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-auth-residual-'),
    );
    const authDirectory = path.join(userDataPath, 'managed-gateways', 'cliproxyapi', 'auth');
    mkdirSync(authDirectory, { recursive: true });
    writeAccount(path.join(authDirectory, 'codex-account-a.json'), 'account-a');
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
    );
    const internals = manager as unknown as ManagedGatewaySecurityInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared = { config: 'config', configSignature: 'signature', state };
    let transaction: ManagedGatewayAuthenticationTransaction | undefined;
    vi.spyOn(internals, 'installLatest').mockResolvedValue(state);
    vi.spyOn(internals, 'prepareConfiguration').mockResolvedValue(prepared);
    vi.spyOn(internals, 'login').mockImplementation(async () => {
      transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
      writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');
      return transaction;
    });
    vi.spyOn(internals, 'startWithStableEnvironment').mockImplementation(
      async (_activePrepared, beforeStart) => {
        await beforeStart?.(
          path.join(userDataPath, 'config.yaml'),
          internals.environmentSnapshot(),
        );
        throw new Error('injected readiness failure');
      },
    );
    vi.spyOn(internals, 'stopProcessesForState').mockRejectedValue(
      new Error('injected exact stop timeout'),
    );

    try {
      await expect(manager.setup(true)).rejects.toThrow('injected readiness failure');
      expect(accountValues(authDirectory)).toEqual(['account-b']);
      expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(true);
    } finally {
      transaction?.rollback();
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });
});
