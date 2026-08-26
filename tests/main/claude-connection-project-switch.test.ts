import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeProjectState, SaveClaudeConfigInput } from '../../src/shared/contracts';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('Claude connection IPC project ownership', () => {
  it('rebinds a conversation to the current complete connection without changing project config', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const { registerClaudeConnectionIpc } = await import('../../src/main/ipc/claude-connection');
    const state = { cwd: 'D:\\ProjectA' } as ClaudeProjectState;
    const runtime = {
      bindConversationToCurrent: vi.fn(async () => undefined),
      publishProjectState: vi.fn(() => state),
    };
    const runTransaction = vi.fn();

    registerClaudeConnectionIpc({
      claudeFailure: vi.fn(),
      configTransactionState: vi.fn(() => undefined),
      guards: {
        requireClaudeRuntime: vi.fn(() => runtime),
        validateSender: vi.fn(),
        withOfficialProviderAccess: vi.fn((_request, operation) => operation()),
      },
      invalidateAndWaitForMatchingDevelopmentSessionOperation: vi.fn(async () => false),
      runClaudeProjectConfigTransaction: runTransaction,
      withDevelopmentSessionOperation: vi.fn((_sessionId, operation) =>
        operation(vi.fn(), new AbortController().signal),
      ),
      workspace: {
        getStatus: vi.fn(() => ({ cwd: 'D:\\ProjectA', id: 'session-1' })),
      },
    } as never);

    const conversationId = '123e4567-e89b-42d3-a456-426614174000';
    const result = await ipc.invoke(
      CHANNELS.CLAUDE_CONVERSATION_MODEL_APPLY,
      'session-1',
      conversationId,
      'use-current',
    );

    expect(result).toEqual({ choice: 'use-current', ok: true, state });
    expect(runtime.bindConversationToCurrent).toHaveBeenCalledExactlyOnceWith(
      'D:\\ProjectA',
      conversationId,
      'D:\\ProjectA',
    );
    expect(runtime.publishProjectState).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'D:\\ProjectA',
    );
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('tests the original connection before committing its project transaction', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const { registerClaudeConnectionIpc } = await import('../../src/main/ipc/claude-connection');
    const order: string[] = [];
    const state = { cwd: 'D:\\ProjectA' } as ClaudeProjectState;
    const prepared = { input: { authMode: 'apiKey' } };
    const runtime = {
      commitPreparedConfig: vi.fn(() => order.push('commit')),
      completePreparedConfigSave: vi.fn(async () => {
        order.push('complete');
        return state;
      }),
      conversationNetworkAccess: vi.fn(() => undefined),
      prepareConversationConnection: vi.fn(async () => {
        order.push('prepare');
        return prepared;
      }),
      testPreparedConnection: vi.fn(async () => {
        order.push('test');
        return { ok: true };
      }),
    };

    registerClaudeConnectionIpc({
      claudeFailure: vi.fn(),
      configTransactionState: vi.fn(() => undefined),
      guards: {
        requireClaudeRuntime: vi.fn(() => runtime),
        validateSender: vi.fn(),
        withOfficialProviderAccess: vi.fn((_request, operation) => operation()),
      },
      invalidateAndWaitForMatchingDevelopmentSessionOperation: vi.fn(async () => false),
      runClaudeProjectConfigTransaction: vi.fn(async (options) => {
        const candidate = await options.prepare();
        await options.validatePrepared?.(candidate);
        options.commit(candidate);
        return options.complete(candidate);
      }),
      withDevelopmentSessionOperation: vi.fn((_sessionId, operation) =>
        operation(vi.fn(), new AbortController().signal),
      ),
      workspace: {
        getStatus: vi.fn(() => ({ cwd: 'D:\\ProjectA', id: 'session-1' })),
      },
    } as never);

    const conversationId = '123e4567-e89b-42d3-a456-426614174000';
    const result = await ipc.invoke(
      CHANNELS.CLAUDE_CONVERSATION_MODEL_APPLY,
      'session-1',
      conversationId,
      'use-conversation',
    );

    expect(result).toMatchObject({ choice: 'use-conversation', ok: true, state });
    expect(order).toEqual(['prepare', 'test', 'commit', 'complete']);
    expect(runtime.prepareConversationConnection).toHaveBeenCalledWith(
      'D:\\ProjectA',
      conversationId,
      expect.any(Function),
      'D:\\ProjectA',
    );
  });

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
