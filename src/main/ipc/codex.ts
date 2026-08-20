import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain, shell } from 'electron';
import type {
  CodexLoginStartResult,
  CodexOperationResult,
  PtyGeneration,
} from '../../shared/contracts';
import type { WithSessionOperation } from '../coordination/session-operation';
import { createFailureReporter } from '../infra/logger';
import type { AgentRuntimeStore } from '../runtime/store';
import {
  cleanupFailedRuntimeLaunch,
  type FailedRuntimeLaunchCleanupDependencies,
  type RestartRuntimeTerminal,
} from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';
import { validateCodexLaunchMode, validateCodexLoginMethod, validateSessionId } from './validation';
import type { MainGuards } from './guards';

export interface CodexIpcDependencies {
  agentRuntimeStore: AgentRuntimeStore;
  /* Shared with every other runtime launch, all of which unwind the same terminal ownership. */
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  guards: Pick<
    MainGuards,
    | 'assertApplicationUpdatesAllowed'
    | 'assertOfficialProviderAllowed'
    | 'assertRealRuntimeAllowed'
    | 'requireCodexRuntime'
    | 'validateSender'
  >;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
}

const reportCodexFailure = createFailureReporter('codex');

export const registerCodexIpc = ({
  agentRuntimeStore,
  failedRuntimeLaunchCleanupDependencies,
  guards: {
    assertApplicationUpdatesAllowed,
    assertOfficialProviderAllowed,
    assertRealRuntimeAllowed,
    requireCodexRuntime,
    validateSender,
  },
  restartRuntimeTerminal,
  withDevelopmentSessionOperation,
  workspace,
}: CodexIpcDependencies): void => {
  const codexFailure = async (sessionId: string, error: unknown): Promise<CodexOperationResult> => {
    const runtime = requireCodexRuntime();
    const status = workspace.getStatus(sessionId);
    const message = error instanceof Error ? error.message : 'Codex 操作失败。';
    return {
      ...reportCodexFailure('environment', message, error),
      error: message,
      ok: false,
      state: await runtime.getState(sessionId, status.cwd),
    };
  };
  ipcMain.handle(CHANNELS.CODEX_GET_STATE, async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireCodexRuntime().getState(validatedSessionId, status.cwd);
  });
  ipcMain.handle(
    CHANNELS.CODEX_INSTALL_UPDATE,
    async (event, sessionId: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        assertApplicationUpdatesAllowed();
        return {
          ok: true,
          state: await requireCodexRuntime().installOrUpdate(validatedSessionId, status.cwd),
        };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CODEX_LOGIN_START,
    async (event, sessionId: unknown, method: unknown): Promise<CodexLoginStartResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      assertRealRuntimeAllowed();
      const status = workspace.getStatus(validatedSessionId);
      try {
        await assertOfficialProviderAllowed('openai-codex', 'login', status.cwd);
        const prepared = await requireCodexRuntime().startLogin(
          validatedSessionId,
          status.cwd,
          validateCodexLoginMethod(method),
        );
        let openedBrowser = false;
        if (prepared.externalUrl) {
          await shell.openExternal(prepared.externalUrl);
          openedBrowser = true;
        }
        return { ok: true, openedBrowser, state: prepared.state };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CODEX_LOGIN_CANCEL,
    async (event, sessionId: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      assertRealRuntimeAllowed();
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await requireCodexRuntime().cancelLogin(validatedSessionId, status.cwd),
        };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CODEX_LOGOUT,
    async (event, sessionId: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      assertRealRuntimeAllowed();
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await requireCodexRuntime().logout(validatedSessionId, status.cwd),
        };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CODEX_LAUNCH,
    async (event, sessionId: unknown, mode: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireCodexRuntime();
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let launchPrepared = false;
          let ownedGeneration: PtyGeneration | undefined;
          try {
            if (agentRuntimeStore.get(status.cwd) !== 'codex') {
              throw new Error('当前项目尚未选择 Codex 开发引擎。');
            }
            await assertOfficialProviderAllowed('openai-codex', 'cli-launch', status.cwd);
            assertCurrent();
            const prepared = await runtime.prepareLaunch(
              validatedSessionId,
              status.cwd,
              validateCodexLaunchMode(mode),
            );
            launchPrepared = true;
            ownedGeneration = prepared.predecessorPtyGeneration;
            assertCurrent();
            if (agentRuntimeStore.get(status.cwd) !== 'codex') {
              throw new Error('当前项目已切换开发引擎，这次 Codex 启动已取消。');
            }
            restartRuntimeTerminal(
              runtime,
              validatedSessionId,
              prepared.environment,
              prepared.command,
              '无法为 Codex 启动安全终端。',
              assertCurrent,
              (ptyGeneration) => {
                ownedGeneration = ptyGeneration;
              },
            );
            const state = await runtime.getState(validatedSessionId, status.cwd);
            assertCurrent();
            return { ok: true, state };
          } catch (error) {
            if (launchPrepared || ownedGeneration !== undefined) {
              cleanupFailedRuntimeLaunch(
                failedRuntimeLaunchCleanupDependencies,
                runtime,
                validatedSessionId,
                ownedGeneration,
              );
            }
            return codexFailure(validatedSessionId, error);
          }
        });
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
};
