import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeConnectionTestResult,
  ClaudeProjectState,
  ManagedChatGptGatewayState,
} from '../../src/shared/contracts';
import {
  configTransactionState,
  createRunClaudeProjectConfigTransaction,
} from '../../src/main/claude/project-config-transaction';
import type { ManagedChatGptGatewayProjectConfig } from '../../src/main/claude/managed-chatgpt-gateway';
import type { PreparedClaudeConfigSave } from '../../src/main/claude/runtime';
import { SessionConfigTransactionCoordinator } from '../../src/main/coordination/main-process-operation';
import type { WithSessionOperation } from '../../src/main/coordination/session-operation';
import type { RestartRuntimeTerminal } from '../../src/main/terminal/lifecycle';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';
import { createTestMainServiceRegistry } from '../helpers/main-service-registry';

interface StoredProfile {
  config: {
    model: string;
    modelFast?: string;
    preset: string;
  };
  credential: string;
  presentation: {
    label: string;
  };
}

const gatewayState: ManagedChatGptGatewayState = {
  authenticated: true,
  availableModels: ['gpt-5.6-sol', 'gpt-5.6-fast'],
  busy: false,
  checkedAt: 1,
  endpoint: 'http://127.0.0.1:8317',
  installed: true,
  managementAvailable: true,
  message: '安装与授权已就绪。',
  phase: 'ready',
  running: true,
  usageStatisticsEnabled: false,
};

const managedConfig: ManagedChatGptGatewayProjectConfig = {
  availableModels: ['gpt-5.6-sol', 'gpt-5.6-fast'],
  baseUrl: 'http://127.0.0.1:8317/v1',
  credential: 'managed-token',
  model: 'gpt-5.6-sol',
  modelFast: 'gpt-5.6-fast',
};

const connectionTest: ClaudeConnectionTestResult = {
  latencyMs: 12,
  message: '连接正常。',
  ok: true,
  stages: [],
  testedAt: 1,
  tone: 'success',
};

const callIndex = (calls: readonly string[], marker: string): number => {
  const index = calls.indexOf(marker);
  expect(index, `missing call: ${marker}`).toBeGreaterThanOrEqual(0);
  return index;
};

const createScenario = async (completionFailure?: Error) => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({
    clipboard: { writeText: vi.fn() },
    ipcMain: ipc.ipcMain,
    shell: { openExternal: vi.fn(async () => undefined) },
  }));
  const { registerManagedChatGptIpc } = await import('../../src/main/ipc/managed-chatgpt');

  const calls: string[] = [];
  const withOfficialProviderAccess = vi.fn(
    async (_request: unknown, operation: () => Promise<unknown> | unknown) => {
      calls.push('guard:enter');
      try {
        return await operation();
      } finally {
        calls.push('guard:exit');
      }
    },
  );
  const before: StoredProfile = {
    config: { model: 'legacy-model', modelFast: 'legacy-fast', preset: 'custom' },
    credential: 'legacy-token',
    presentation: { label: 'Legacy relay' },
  };
  let profile = structuredClone(before);
  const stateFromProfile = (): ClaudeProjectState =>
    ({
      active: false,
      config: structuredClone(profile.config),
      cwd: 'D:\\Project',
      sessionId: 'session-1',
    }) as unknown as ClaudeProjectState;
  const publishedStates: ClaudeProjectState[] = [];
  const restoredSnapshots: StoredProfile[] = [];

  const runtime = {
    cleanupPreparedLaunch: vi.fn(() => true),
    commitPreparedConfig: vi.fn((_cwd: string, prepared: PreparedClaudeConfigSave) => {
      calls.push('transaction:commit');
      profile = {
        config: {
          model: prepared.input.model,
          modelFast: prepared.input.modelFast,
          preset: prepared.input.preset,
        },
        credential: prepared.input.credential ?? '',
        presentation: { label: 'Managed ChatGPT' },
      };
    }),
    completePreparedConfigSave: vi.fn(async () => {
      calls.push('transaction:complete');
      if (completionFailure) throw completionFailure;
      return stateFromProfile();
    }),
    createConfigSnapshot: vi.fn(() => structuredClone(profile)),
    getSoftwareUpdates: vi.fn(async () => {
      calls.push('environment:detect');
      return { claudeCode: { installed: true } };
    }),
    getState: vi.fn(async () => {
      calls.push(`state:read:${profile.config.preset}`);
      return stateFromProfile();
    }),
    isActive: vi.fn(() => true),
    mergeConfigCompletionSnapshot: vi.fn((committed: StoredProfile) => committed),
    prepareConnectionConfig: vi.fn(async (input) => {
      calls.push('transaction:prepare');
      return { input } as PreparedClaudeConfigSave;
    }),
    prepareLaunch: vi.fn(async () => {
      calls.push(`resume:prepare:${profile.config.preset}`);
      return {
        command: 'claude --continue',
        environment: { CLAUDE_ROUTE: profile.config.preset },
        predecessorPtyGeneration: 7,
      };
    }),
    restoreConfigSnapshot: vi.fn((_cwd: string, snapshot: StoredProfile) => {
      calls.push('transaction:restore');
      restoredSnapshots.push(structuredClone(snapshot));
      profile = structuredClone(snapshot);
    }),
    setInactive: vi.fn((_sessionId: string, generation: number) => {
      calls.push(`legacy:set-inactive:${generation}`);
      return true;
    }),
    testConnection: vi.fn(async () => {
      calls.push('managed:test-connection');
      return connectionTest;
    }),
  };
  const gateway = {
    ensureRunning: vi.fn(async () => undefined),
    getState: vi.fn(async () => gatewayState),
    setup: vi.fn(async () => {
      calls.push('managed:setup');
      return managedConfig;
    }),
  };
  const workspace = {
    getStatus: vi.fn(() => ({ cwd: 'D:\\Project', id: 'session-1', ptyGeneration: 7 })),
    stopIfGeneration: vi.fn((_sessionId: string, generation: number) => {
      calls.push(`legacy:stop:${generation}`);
      return true;
    }),
  };
  const coordinator = new SessionConfigTransactionCoordinator();
  const runClaudeProjectConfigTransaction = createRunClaudeProjectConfigTransaction({
    acquireConfigTransactionIsolation: async () => {
      calls.push('transaction:isolate');
    },
    guards: { assertExternalRoutingWritesAllowed: vi.fn() },
    managedConfigTransactions: coordinator,
    publishRestoredClaudeProjectState: (state) => {
      calls.push('transaction:publish-restored');
      publishedStates.push(state);
    },
    workspace: workspace as never,
  });
  const withDevelopmentSessionOperation: WithSessionOperation = async <T>(
    _sessionId: string,
    operation: Parameters<WithSessionOperation>[1],
  ): Promise<T> => operation(vi.fn(), new AbortController().signal) as Promise<T>;
  const restartRuntimeTerminal: RestartRuntimeTerminal = (
    _runtime,
    _sessionId,
    environment,
    _command,
    _failureMessage,
    _assertCurrent,
    ownGeneration,
  ) => {
    calls.push(`resume:restart:${environment?.CLAUDE_ROUTE ?? 'missing'}`);
    ownGeneration(8);
    return {} as ReturnType<RestartRuntimeTerminal>;
  };

  const services = await createTestMainServiceRegistry();
  const { MAIN_WINDOW } = await import('../../src/main/infra/service-tokens');
  services.resolve(MAIN_WINDOW).current = {
    webContents: ipc.webContents,
  } as Electron.BrowserWindow;

  registerManagedChatGptIpc({
    configTransactionState,
    failedRuntimeLaunchCleanupDependencies: {
      hasSession: vi.fn(() => true),
      stopIfGeneration: workspace.stopIfGeneration,
    },
    guards: {
      withOfficialProviderAccess,
      requireClaudeRuntime: vi.fn(() => runtime),
      requireManagedChatGptGateway: vi.fn(() => gateway),
      validateSender: vi.fn(),
    } as never,
    restartRuntimeTerminal,
    runClaudeProjectConfigTransaction,
    services,
    withDevelopmentSessionOperation,
    withoutTerminalOperationInvalidation: (_sessionId, operation) => {
      calls.push('legacy:suppress-invalidation');
      return operation();
    },
    workspace: workspace as never,
  });

  const result = await ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, 'session-1');
  return {
    before,
    calls,
    gateway,
    profile,
    publishedStates,
    restoredSnapshots,
    result,
    runtime,
    withOfficialProviderAccess,
    workspace,
  };
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('managed ChatGPT route cutover', () => {
  it('stops an active legacy PTY before setup and resumes only after the managed route is saved', async () => {
    const scenario = await createScenario();

    expect(scenario.result).toMatchObject({
      connectionTest,
      ok: true,
      projectState: { config: { model: 'gpt-5.6-sol', preset: 'chatgpt-subscription' } },
    });
    expect(scenario.withOfficialProviderAccess).toHaveBeenCalledWith(
      { action: 'login', cwd: 'D:\\Project', provider: 'openai-codex' },
      expect.any(Function),
    );
    expect(scenario.workspace.stopIfGeneration).toHaveBeenCalledWith('session-1', 7);
    expect(scenario.runtime.setInactive).toHaveBeenCalledWith('session-1', 7);
    expect(scenario.runtime.prepareLaunch).toHaveBeenCalledWith(
      'session-1',
      'D:\\Project',
      'continue',
    );

    const guardEnter = callIndex(scenario.calls, 'guard:enter');
    const stop = callIndex(scenario.calls, 'legacy:stop:7');
    const inactive = callIndex(scenario.calls, 'legacy:set-inactive:7');
    const setup = callIndex(scenario.calls, 'managed:setup');
    const commit = callIndex(scenario.calls, 'transaction:commit');
    const complete = callIndex(scenario.calls, 'transaction:complete');
    const prepareResume = callIndex(scenario.calls, 'resume:prepare:chatgpt-subscription');
    const restart = callIndex(scenario.calls, 'resume:restart:chatgpt-subscription');
    const guardExit = callIndex(scenario.calls, 'guard:exit');
    expect(guardEnter).toBeLessThan(stop);
    expect(stop).toBeLessThan(inactive);
    expect(inactive).toBeLessThan(setup);
    expect(setup).toBeLessThan(commit);
    expect(commit).toBeLessThan(complete);
    expect(complete).toBeLessThan(prepareResume);
    expect(prepareResume).toBeLessThan(restart);
    expect(restart).toBeLessThan(guardExit);
    expect(scenario.calls).not.toContain('resume:prepare:custom');
    expect(scenario.result.message).toContain('旧路由已停止');
  });

  it('restores and publishes the exact pre-save profile when cutover completion fails', async () => {
    const failure = new Error('managed route could not complete');
    const scenario = await createScenario(failure);

    expect(scenario.result).toMatchObject({
      error: failure.message,
      message: '未能完成 ChatGPT 订阅的一键接入；旧路由会话已保持停止，不会继续消耗原中转站额度。',
      ok: false,
      projectState: { config: { model: 'legacy-model', preset: 'custom' } },
    });
    expect(scenario.withOfficialProviderAccess).toHaveBeenCalledWith(
      { action: 'login', cwd: 'D:\\Project', provider: 'openai-codex' },
      expect.any(Function),
    );
    expect(scenario.profile).toEqual(scenario.before);
    expect(scenario.restoredSnapshots).toEqual([scenario.before]);
    expect(scenario.publishedStates).toHaveLength(1);
    expect(scenario.publishedStates[0]).toMatchObject({
      config: { model: 'legacy-model', preset: 'custom' },
    });
    const guardEnter = callIndex(scenario.calls, 'guard:enter');
    const restore = callIndex(scenario.calls, 'transaction:restore');
    const publishRestored = callIndex(scenario.calls, 'transaction:publish-restored');
    const guardExit = callIndex(scenario.calls, 'guard:exit');
    expect(guardEnter).toBeLessThan(restore);
    expect(restore).toBeLessThan(publishRestored);
    expect(publishRestored).toBeLessThan(guardExit);
    expect(scenario.runtime.prepareLaunch).not.toHaveBeenCalled();
    expect(scenario.calls.some((call) => call.startsWith('resume:restart:'))).toBe(false);
  });
});
