import { afterEach, describe, expect, it, vi } from 'vitest';
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

const success: ManagedChatGptGatewayOperationResult = {
  message: '安装和 OpenAI 授权已完成；打开项目后即可验证模型并用于当前项目。',
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

    void managedChatgptBridge.setupManagedChatGptGateway(undefined, undefined);

    expect(ipc.ipcRenderer.invoke).toHaveBeenCalledWith(
      CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP,
      undefined,
      false,
    );
  });

  it('routes an omitted project directly to one deduplicated global setup', async () => {
    const ipc = createIpcHarness();
    const setup = vi.fn(async () => undefined);
    const getState = vi.fn(async () => state);
    const getStatus = vi.fn(() => {
      throw new Error('Project status must not be read for global setup.');
    });
    const assertOfficialProviderAllowed = vi.fn(async () => undefined);
    const runtime = {
      getSoftwareUpdates: vi.fn(async () => ({ claudeCode: { installed: true } })),
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
        assertOfficialProviderAllowed,
        requireClaudeRuntime: () => runtime as never,
        requireManagedChatGptGateway: () => ({ getState, setup }) as never,
        validateSender: vi.fn(),
      },
      restartRuntimeTerminal: vi.fn(),
      runClaudeProjectConfigTransaction: vi.fn(),
      services,
      withDevelopmentSessionOperation: vi.fn(),
      withoutTerminalOperationInvalidation: vi.fn(),
      workspace: { getStatus } as never,
    });

    const [first, second] = await Promise.all([
      ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, undefined, false),
      ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, undefined, false),
    ]);

    expect(first).toEqual(success);
    expect(second).toEqual(success);
    expect(setup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith(false, expect.any(Function));
    expect(assertOfficialProviderAllowed).toHaveBeenCalledWith('openai-codex', 'login');
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
