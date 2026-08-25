import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeProjectState, SaveClaudeConfigInput } from '../../src/shared/contracts';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('Claude connection IPC project ownership', () => {
  it('reads the current project after a save is rejected because the session changed projects', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const { registerClaudeConnectionIpc } = await import('../../src/main/ipc/claude-connection');

    let currentCwd = 'D:\\ProjectA';
    const currentState = { cwd: 'D:\\ProjectB' } as ClaudeProjectState;
    const runtime = {
      getState: vi.fn(async () => currentState),
    };
    const workspace = {
      getStatus: vi.fn(() => ({ cwd: currentCwd, id: 'session-1' })),
    };
    const failure = new Error('当前项目已切换，请重试。');

    registerClaudeConnectionIpc({
      claudeFailure: vi.fn(),
      configTransactionState: vi.fn(() => undefined),
      guards: {
        requireClaudeRuntime: vi.fn(() => runtime),
        validateSender: vi.fn(),
        withOfficialProviderAccess: vi.fn((_request, operation) => operation()),
      },
      invalidateAndWaitForMatchingDevelopmentSessionOperation: vi.fn(async () => false),
      runClaudeProjectConfigTransaction: vi.fn(async () => {
        currentCwd = 'D:\\ProjectB';
        throw failure;
      }),
      withDevelopmentSessionOperation: vi.fn((_sessionId, operation) =>
        operation(vi.fn(), new AbortController().signal),
      ),
      workspace,
    } as never);

    const input: SaveClaudeConfigInput = {
      authMode: 'authToken',
      baseUrl: 'https://relay.example.com',
      credential: 'token',
      credentialAction: 'replace',
      model: 'saved-model',
      preset: 'custom',
      provider: 'gateway',
    };
    const result = await ipc.invoke(CHANNELS.CLAUDE_SAVE_CONFIG, 'session-1', input);

    expect(result).toMatchObject({ error: failure.message, ok: false, state: currentState });
    expect(workspace.getStatus).toHaveBeenCalledTimes(2);
    expect(runtime.getState).toHaveBeenCalledExactlyOnceWith('session-1', 'D:\\ProjectB');
    expect(runtime.getState).not.toHaveBeenCalledWith('session-1', 'D:\\ProjectA');
  });
});
