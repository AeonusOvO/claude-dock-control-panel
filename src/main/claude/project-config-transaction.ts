import type { ClaudeProjectState } from '../../shared/contracts';
import {
  OwnedConfigTransactionError,
  runOwnedConfigTransaction,
  SessionConfigTransactionCoordinator,
} from '../coordination/main-process-operation';
import type { MainGuards } from '../ipc/guards';
import { sameDirectory, type TerminalWorkspace } from '../terminal/workspace';
import type {
  ClaudeProjectConfigTransactionOptions,
  RunClaudeProjectConfigTransaction,
} from './config-transaction';
import { resolveSessionConnectionConfigScope } from './runtime-connection-config';

export interface ClaudeProjectConfigTransactionDependencies {
  acquireConfigTransactionIsolation: (sessionId: string, cwd: string) => Promise<void>;
  guards: Pick<MainGuards, 'assertExternalRoutingWritesAllowed'>;
  managedConfigTransactions: SessionConfigTransactionCoordinator;
  publishRestoredClaudeProjectState: (state: ClaudeProjectState) => void;
  workspace: TerminalWorkspace;
}

/**
 * A failed transaction that rolled back carries the state it restored, so the handler can answer with
 * the project's real configuration instead of a bare error.
 */
export const configTransactionState = (error: unknown): ClaudeProjectState | undefined =>
  error instanceof OwnedConfigTransactionError
    ? (error.state as ClaudeProjectState | undefined)
    : undefined;

export const createRunClaudeProjectConfigTransaction = ({
  acquireConfigTransactionIsolation,
  guards: { assertExternalRoutingWritesAllowed },
  managedConfigTransactions,
  publishRestoredClaudeProjectState,
  workspace,
}: ClaudeProjectConfigTransactionDependencies): RunClaudeProjectConfigTransaction => {
  const conversationConfigTransactions = new SessionConfigTransactionCoordinator();
  const runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction = <TPrepared>(
    options: ClaudeProjectConfigTransactionOptions<TPrepared>,
  ): Promise<ClaudeProjectState> => {
    assertExternalRoutingWritesAllowed();
    const configScope =
      options.configScope ??
      resolveSessionConnectionConfigScope(options.runtime, options.sessionId, options.cwd);
    const conversationOwned = !sameDirectory(configScope, options.cwd);
    const assertTargetCurrent = (): void => {
      const currentStatus = workspace.getStatus(options.sessionId);
      if (!sameDirectory(currentStatus.cwd, options.cwd)) {
        throw new Error('配置事务已不再拥有发起操作时的项目会话。');
      }
    };
    const assertTransactionCurrent = (): void => {
      options.assertCurrent();
      assertTargetCurrent();
    };
    return runOwnedConfigTransaction({
      // A conversation profile is not shared by its folder's other terminals. Only legacy
      // project-profile writes need the directory barrier and sibling-launch cancellation.
      ...(conversationOwned
        ? {}
        : {
            acquireIsolation: () =>
              acquireConfigTransactionIsolation(options.sessionId, options.cwd),
          }),
      assertOperationOwnership: assertTransactionCurrent,
      assertRollbackOwnership: assertTargetCurrent,
      commit: options.commit,
      complete: options.complete,
      coordinator: conversationOwned ? conversationConfigTransactions : managedConfigTransactions,
      createSnapshot: () => options.runtime.createConfigSnapshot(configScope),
      cwd: configScope,
      mergeCompletionSnapshot: (committed, completed) =>
        options.runtime.mergeConfigCompletionSnapshot(committed, completed),
      prepare: options.prepare,
      publishRestoredState: publishRestoredClaudeProjectState,
      readState: () => {
        // `getState()` binds the runtime session to its cwd. Never call it with the transaction's
        // old directory after the workspace has reused that session id for another project.
        assertTargetCurrent();
        return options.runtime.getState(options.sessionId, options.cwd);
      },
      rollbackPrepared: (prepared) => options.runtime.rollbackPreparedConfig(prepared),
      restoreSnapshot: (snapshot) => options.runtime.restoreConfigSnapshot(configScope, snapshot),
      sessionId: options.sessionId,
      validatePrepared: options.validatePrepared,
    });
  };
  return runClaudeProjectConfigTransaction;
};
