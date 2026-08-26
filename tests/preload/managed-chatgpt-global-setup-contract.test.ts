import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainGuards } from '../../src/main/ipc/guards';
import type {
  ManagedChatGptGatewayOperationResult,
  ManagedChatGptGatewayState,
} from '../../src/shared/contracts';
import {
  ManagedChatGptOperationTracker,
  runManagedChatGptOperation,
} from '../../src/renderer/features/connection/managed-chatgpt-operation';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';
import { createTestMainServiceRegistry } from '../helpers/main-service-registry';

const state: ManagedChatGptGatewayState = {
  authenticated: true,
  availableModels: ['gpt-5.6-sol'],
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

const nextConnection = {
  config: {
    apiKeyHelperPolicy: 'prefer-claudedock' as const,
    authMode: 'authToken' as const,
    baseUrl: state.endpoint,
    credentialConfigured: true,
    model: 'gpt-5.6-sol',
    preset: 'chatgpt-subscription' as const,
    protocol: 'anthropic' as const,
    provider: 'gateway' as const,
  },
};

const connectionTest = {
  authMode: 'authToken' as const,
  message: '模型响应正常。',
  ok: true as const,
  stages: [],
  testedAt: 1,
  tone: 'success' as const,
};

const success: ManagedChatGptGatewayOperationResult = {
  connectionTest,
  message: 'ChatGPT 接入已验证；下个新对话将使用 gpt-5.6-sol。',
  nextConnection,
  ok: true,
  state,
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('managed ChatGPT projectless setup contract', () => {
  it('sends an omitted project and the default login mode through the real preload bridge', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcRenderer: ipc.ipcRenderer,
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const { managedChatgptBridge } = await import('../../src/preload/bridges/managed-chatgpt');

    void managedChatgptBridge.setupManagedChatGptGateway(undefined);

    expect(ipc.ipcRenderer.invoke).toHaveBeenCalledWith(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP,
      undefined,
    );
  });

  it('sends managed-account logout without a project, login flag, or browser action', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcRenderer: ipc.ipcRenderer,
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const { managedChatgptBridge } = await import('../../src/preload/bridges/managed-chatgpt');

    void managedChatgptBridge.logoutManagedChatGptGateway();

    expect(ipc.ipcRenderer.invoke).toHaveBeenCalledWith(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_LOGOUT,
    );
  });

  it('handles managed-account logout without provider preflight, project access, or browser control', async () => {
    const ipc = createIpcHarness();
    const openExternal = vi.fn();
    const logout = vi.fn(async () => undefined);
    const getState = vi.fn(async () => ({
      ...state,
      authenticated: false,
      availableModels: [],
      managementAvailable: false,
      phase: 'login-required' as const,
      running: false,
    }));
    const withOfficialProviderAccess = vi.fn();
    const getStatus = vi.fn();
    vi.doMock('electron', () => ({
      clipboard: { writeText: vi.fn() },
      ipcMain: ipc.ipcMain,
      shell: { openExternal },
    }));
    const { registerManagedChatGptIpc } = await import('../../src/main/ipc/managed-chatgpt');
    const services = await createTestMainServiceRegistry();
    registerManagedChatGptIpc({
      configTransactionState: vi.fn(),
      failedRuntimeLaunchCleanupDependencies: {} as never,
      guards: {
        requireClaudeRuntime: vi.fn(),
        requireManagedChatGptGateway: () => ({ getState, logout }) as never,
        validateSender: vi.fn(),
        withOfficialProviderAccess: withOfficialProviderAccess as never,
      },
      restartRuntimeTerminal: vi.fn(),
      runClaudeProjectConfigTransaction: vi.fn(),
      services,
      withDevelopmentSessionOperation: vi.fn(),
      withoutTerminalOperationInvalidation: vi.fn(),
      workspace: { getStatus } as never,
    });

    const result = await ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_LOGOUT);

    expect(result).toMatchObject({
      message: expect.stringContaining('浏览器和 Google 登录状态未被修改'),
      ok: true,
      state: { authenticated: false, phase: 'login-required' },
    });
    expect(logout).toHaveBeenCalledOnce();
    expect(withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('routes an omitted project directly to one deduplicated global setup', async () => {
    const ipc = createIpcHarness();
    const nextConversationScope = 'C:\\ClaudeDock Data\\claude\\next-conversation-profile';
    const routeEvents: string[] = [];
    let providerAccessActive = false;
    const setup = vi.fn(async () => {
      expect(providerAccessActive).toBe(true);
      routeEvents.push('gateway-setup');
      return {
        availableModels: ['gpt-5.6-sol'],
        baseUrl: state.endpoint,
        credential: 'local-only-test-key',
        model: 'gpt-5.6-sol',
        modelFast: 'gpt-5.6-sol',
      };
    });
    const getState = vi.fn(async () => {
      expect(providerAccessActive).toBe(true);
      routeEvents.push('gateway-state');
      return state;
    });
    const getStatus = vi.fn(() => {
      throw new Error('Project status must not be read for global setup.');
    });
    const withOfficialProviderAccess = vi.fn(
      async <T>(
        _request: Parameters<MainGuards['withOfficialProviderAccess']>[0],
        operation: () => Promise<T> | T,
      ): Promise<T> => {
        routeEvents.push('guard-enter');
        providerAccessActive = true;
        try {
          return await operation();
        } finally {
          providerAccessActive = false;
          routeEvents.push('guard-exit');
        }
      },
    ) as unknown as MainGuards['withOfficialProviderAccess'];
    const runtime = {
      getNextConversationConnection: vi.fn(async () => {
        expect(providerAccessActive).toBe(true);
        routeEvents.push('next-connection-read');
        return {};
      }),
      getSoftwareUpdates: vi.fn(async () => {
        expect(providerAccessActive).toBe(true);
        routeEvents.push('runtime-software-updates');
        return { claudeCode: { installed: true } };
      }),
      nextConversationConnectionScope: vi.fn(() => nextConversationScope),
      verifyAndSaveNextConversationConfig: vi.fn(async () => {
        expect(providerAccessActive).toBe(true);
        routeEvents.push('next-connection-verify-save');
        return { connectionTest, state: nextConnection };
      }),
    };
    vi.doMock('electron', () => ({
      clipboard: { writeText: vi.fn() },
      ipcMain: ipc.ipcMain,
      shell: { openExternal: vi.fn(async () => undefined) },
    }));
    const { registerManagedChatGptIpc } = await import('../../src/main/ipc/managed-chatgpt');
    const services = await createTestMainServiceRegistry();
    const { MAIN_WINDOW } = await import('../../src/main/infra/service-tokens');
    services.resolve(MAIN_WINDOW).current = {
      webContents: ipc.webContents,
    } as Electron.BrowserWindow;
    registerManagedChatGptIpc({
      configTransactionState: vi.fn(),
      failedRuntimeLaunchCleanupDependencies: {} as never,
      guards: {
        requireClaudeRuntime: () => runtime as never,
        requireManagedChatGptGateway: () => ({ getState, setup }) as never,
        validateSender: vi.fn(),
        withOfficialProviderAccess,
      },
      restartRuntimeTerminal: vi.fn(),
      runClaudeProjectConfigTransaction: vi.fn(),
      services,
      withDevelopmentSessionOperation: vi.fn(),
      withoutTerminalOperationInvalidation: vi.fn(),
      workspace: { getStatus } as never,
    });

    const [first, second] = await Promise.all([
      ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, undefined),
      ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, undefined),
    ]);

    expect(first).toEqual(success);
    expect(second).toEqual(success);
    expect(setup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith(false, expect.any(Function));
    expect(withOfficialProviderAccess).toHaveBeenCalledOnce();
    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      {
        action: 'login',
        cwd: nextConversationScope,
        networkScope: 'application',
        provider: 'openai-codex',
      },
      expect.any(Function),
    );
    expect(routeEvents).toEqual([
      'guard-enter',
      'runtime-software-updates',
      'gateway-setup',
      'next-connection-read',
      'next-connection-verify-save',
      'gateway-state',
      'guard-exit',
    ]);
    expect(providerAccessActive).toBe(false);
    expect(runtime.nextConversationConnectionScope).toHaveBeenCalledOnce();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('submits setup through the renderer coordinator without an active project', async () => {
    const tracker = new ManagedChatGptOperationTracker();
    const setup = vi.fn(async (sessionId: string | undefined) => ({ sessionId }));

    const execution = await runManagedChatGptOperation(tracker, undefined, setup);

    expect(execution).toEqual({ result: { sessionId: undefined }, started: true });
    expect(setup).toHaveBeenCalledWith(undefined);
    expect(tracker.busy).toBe(false);
  });

  it('keeps a global model change inside the exact next-conversation authorization scope', async () => {
    const ipc = createIpcHarness();
    const nextConversationScope = 'C:\\ClaudeDock Data\\claude\\next-conversation-profile';
    const withOfficialProviderAccess = vi.fn(
      async <T>(
        _request: Parameters<MainGuards['withOfficialProviderAccess']>[0],
        operation: () => Promise<T> | T,
      ): Promise<T> => await operation(),
    ) as unknown as MainGuards['withOfficialProviderAccess'];
    const runtime = {
      getNextConversationConnection: vi.fn(async () => nextConnection),
      nextConversationConnectionScope: vi.fn(() => nextConversationScope),
      verifyAndSaveNextConversationConfig: vi.fn(async () => ({
        connectionTest,
        state: nextConnection,
      })),
    };
    const configurationForModel = vi.fn(async () => ({
      availableModels: ['gpt-5.6-sol'],
      baseUrl: state.endpoint,
      credential: 'local-only-test-key',
      model: 'gpt-5.6-sol',
      modelFast: 'gpt-5.6-sol',
    }));
    vi.doMock('electron', () => ({
      clipboard: { writeText: vi.fn() },
      ipcMain: ipc.ipcMain,
      shell: { openExternal: vi.fn(async () => undefined) },
    }));
    const { registerManagedChatGptIpc } = await import('../../src/main/ipc/managed-chatgpt');
    const services = await createTestMainServiceRegistry();
    const { MAIN_WINDOW } = await import('../../src/main/infra/service-tokens');
    services.resolve(MAIN_WINDOW).current = {
      webContents: ipc.webContents,
    } as Electron.BrowserWindow;
    registerManagedChatGptIpc({
      configTransactionState: vi.fn(),
      failedRuntimeLaunchCleanupDependencies: {} as never,
      guards: {
        requireClaudeRuntime: () => runtime as never,
        requireManagedChatGptGateway: () =>
          ({ configurationForModel, getState: vi.fn(async () => state) }) as never,
        validateSender: vi.fn(),
        withOfficialProviderAccess,
      },
      restartRuntimeTerminal: vi.fn(),
      runClaudeProjectConfigTransaction: vi.fn(),
      services,
      withDevelopmentSessionOperation: vi.fn(),
      withoutTerminalOperationInvalidation: vi.fn(),
      workspace: { getStatus: vi.fn() } as never,
    });

    const result = await ipc.invoke(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_MODEL,
      undefined,
      'gpt-5.6-sol',
    );

    expect(result).toMatchObject({ nextConnection, ok: true, state });
    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      {
        action: 'first-request',
        cwd: nextConversationScope,
        networkScope: 'application',
        provider: 'openai-codex',
      },
      expect.any(Function),
    );
    expect(runtime.nextConversationConnectionScope).toHaveBeenCalledOnce();
    expect(configurationForModel).toHaveBeenCalledWith('gpt-5.6-sol');
  });

  it('rejects a second renderer action while the setup coordinator owns the request', async () => {
    const tracker = new ManagedChatGptOperationTracker();
    let resolveSetup!: (result: ManagedChatGptGatewayOperationResult) => void;
    const pendingSetup = new Promise<ManagedChatGptGatewayOperationResult>((resolve) => {
      resolveSetup = resolve;
    });
    const setup = vi.fn(() => pendingSetup);

    const first = runManagedChatGptOperation(tracker, undefined, setup);
    const second = await runManagedChatGptOperation(tracker, undefined, setup);

    expect(second).toEqual({ started: false });
    expect(setup).toHaveBeenCalledOnce();
    expect(tracker.busy).toBe(true);
    resolveSetup(success);
    await expect(first).resolves.toEqual({ result: success, started: true });
    expect(tracker.busy).toBe(false);
  });
});
