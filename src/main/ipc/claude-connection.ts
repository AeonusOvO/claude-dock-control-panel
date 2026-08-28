import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  ClaudeConfigResult,
  ClaudeConversationModelApplyResult,
  ClaudeConnectionTestResult,
  ClaudeConnectionHistoryResult,
  ClaudeNextConversationConnectionResult,
  ClaudeOperationResult,
  ClaudeProjectState,
} from '../../shared/contracts';
import type { RunClaudeProjectConfigTransaction } from '../claude/config-transaction';
import { applyConversationModelConnection } from '../claude/conversation-model-application';
import type { ReportClaudeOperationFailure } from '../claude/operation-failure';
import type { PreparedClaudeConfigSave } from '../claude/runtime';
import {
  claudeNetworkAccessForConfigInput,
  resolveSessionConnectionConfigScope,
} from '../claude/runtime-connection-config';
import { type ClaudeNetworkAccess, effectiveClaudeNetworkAccess } from '../claude/runtime-types';
import type { WithSessionOperation } from '../coordination/session-operation';
import { createFailureReporter } from '../infra/logger';
import { resolveDirectory } from '../infra/directory';
import { guardedAutomaticConnectionFetch } from '../network/automatic-connection-access';
import { claudeOfficialAuthProvider } from '../claude/official-auth-status';
import type { TerminalWorkspace } from '../terminal/workspace';
import {
  validateClaudeConfigInput,
  validateConversationId,
  validateHistoryEntryId,
  validateProjectPath,
  validateSessionId,
} from './validation';
import type { MainGuards } from './guards';

export interface ClaudeConnectionIpcDependencies {
  claudeFailure: ReportClaudeOperationFailure;
  /* Recovers the state a rolled-back transaction already published, so the reply is not a stale read. */
  configTransactionState: (error: unknown) => ClaudeProjectState | undefined;
  guards: Pick<
    MainGuards,
    | 'assertExternalRoutingWritesAllowed'
    | 'requireClaudeRuntime'
    | 'validateSender'
    | 'withOfficialProviderAccess'
  >;
  invalidateAndWaitForMatchingDevelopmentSessionOperation: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
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

const registerConnectionHistoryApplyIpc = ({
  configTransactionState,
  guards: { requireClaudeRuntime, validateSender, withOfficialProviderAccess },
  invalidateAndWaitForMatchingDevelopmentSessionOperation,
  runClaudeProjectConfigTransaction,
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeConnectionIpcDependencies): void => {
  const activeApplications = new Map<string, AbortSignal>();
  ipcMain.handle(
    CHANNELS.CLAUDE_CONNECTION_HISTORY_APPLY,
    async (event, sessionId: unknown, entryId: unknown): Promise<ClaudeConnectionHistoryResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      if (activeApplications.has(validatedSessionId)) {
        const message = '这条历史配置正在接入，请等待当前操作完成或先取消接入。';
        return {
          ...reportConfigurationFailure('environment', message),
          entries: runtime.getConnectionHistory(status.cwd),
          error: message,
          ok: false,
        };
      }
      let operationSignal: AbortSignal | undefined;
      let connectionTest: ClaudeConnectionTestResult | undefined;
      try {
        const validatedEntryId = validateHistoryEntryId(entryId);
        const state = await withDevelopmentSessionOperation(
          validatedSessionId,
          (assertCurrent, signal) => {
            operationSignal = signal;
            activeApplications.set(validatedSessionId, signal);
            return runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
              assertCurrent,
              commit: (prepared) =>
                runtime.commitPreparedConfig(status.cwd, prepared, validatedSessionId),
              complete: (prepared) =>
                runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
              cwd: status.cwd,
              prepare: () =>
                runtime.prepareConnectionHistory(status.cwd, validatedEntryId, assertCurrent),
              runtime,
              sessionId: validatedSessionId,
              validatePrepared: (prepared) =>
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
                  async () => {
                    connectionTest = await runtime.testPreparedConnection(
                      status.cwd,
                      prepared,
                      assertCurrent,
                      signal,
                      resolveSessionConnectionConfigScope(runtime, validatedSessionId, status.cwd),
                    );
                    const officialLoginDeferred =
                      !connectionTest.ok &&
                      connectionTest.tone === 'warning' &&
                      prepared.input.authMode === 'existing';
                    if (!connectionTest.ok && !officialLoginDeferred) {
                      throw new Error(connectionTest.message ?? '历史配置未通过真实连接测试。');
                    }
                  },
                ),
            });
          },
        );
        return {
          ...(connectionTest ? { connectionTest } : {}),
          entries: runtime.getConnectionHistory(status.cwd),
          ok: true,
          state,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法应用这条接入记录。';
        const state = configTransactionState(error);
        return {
          ...reportConfigurationFailure('environment', message, error),
          ...(connectionTest ? { connectionTest } : {}),
          entries: runtime.getConnectionHistory(status.cwd),
          error: message,
          ok: false,
          ...(state ? { state } : {}),
        };
      } finally {
        if (activeApplications.get(validatedSessionId) === operationSignal) {
          activeApplications.delete(validatedSessionId);
        }
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_CONNECTION_HISTORY_CANCEL_APPLY,
    async (event, sessionId: unknown): Promise<boolean> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      workspace.getStatus(validatedSessionId);
      const signal = activeApplications.get(validatedSessionId);
      if (!signal) return false;
      return invalidateAndWaitForMatchingDevelopmentSessionOperation(validatedSessionId, signal);
    },
  );
};

const registerConversationModelIpc = ({
  configTransactionState,
  guards: { requireClaudeRuntime, validateSender, withOfficialProviderAccess },
  runClaudeProjectConfigTransaction,
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeConnectionIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_CONVERSATION_MODEL_INSPECT,
    async (event, projectPath: unknown, conversationId: unknown, legacyModelHint: unknown) => {
      validateSender(event);
      const cwd = resolveDirectory(validateProjectPath(projectPath));
      const hint = typeof legacyModelHint === 'string' ? legacyModelHint : undefined;
      return requireClaudeRuntime().inspectConversationModel(
        cwd,
        validateConversationId(conversationId),
        hint,
      );
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_CONVERSATION_MODEL_APPLY,
    async (
      event,
      sessionId: unknown,
      conversationId: unknown,
      choice: unknown,
    ): Promise<ClaudeConversationModelApplyResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const validatedConversationId = validateConversationId(conversationId);
      if (choice !== 'use-conversation' && choice !== 'use-current') {
        throw new Error('历史对话模型选择无效。');
      }
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      let connectionTest: ClaudeConnectionTestResult | undefined;
      try {
        if (choice === 'use-current') {
          const state = await withDevelopmentSessionOperation(
            validatedSessionId,
            async (assertCurrent) => {
              await runtime.bindConversationToCurrent(
                status.cwd,
                validatedConversationId,
                resolveSessionConnectionConfigScope(runtime, validatedSessionId, status.cwd),
              );
              assertCurrent();
              return runtime.publishProjectState(validatedSessionId, status.cwd);
            },
          );
          return { choice, ok: true, state };
        }

        const applied = await applyConversationModelConnection({
          cwd: status.cwd,
          onConnectionTest: (result) => {
            connectionTest = result;
          },
          prepare: (assertCurrent) =>
            withOptionalNetworkAccess(
              withOfficialProviderAccess,
              { action: 'provider-switch', cwd: status.cwd },
              runtime.conversationNetworkAccess(status.cwd, validatedConversationId),
              assertCurrent,
              () =>
                runtime.prepareConversationConnection(
                  status.cwd,
                  validatedConversationId,
                  assertCurrent,
                  resolveSessionConnectionConfigScope(runtime, validatedSessionId, status.cwd),
                ),
            ),
          runClaudeProjectConfigTransaction,
          runtime,
          sessionId: validatedSessionId,
          withDevelopmentSessionOperation,
        });
        return {
          choice,
          ...(connectionTest ? { connectionTest } : {}),
          ok: true,
          state: applied.state,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法切换历史对话模型。';
        const state =
          configTransactionState(error) ??
          (await runtime.getState(validatedSessionId, workspace.getStatus(validatedSessionId).cwd));
        return {
          ...reportConfigurationFailure('environment', message, error),
          choice,
          ...(connectionTest ? { connectionTest } : {}),
          error: message,
          ok: false,
          state,
        };
      }
    },
  );
};

const registerNextConversationConnectionIpc = ({
  guards: {
    assertExternalRoutingWritesAllowed,
    requireClaudeRuntime,
    validateSender,
    withOfficialProviderAccess,
  },
}: ClaudeConnectionIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_SAVE_NEXT_CONFIG,
    async (event, input: unknown): Promise<ClaudeNextConversationConnectionResult> => {
      validateSender(event);
      const runtime = requireClaudeRuntime();
      try {
        assertExternalRoutingWritesAllowed();
        const validatedInput = validateClaudeConfigInput(input);
        if (validatedInput.preset === 'anthropic' && validatedInput.authMode === 'existing') {
          const auth = await claudeOfficialAuthProvider.getState();
          if (!auth.available || !auth.loggedIn) throw new Error('请先完成 Claude 官方账号登录。');
        }
        if (validatedInput.autoDetect) {
          const result = await runtime.verifyAndSaveNextConversationConfig(
            validatedInput,
            undefined,
            {
              automaticFetch: guardedAutomaticConnectionFetch(withOfficialProviderAccess),
            },
          );
          return {
            ...result,
            ok: result.connectionTest.ok,
            error: result.connectionTest.ok ? undefined : result.connectionTest.message,
          };
        }
        const networkAccess = claudeNetworkAccessForConfigInput(validatedInput);
        const state = await withOptionalNetworkAccess(
          withOfficialProviderAccess,
          { action: 'provider-switch', cwd: undefined, networkScope: 'application' },
          networkAccess,
          () => undefined,
          () => runtime.saveNextConversationConfig(validatedInput),
        );
        return { ok: true, state };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法保存下个对话接入。';
        return {
          ...reportConfigurationFailure('user-input', message, error),
          error: message,
          ok: false,
          state: await runtime.getNextConversationConnection(),
        };
      }
    },
  );
};

export const registerClaudeConnectionIpc = (
  dependencies: ClaudeConnectionIpcDependencies,
): void => {
  registerNextConversationConnectionIpc(dependencies);
  const {
    claudeFailure,
    configTransactionState,
    guards: {
      assertExternalRoutingWritesAllowed,
      requireClaudeRuntime,
      validateSender,
      withOfficialProviderAccess,
    },
    invalidateAndWaitForMatchingDevelopmentSessionOperation,
    runClaudeProjectConfigTransaction,
    withDevelopmentSessionOperation,
    workspace,
  } = dependencies;
  registerConversationModelIpc({
    claudeFailure,
    configTransactionState,
    guards: {
      assertExternalRoutingWritesAllowed,
      requireClaudeRuntime,
      validateSender,
      withOfficialProviderAccess,
    },
    invalidateAndWaitForMatchingDevelopmentSessionOperation,
    runClaudeProjectConfigTransaction,
    withDevelopmentSessionOperation,
    workspace,
  });
  ipcMain.handle(
    CHANNELS.CLAUDE_SAVE_CONFIG,
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeConfigResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedInput = validateClaudeConfigInput(input);
        if (validatedInput.autoDetect) {
          throw new Error('请在“模型”页自动配置新对话。');
        }
        const networkAccess = claudeNetworkAccessForConfigInput(validatedInput);
        const state = await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
          runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
            assertCurrent,
            commit: (prepared) =>
              runtime.commitPreparedConfig(status.cwd, prepared, validatedSessionId),
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
        let state = configTransactionState(error);
        if (!state) {
          const currentStatus = workspace.getStatus(validatedSessionId);
          state = await runtime.getState(validatedSessionId, currentStatus.cwd);
        }
        return {
          ...reportConfigurationFailure('user-input', message, error),
          error: message,
          ok: false,
          state,
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
  registerConnectionHistoryApplyIpc({
    claudeFailure,
    configTransactionState,
    guards: {
      assertExternalRoutingWritesAllowed,
      requireClaudeRuntime,
      validateSender,
      withOfficialProviderAccess,
    },
    invalidateAndWaitForMatchingDevelopmentSessionOperation,
    runClaudeProjectConfigTransaction,
    withDevelopmentSessionOperation,
    workspace,
  });
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
              runtime.commitAllowBypassPermissions(status.cwd, preparedAllowed, validatedSessionId),
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
