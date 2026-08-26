import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain, shell } from 'electron';
import type {
  CodexLoginStartResult,
  CodexOperationResult,
  PtyGeneration,
} from '../../shared/contracts';
import type { WithSessionOperation } from '../coordination/session-operation';
import { createFailureReporter } from '../infra/logger';
import {
  cleanupFailedRuntimeLaunch,
  type FailedRuntimeLaunchCleanupDependencies,
  type RestartRuntimeTerminal,
} from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';
import {
  validateCodexInstallOperation,
  validateCodexLaunchMode,
  validateCodexLoginMethod,
  validateSessionId,
} from './validation';
import type { MainGuards } from './guards';

export interface CodexIpcDependencies {
  /* Shared with every other runtime launch, all of which unwind the same terminal ownership. */
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  guards: Pick<
    MainGuards,
    | 'assertApplicationUpdatesAllowed'
    | 'assertRealRuntimeAllowed'
    | 'withOfficialProviderAccess'
    | 'requireCodexRuntime'
    | 'validateSender'
  >;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
}

const reportCodexFailure = createFailureReporter('codex');

export const registerCodexIpc = ({
  failedRuntimeLaunchCleanupDependencies,
  guards: {
    assertApplicationUpdatesAllowed,
    assertRealRuntimeAllowed,
    requireCodexRuntime,
    validateSender,
    withOfficialProviderAccess,
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
    async (event, sessionId: unknown, operation: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const validatedOperation = validateCodexInstallOperation(operation);
      const status = workspace.getStatus(validatedSessionId);
      try {
        assertApplicationUpdatesAllowed();
        return {
          ok: true,
          state: await requireCodexRuntime().installOrUpdate(
            validatedSessionId,
            status.cwd,
            validatedOperation,
          ),
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
        return await withOfficialProviderAccess(
          { action: 'login', cwd: status.cwd, provider: 'openai-codex' },
          async () => {
            const runtime = requireCodexRuntime();
            const prepared = await runtime.startLogin(
              validatedSessionId,
              status.cwd,
              validateCodexLoginMethod(method),
            );
            let openedBrowser = false;
            if (prepared.externalUrl) {
              if (!runtime.isLoginAttemptCurrent(prepared.attempt)) {
                throw new Error('这次 ChatGPT 登录已经被取消或取代。');
              }
              await shell.openExternal(prepared.externalUrl);
              openedBrowser = true;
            }
            return { ok: true, openedBrowser, state: prepared.state };
          },
        );
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
            if (workspace.getDevelopmentRuntime(validatedSessionId) !== 'codex') {
              throw new Error('这个对话不是使用 Codex 创建的。');
            }
            return await withOfficialProviderAccess(
              { action: 'cli-launch', cwd: status.cwd, provider: 'openai-codex' },
              async () => {
                assertCurrent();
                const prepared = await runtime.prepareLaunch(
                  validatedSessionId,
                  status.cwd,
                  validateCodexLaunchMode(mode),
                );
                launchPrepared = true;
                ownedGeneration = prepared.predecessorPtyGeneration;
                assertCurrent();
                if (workspace.getDevelopmentRuntime(validatedSessionId) !== 'codex') {
                  throw new Error('这个对话的开发引擎已变化，这次 Codex 启动已取消。');
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
              },
            );
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
