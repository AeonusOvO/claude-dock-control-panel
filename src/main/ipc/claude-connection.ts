import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  ClaudeConfigResult,
  ClaudeConnectionHistoryResult,
  ClaudeOperationResult,
  ClaudeProjectState,
} from '../../shared/contracts';
import type { RunClaudeProjectConfigTransaction } from '../claude/config-transaction';
import type { ReportClaudeOperationFailure } from '../claude/operation-failure';
import type { PreparedClaudeConfigSave } from '../claude/runtime';
import { claudeNetworkAccessForConfigInput } from '../claude/runtime-connection-config';
import { type ClaudeNetworkAccess, effectiveClaudeNetworkAccess } from '../claude/runtime-types';
import type { WithSessionOperation } from '../coordination/session-operation';
import { createFailureReporter } from '../infra/logger';
import type { TerminalWorkspace } from '../terminal/workspace';
import { validateClaudeConfigInput, validateHistoryEntryId, validateSessionId } from './validation';
import type { MainGuards } from './guards';

export interface ClaudeConnectionIpcDependencies {
  claudeFailure: ReportClaudeOperationFailure;
  /* Recovers the state a rolled-back transaction already published, so the reply is not a stale read. */
  configTransactionState: (error: unknown) => ClaudeProjectState | undefined;
  guards: Pick<
    MainGuards,
    'requireClaudeRuntime' | 'validateSender' | 'withOfficialProviderAccess'
  >;
  runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
}

const reportConfigurationFailure = createFailureReporter('claude-configuration');

type ProviderAccessRequest = Parameters<MainGuards['withOfficialProviderAccess']>[0];

const withOptionalNetworkAccess = <T>(
  withOfficialProviderAccess: MainGuards['withOfficialProviderAccess'],
  request: Omit<ProviderAccessRequest, 'provider' | 'target'>,
  access: Readonly<ClaudeNetworkAccess> | undefined,
  assertCurrent: () => void,
  operation: () => Promise<T> | T,
): Promise<T> | T => {
  if (!access) return operation();
  return withOfficialProviderAccess({ ...request, ...access }, () => {
    assertCurrent();
    return operation();
  });
};

export const registerClaudeConnectionIpc = ({
  claudeFailure,
  configTransactionState,
  guards: { requireClaudeRuntime, validateSender, withOfficialProviderAccess },
  runClaudeProjectConfigTransaction,
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeConnectionIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_SAVE_CONFIG,
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeConfigResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedInput = validateClaudeConfigInput(input);
        const networkAccess = claudeNetworkAccessForConfigInput(validatedInput);
        const state = await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
          runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
            assertCurrent,
            commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
            complete: (prepared) =>
              runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
            cwd: status.cwd,
            prepare: () =>
              withOptionalNetworkAccess(
                withOfficialProviderAccess,
                { action: 'provider-switch', cwd: status.cwd },
                networkAccess,
                assertCurrent,
                () => runtime.prepareConnectionConfig(validatedInput, undefined, assertCurrent),
              ),
            runtime,
            sessionId: validatedSessionId,
          }),
        );
        return { ok: true, state };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法保存 Claude 接入配置。';
        return {
          ...reportConfigurationFailure('user-input', message, error),
          error: message,
          ok: false,
          state:
            configTransactionState(error) ??
            (await runtime.getState(validatedSessionId, status.cwd)),
        };
      }
    },
  );
  ipcMain.handle(CHANNELS.CLAUDE_CONNECTION_HISTORY, async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getConnectionHistory(status.cwd);
  });
  ipcMain.handle(
    CHANNELS.CLAUDE_CONNECTION_HISTORY_APPLY,
    async (event, sessionId: unknown, entryId: unknown): Promise<ClaudeConnectionHistoryResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedEntryId = validateHistoryEntryId(entryId);
        const state = await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
          runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
            assertCurrent,
            commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
            complete: (prepared) =>
              runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
            cwd: status.cwd,
            prepare: () =>
              withOptionalNetworkAccess(
                withOfficialProviderAccess,
                { action: 'provider-switch', cwd: status.cwd },
                typeof runtime.connectionHistoryNetworkAccess === 'function'
                  ? runtime.connectionHistoryNetworkAccess(status.cwd, validatedEntryId)
                  : effectiveClaudeNetworkAccess(
                      undefined,
                      runtime.connectionHistoryOfficialNetworkProvider(
                        status.cwd,
                        validatedEntryId,
                      ),
                    ),
                assertCurrent,
                () => runtime.prepareConnectionHistory(status.cwd, validatedEntryId, assertCurrent),
              ),
            runtime,
            sessionId: validatedSessionId,
          }),
        );
        return { entries: runtime.getConnectionHistory(status.cwd), ok: true, state };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法应用这条接入记录。';
        const state = configTransactionState(error);
        return {
          ...reportConfigurationFailure('environment', message, error),
          entries: runtime.getConnectionHistory(status.cwd),
          error: message,
          ok: false,
          ...(state ? { state } : {}),
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_CONNECTION_HISTORY_DELETE,
    async (event, sessionId: unknown, entryId: unknown): Promise<ClaudeConnectionHistoryResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        return {
          entries: runtime.deleteConnectionHistory(status.cwd, validateHistoryEntryId(entryId)),
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法删除这条接入记录。';
        return {
          ...reportConfigurationFailure('environment', message, error),
          entries: runtime.getConnectionHistory(status.cwd),
          error: message,
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_CONNECTION_HISTORY_RENAME,
    async (
      event,
      sessionId: unknown,
      entryId: unknown,
      name: unknown,
    ): Promise<ClaudeConnectionHistoryResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        if (typeof name !== 'string') {
          throw new Error('连接名称格式无效。');
        }
        return {
          entries: runtime.renameConnectionHistory(
            status.cwd,
            validateHistoryEntryId(entryId),
            name,
          ),
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法重命名这条接入记录。';
        return {
          ...reportConfigurationFailure('user-input', message, error),
          entries: runtime.getConnectionHistory(status.cwd),
          error: message,
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_SET_ALLOW_BYPASS_PERMISSIONS,
    async (event, sessionId: unknown, allowed: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        if (typeof allowed !== 'boolean') {
          throw new Error('放权开关的取值无效。');
        }
        const state = await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
          runClaudeProjectConfigTransaction<boolean>({
            assertCurrent,
            commit: (preparedAllowed) =>
              runtime.commitAllowBypassPermissions(status.cwd, preparedAllowed),
            complete: () => runtime.publishProjectState(validatedSessionId, status.cwd),
            cwd: status.cwd,
            prepare: () => allowed,
            runtime,
            sessionId: validatedSessionId,
          }),
        );
        return { ok: true, state };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
};
