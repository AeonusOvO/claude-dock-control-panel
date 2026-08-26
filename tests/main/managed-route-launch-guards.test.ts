import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectDirectoryLifecycleCoordinator } from '../../src/main/coordination/project-directory-lifecycle';
import type { MainGuards } from '../../src/main/ipc/guards';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

const installElectronMock = () => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
  return ipc;
};

const nativeConversationId = '44444444-4444-4444-8444-444444444444';
const nativeSubmitInput = (clientSubmissionId: string) => ({
  blocks: [{ text: '继续执行', type: 'text' as const }],
  clientSubmissionId,
});
const nativeLaunch = (
  officialNetworkProvider?: 'anthropic-claude' | 'openai-codex',
  officialNetworkTarget?: { readonly process: 'application'; readonly url: string },
) => ({
  ownerId: 'main-owned-native-route',
  prepared: { officialNetworkProvider, officialNetworkTarget },
});

interface NativeSubmitHarnessOptions {
  readonly nativeLaunches?: Map<string, unknown>;
  readonly projectPath?: string;
  readonly submitAndWaitForTurn?: (conversationId: string, input: unknown) => Promise<unknown>;
  readonly validateSender?: () => void;
  readonly withOfficialProviderAccess?: (
    request: unknown,
    operation: () => Promise<unknown>,
  ) => Promise<unknown>;
}

const registerNativeSubmitHarness = async ({
  nativeLaunches = new Map(),
  projectPath = 'D:\\MainOwned\\Project',
  submitAndWaitForTurn = vi.fn(async () => ({ ok: true })),
  validateSender = vi.fn(),
  withOfficialProviderAccess = vi.fn(async (_request, operation) => operation()),
}: NativeSubmitHarnessOptions = {}) => {
  const ipc = installElectronMock();
  const { registerConversationIpc } = await import('../../src/main/ipc/conversation');
  const projectPathForActiveConversation = vi.fn(() => projectPath);
  const service = { projectPathForActiveConversation, submitAndWaitForTurn };

  registerConversationIpc({
    conversationOwnerRegistry: {} as never,
    guards: {
      assertLaunchAdmissionAllowed: vi.fn(),
      requireClaudeRuntime: vi.fn() as never,
      requireNativeConversationService: vi.fn(() => service) as never,
      validateSender,
      withOfficialProviderAccess: withOfficialProviderAccess as never,
    },
    invalidateAndWaitForDevelopmentSessionOperation: vi.fn(),
    nativeAttachmentStore: { resolve: vi.fn() } as never,
    nativeLaunches: nativeLaunches as never,
    runClaudeResumeLaunch: vi.fn(),
    runtimeActivityRegistry: {} as never,
    runtimeProfile: { adapterMode: 'production' } as never,
    services: {} as never,
    sessionManager: {} as never,
    terminalConversationOwners: new Map(),
    terminalTransferSessions: new Set(),
    withDevelopmentSessionOperation: vi.fn() as never,
    workspace: {} as never,
    workspaceStore: {} as never,
  });

  return {
    ipc,
    projectPathForActiveConversation,
    submitAndWaitForTurn,
    validateSender,
    withOfficialProviderAccess,
  };
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('managed route launch guards', () => {
  it('opens a stored-conversation tab without duplicating the shared guarded launch path', async () => {
    const ipc = installElectronMock();
    const { registerProjectIpc } = await import('../../src/main/ipc/project');
    const projectPath = path.resolve('.');
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const openConversation = vi.fn();
    const withOfficialProviderAccess = vi.fn();
    const state = {
      activeSessionId: 'stored-session',
      projects: [],
      sessions: [
        {
          cwd: projectPath,
          id: 'stored-session',
          phase: 'stopped',
          ptyGeneration: 1,
          title: '历史会话',
        },
      ],
    };

    registerProjectIpc({
      activateProject: vi.fn() as never,
      addProject: vi.fn() as never,
      agentRuntimeStore: { get: vi.fn(() => 'claude') } as never,
      claudeConversationLifecycle: {} as never,
      conversationOwnerRegistry: {
        ownerFor: vi.fn(() => undefined),
      } as never,
      describeWorkspace: vi.fn(() => state) as never,
      failedRuntimeLaunchCleanupDependencies: {} as never,
      failedWorkspaceResult: vi.fn((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      })) as never,
      guards: {
        withOfficialProviderAccess,
        requireClaudeRuntime: vi.fn() as never,
        requireCodexRuntime: vi.fn() as never,
        validateSender: vi.fn(),
      },
      invalidateAndWaitForDevelopmentSessionOperation: vi.fn(),
      invalidateLaunchPreflightDecision: vi.fn(),
      managedConfigTransactions: {
        assertDevelopmentOperationAllowed: vi.fn(),
      } as never,
      projectDirectoryLifecycle: new ProjectDirectoryLifecycleCoordinator(),
      releaseTerminalConversationOwner: vi.fn(),
      restartRuntimeTerminal: vi.fn(),
      services: {} as never,
      terminalConversationOwners: new Map(),
      withDevelopmentSessionOperation: vi.fn() as never,
      workspace: {
        getState: vi.fn(() => state),
        openConversation,
      } as never,
      workspaceStore: { addProject: vi.fn() } as never,
    });

    await expect(
      ipc.invoke(CHANNELS.PROJECT_OPEN_STORED_CONVERSATION, projectPath, conversationId),
    ).resolves.toMatchObject({ ok: true, state });

    expect(openConversation).toHaveBeenCalledWith(projectPath, '历史 11111111', 'claude');
    expect(withOfficialProviderAccess).not.toHaveBeenCalled();
  });

  it('blocks native-to-terminal transfer before stopping the native runtime', async () => {
    const ipc = installElectronMock();
    const { registerConversationIpc } = await import('../../src/main/ipc/conversation');
    const projectPath = path.resolve('D:\\Project');
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const transferToTerminal = vi.fn(async (...args: unknown[]) => {
      const startTerminal = args[2] as (identity: {
        conversationId: string;
        projectPath: string;
      }) => Promise<unknown>;
      const authorize = args[4] as
        | (<T>(
            identity: { conversationId: string; projectPath: string },
            operation: () => Promise<T> | T,
          ) => Promise<T>)
        | undefined;
      const identity = { conversationId, projectPath };
      if (authorize) {
        await authorize(identity, () => startTerminal(identity));
      } else {
        await startTerminal(identity);
      }
      return { ok: true };
    });
    const runClaudeResumeLaunch = vi.fn();
    const withOfficialProviderAccess: MainGuards['withOfficialProviderAccess'] = vi.fn(async () => {
      throw new Error('network blocked');
    });

    registerConversationIpc({
      conversationOwnerRegistry: {} as never,
      guards: {
        assertLaunchAdmissionAllowed: vi.fn(),
        withOfficialProviderAccess,
        requireClaudeRuntime: vi.fn(() => ({
          officialNetworkProvider: vi.fn(() => 'openai-codex'),
        })) as never,
        requireNativeConversationService: vi.fn(() => ({
          getSnapshot: vi.fn(() => ({ phase: 'idle', projectPath, tasks: [] })),
          transferToTerminal,
        })) as never,
        validateSender: vi.fn(),
      },
      invalidateAndWaitForDevelopmentSessionOperation: vi.fn(),
      nativeAttachmentStore: {} as never,
      nativeLaunches: new Map(),
      runClaudeResumeLaunch,
      runtimeActivityRegistry: {} as never,
      runtimeProfile: { adapterMode: 'production' } as never,
      services: {} as never,
      sessionManager: {} as never,
      terminalConversationOwners: new Map(),
      terminalTransferSessions: new Set(),
      withDevelopmentSessionOperation: vi.fn() as never,
      workspace: {} as never,
      workspaceStore: {} as never,
    });

    await expect(
      ipc.invoke(
        CHANNELS.NATIVE_CONVERSATION_TRANSFER_TO_TERMINAL,
        conversationId,
        undefined,
        false,
      ),
    ).rejects.toThrow('network blocked');

    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      { action: 'cli-launch', cwd: projectPath, provider: 'openai-codex' },
      expect.any(Function),
    );
    expect(transferToTerminal).toHaveBeenCalledOnce();
    expect(runClaudeResumeLaunch).not.toHaveBeenCalled();
  });

  it('asks for interruption confirmation before running a transfer preflight', async () => {
    const ipc = installElectronMock();
    const { registerConversationIpc } = await import('../../src/main/ipc/conversation');
    const conversationId = '33333333-3333-4333-8333-333333333333';
    const requiresConfirmation = { ok: false, requiresConfirmation: true };
    const transferToTerminal = vi.fn(async () => requiresConfirmation);
    const withOfficialProviderAccess = vi.fn(
      async <T>(
        _request: Parameters<MainGuards['withOfficialProviderAccess']>[0],
        operation: () => Promise<T> | T,
      ): Promise<T> => operation(),
    ) as unknown as MainGuards['withOfficialProviderAccess'];

    registerConversationIpc({
      conversationOwnerRegistry: {} as never,
      guards: {
        assertLaunchAdmissionAllowed: vi.fn(),
        withOfficialProviderAccess,
        requireClaudeRuntime: vi.fn() as never,
        requireNativeConversationService: vi.fn(() => ({
          getSnapshot: vi.fn(() => ({ phase: 'running', projectPath: 'D:\\Project', tasks: [] })),
          transferToTerminal,
        })) as never,
        validateSender: vi.fn(),
      },
      invalidateAndWaitForDevelopmentSessionOperation: vi.fn(),
      nativeAttachmentStore: {} as never,
      nativeLaunches: new Map(),
      runClaudeResumeLaunch: vi.fn(),
      runtimeActivityRegistry: {} as never,
      runtimeProfile: { adapterMode: 'production' } as never,
      services: {} as never,
      sessionManager: {} as never,
      terminalConversationOwners: new Map(),
      terminalTransferSessions: new Set(),
      withDevelopmentSessionOperation: vi.fn() as never,
      workspace: {} as never,
      workspaceStore: {} as never,
    });

    await expect(
      ipc.invoke(
        CHANNELS.NATIVE_CONVERSATION_TRANSFER_TO_TERMINAL,
        conversationId,
        undefined,
        false,
      ),
    ).resolves.toEqual(requiresConfirmation);

    expect(withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(transferToTerminal).toHaveBeenCalledOnce();
  });

  it('authorizes each native turn from exact main-owned provider, path, action, and target', async () => {
    const target = {
      process: 'application' as const,
      url: 'https://api.anthropic.com/v1/messages',
    };
    const nativeLaunches = new Map([
      [nativeConversationId, nativeLaunch('anthropic-claude', target)],
    ]);
    const withOfficialProviderAccess = vi.fn(async (_request, operation: () => Promise<unknown>) =>
      operation(),
    );
    const submitAndWaitForTurn = vi.fn(async () => ({ ok: true }));
    const harness = await registerNativeSubmitHarness({
      nativeLaunches,
      projectPath: 'D:\\MainOwned\\ExactProject',
      submitAndWaitForTurn,
      withOfficialProviderAccess,
    });

    await expect(
      harness.ipc.invoke(
        CHANNELS.NATIVE_CONVERSATION_SUBMIT,
        nativeConversationId,
        nativeSubmitInput('native-turn-1'),
      ),
    ).resolves.toEqual({ ok: true });

    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      {
        action: 'first-request',
        cwd: 'D:\\MainOwned\\ExactProject',
        provider: 'anthropic-claude',
        target,
      },
      expect.any(Function),
    );
    expect(submitAndWaitForTurn).toHaveBeenCalledWith(
      nativeConversationId,
      nativeSubmitInput('native-turn-1'),
    );
  });

  it('does not submit a native turn when exact provider access is blocked', async () => {
    const blocked = new Error('native provider blocked');
    const submitAndWaitForTurn = vi.fn(async () => ({ ok: true }));
    const harness = await registerNativeSubmitHarness({
      nativeLaunches: new Map([[nativeConversationId, nativeLaunch('anthropic-claude')]]),
      submitAndWaitForTurn,
      withOfficialProviderAccess: vi.fn(async () => {
        throw blocked;
      }),
    });

    await expect(
      harness.ipc.invoke(
        CHANNELS.NATIVE_CONVERSATION_SUBMIT,
        nativeConversationId,
        nativeSubmitInput('native-turn-blocked'),
      ),
    ).rejects.toThrow(blocked.message);
    expect(submitAndWaitForTurn).not.toHaveBeenCalled();
  });

  it('submits custom native routes directly when main captured no official provider', async () => {
    const submitAndWaitForTurn = vi.fn(async () => ({ ok: true }));
    const harness = await registerNativeSubmitHarness({
      nativeLaunches: new Map([[nativeConversationId, nativeLaunch()]]),
      submitAndWaitForTurn,
    });

    await expect(
      harness.ipc.invoke(
        CHANNELS.NATIVE_CONVERSATION_SUBMIT,
        nativeConversationId,
        nativeSubmitInput('native-turn-custom'),
      ),
    ).resolves.toEqual({ ok: true });
    expect(harness.withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(submitAndWaitForTurn).toHaveBeenCalledOnce();
  });

  it('fails closed when a production native conversation loses its main-owned launch record', async () => {
    const submitAndWaitForTurn = vi.fn(async () => ({ ok: true }));
    const harness = await registerNativeSubmitHarness({ submitAndWaitForTurn });

    await expect(
      harness.ipc.invoke(
        CHANNELS.NATIVE_CONVERSATION_SUBMIT,
        nativeConversationId,
        nativeSubmitInput('native-turn-missing-launch'),
      ),
    ).rejects.toThrow('主进程接入授权已经失效');
    expect(harness.withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(submitAndWaitForTurn).not.toHaveBeenCalled();
  });

  it('rejects renderer authority fields instead of forwarding them into a native turn', async () => {
    const submitAndWaitForTurn = vi.fn(async () => ({ ok: true }));
    const harness = await registerNativeSubmitHarness({
      nativeLaunches: new Map([[nativeConversationId, nativeLaunch('anthropic-claude')]]),
      submitAndWaitForTurn,
    });

    await expect(
      harness.ipc.invoke(CHANNELS.NATIVE_CONVERSATION_SUBMIT, nativeConversationId, {
        ...nativeSubmitInput('native-turn-injected'),
        action: 'background',
        cwd: 'D:\\Renderer\\Injected',
        provider: 'openai-codex',
        target: { process: 'application', url: 'https://renderer.invalid' },
      } as never),
    ).rejects.toThrow('未授权字段');
    expect(harness.withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(submitAndWaitForTurn).not.toHaveBeenCalled();
  });

  it('validates the sender before native turn parsing or main-owned conversation lookup', async () => {
    const senderError = new Error('invalid sender');
    const harness = await registerNativeSubmitHarness({
      validateSender: vi.fn(() => {
        throw senderError;
      }),
    });

    await expect(
      harness.ipc.invoke(CHANNELS.NATIVE_CONVERSATION_SUBMIT, 'not-a-conversation', {
        provider: 'openai-codex',
      } as never),
    ).rejects.toThrow(senderError.message);
    expect(harness.projectPathForActiveConversation).not.toHaveBeenCalled();
    expect(harness.withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(harness.submitAndWaitForTurn).not.toHaveBeenCalled();
  });

  it('reacquires fresh main-owned provider authority for every reusable native turn', async () => {
    const submitAndWaitForTurn = vi.fn(async (_conversationId: string, _input: unknown) => ({
      ok: true,
    }));
    const withOfficialProviderAccess = vi.fn(async (_request, operation: () => Promise<unknown>) =>
      operation(),
    );
    const harness = await registerNativeSubmitHarness({
      nativeLaunches: new Map([[nativeConversationId, nativeLaunch('anthropic-claude')]]),
      submitAndWaitForTurn,
      withOfficialProviderAccess,
    });

    await harness.ipc.invoke(
      CHANNELS.NATIVE_CONVERSATION_SUBMIT,
      nativeConversationId,
      nativeSubmitInput('native-turn-repeat-1'),
    );
    await harness.ipc.invoke(
      CHANNELS.NATIVE_CONVERSATION_SUBMIT,
      nativeConversationId,
      nativeSubmitInput('native-turn-repeat-2'),
    );

    expect(withOfficialProviderAccess).toHaveBeenCalledTimes(2);
    expect(submitAndWaitForTurn).toHaveBeenCalledTimes(2);
    expect(submitAndWaitForTurn.mock.calls.map((call) => call[1])).toEqual([
      nativeSubmitInput('native-turn-repeat-1'),
      nativeSubmitInput('native-turn-repeat-2'),
    ]);
  });
});
