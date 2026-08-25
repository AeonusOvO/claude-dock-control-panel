import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIpcHarness } from '../helpers/ipc-harness';
import { CHANNELS } from '../../src/shared/ipc/channels';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('managed ChatGPT management IPC privacy', () => {
  it('opens only the loopback URL and never returns or copies the durable management key', async () => {
    const ipc = createIpcHarness();
    const openExternal = vi.fn(async () => {});
    const writeText = vi.fn();
    vi.doMock('electron', () => ({
      clipboard: { writeText },
      ipcMain: ipc.ipcMain,
      shell: { openExternal },
    }));
    const managementKey = `mgmt-claudedock-${'m'.repeat(43)}`;
    const managementAccess = vi.fn(async () => ({
      managementKey,
      url: 'http://127.0.0.1:8317/management.html',
    }));
    const { registerManagedChatGptIpc } = await import('../../src/main/ipc/managed-chatgpt');
    registerManagedChatGptIpc({
      configTransactionState: vi.fn(),
      failedRuntimeLaunchCleanupDependencies: {},
      guards: {
        requireClaudeRuntime: vi.fn(),
        requireManagedChatGptGateway: () => ({ managementAccess }),
        validateSender: vi.fn(),
        withOfficialProviderAccess: vi.fn(),
      },
      restartRuntimeTerminal: vi.fn(),
      runClaudeProjectConfigTransaction: vi.fn(),
      services: {},
      withDevelopmentSessionOperation: vi.fn(),
      withoutTerminalOperationInvalidation: vi.fn(),
      workspace: {},
    } as never);

    const result = await ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_OPEN_MANAGEMENT);

    expect(result).toEqual({
      message: '已打开 ChatGPT 网关本机后台；管理凭据不会发送到页面或剪贴板。',
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain(managementKey);
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:8317/management.html');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('cancels only through the gateway-owned setup boundary', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcMain: ipc.ipcMain,
      shell: { openExternal: vi.fn() },
    }));
    const cancelSetup = vi.fn(async () => true);
    const { registerManagedChatGptIpc } = await import('../../src/main/ipc/managed-chatgpt');
    registerManagedChatGptIpc({
      configTransactionState: vi.fn(),
      failedRuntimeLaunchCleanupDependencies: {},
      guards: {
        requireClaudeRuntime: vi.fn(),
        requireManagedChatGptGateway: () => ({ cancelSetup }),
        validateSender: vi.fn(),
        withOfficialProviderAccess: vi.fn(),
      },
      restartRuntimeTerminal: vi.fn(),
      runClaudeProjectConfigTransaction: vi.fn(),
      services: {},
      withDevelopmentSessionOperation: vi.fn(),
      withoutTerminalOperationInvalidation: vi.fn(),
      workspace: {},
    } as never);

    await expect(ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_CANCEL_SETUP)).resolves.toEqual(
      {
        message: '已取消当前 OpenAI 授权并返回模型选择。',
        ok: true,
      },
    );
    cancelSetup.mockResolvedValueOnce(false);
    await expect(ipc.invoke(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_CANCEL_SETUP)).resolves.toEqual(
      {
        message: '当前没有可取消的授权操作。',
        ok: false,
      },
    );
    expect(cancelSetup).toHaveBeenCalledTimes(2);
  });
});
