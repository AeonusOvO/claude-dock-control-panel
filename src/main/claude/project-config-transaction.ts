import type { ClaudeProjectState } from '../../shared/contracts';
import {
  OwnedConfigTransactionError,
  runOwnedConfigTransaction,
  type SessionConfigTransactionCoordinator,
} from '../coordination/main-process-operation';
import type { MainGuards } from '../ipc/guards';
import { sameDirectory, type TerminalWorkspace } from '../terminal/workspace';
import type {
  ClaudeProjectConfigTransactionOptions,
  RunClaudeProjectConfigTransaction,
} from './config-transaction';

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
  const runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction = <TPrepared>(
    options: ClaudeProjectConfigTransactionOptions<TPrepared>,
  ): Promise<ClaudeProjectState> => {
    assertExternalRoutingWritesAllowed();
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
      acquireIsolation: () => acquireConfigTransactionIsolation(options.sessionId, options.cwd),
      assertOperationOwnership: assertTransactionCurrent,
      assertRollbackOwnership: assertTargetCurrent,
      commit: options.commit,
      complete: options.complete,
      coordinator: managedConfigTransactions,
      createSnapshot: () => options.runtime.createConfigSnapshot(options.cwd),
      cwd: options.cwd,
      prepare: options.prepare,
      publishRestoredState: publishRestoredClaudeProjectState,
      readState: () => options.runtime.getState(options.sessionId, options.cwd),
      restoreSnapshot: (snapshot) => options.runtime.restoreConfigSnapshot(options.cwd, snapshot),
      sessionId: options.sessionId,
    });
  };
  return runClaudeProjectConfigTransaction;
};
