import type { ClaudeConnectionTestResult, ClaudeProjectState } from '../../shared/contracts';
import type { WithSessionOperation } from '../coordination/session-operation';
import type { RunClaudeProjectConfigTransaction } from './config-transaction';
import type { ClaudeRuntime, PreparedClaudeConfigSave } from './runtime';

export interface ApplyConversationModelConnectionInput {
  cwd: string;
  onConnectionTest?: (result: ClaudeConnectionTestResult) => void;
  prepare: (
    assertCurrent: () => void,
  ) => Promise<PreparedClaudeConfigSave> | PreparedClaudeConfigSave;
  runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  runtime: ClaudeRuntime;
  sessionId: string;
  withDevelopmentSessionOperation: WithSessionOperation;
}

export interface AppliedConversationModelConnection {
  connectionTest: ClaudeConnectionTestResult;
  state: ClaudeProjectState;
}

/**
 * Restores one conversation's prepared connection through the same tested, rollback-safe project
 * transaction whether the request came from a history click or the startup coordinator.
 */
export const applyConversationModelConnection = async ({
  cwd,
  onConnectionTest,
  prepare,
  runClaudeProjectConfigTransaction,
  runtime,
  sessionId,
  withDevelopmentSessionOperation,
}: ApplyConversationModelConnectionInput): Promise<AppliedConversationModelConnection> => {
  let connectionTest: ClaudeConnectionTestResult | undefined;
  const state = await withDevelopmentSessionOperation(sessionId, (assertCurrent, signal) =>
    runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
      assertCurrent,
      commit: (prepared) => runtime.commitPreparedConfig(cwd, prepared),
      complete: (prepared) => runtime.completePreparedConfigSave(sessionId, cwd, prepared),
      cwd,
      prepare: () => prepare(assertCurrent),
      runtime,
      sessionId,
      validatePrepared: async (prepared) => {
        connectionTest = await runtime.testPreparedConnection(cwd, prepared, assertCurrent, signal);
        onConnectionTest?.(connectionTest);
        const officialLoginDeferred =
          !connectionTest.ok &&
          connectionTest.tone === 'warning' &&
          prepared.input.authMode === 'existing';
        if (!connectionTest.ok && !officialLoginDeferred) {
          throw new Error(connectionTest.message ?? '对话原有模型未通过真实连接测试。');
        }
      },
    }),
  );
  if (!connectionTest) {
    throw new Error('对话原有模型连接测试没有返回结果。');
  }
  return { connectionTest, state };
};
