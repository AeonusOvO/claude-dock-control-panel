import type { PtyGeneration } from '../../shared/contracts';
import type { PermissionModeProbes } from '../claude/permission-mode-probe';
import type { Registry } from '../infra/registry';
import { CLAUDE_RUNTIME, CODEX_RUNTIME } from '../infra/service-tokens';
import type { MainGuards } from '../ipc/guards';
import type { AgentRuntimeStore } from '../runtime/store';
import type { TerminalOutputBatcher } from '../terminal/output-batcher';
import { TerminalTransitionCoordinator } from '../terminal/lifecycle';
import { sameDirectory, type TerminalWorkspace } from '../terminal/workspace';
import {
  ProjectRuntimeSwitchCoordinator,
  SessionConfigTransactionCoordinator,
} from './main-process-operation';
import { SessionOperationCoordinator } from './session-operation';

export interface DevelopmentSessionCoordinationDependencies {
  agentRuntimeStore: AgentRuntimeStore;
  guards: Pick<
    MainGuards,
    'assertOfficialProviderAllowed' | 'requireClaudeRuntime' | 'requireCodexRuntime'
  >;
  resolvePendingPermissionModeProbes: PermissionModeProbes['resolvePendingPermissionModeProbes'];
  services: Registry;
  /*
   * Shared with the workspace reconciler in the assembly: a transition that deliberately restarts a
   * PTY must not have its own lease invalidated by the failure it just caused.
   */
  terminalOperationInvalidationSuppressions: Set<string>;
  terminalOutputBatcher: TerminalOutputBatcher;
  workspace: TerminalWorkspace;
}

/** Every lease, isolation barrier, and transition guard that launch-time PTY mutation runs under. */
export interface DevelopmentSessionCoordination {
  acquireConfigTransactionIsolation: (sessionId: string, cwd: string) => Promise<void>;
  developmentSessionOperations: SessionOperationCoordinator;
  directTerminalTransitions: TerminalTransitionCoordinator;
  invalidateAndWaitForDevelopmentSessionOperation: (sessionId: string) => Promise<void>;
  invalidateDevelopmentSessionOperation: (sessionId: string) => void;
  managedConfigTransactions: SessionConfigTransactionCoordinator;
  projectRuntimeSwitchOperations: ProjectRuntimeSwitchCoordinator;
  withDevelopmentSessionOperation: <T>(
    sessionId: string,
    operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  withoutTerminalOperationInvalidation: <T>(sessionId: string, operation: () => T) => T;
}

export const createDevelopmentSessionCoordination = ({
  agentRuntimeStore,
  guards: { assertOfficialProviderAllowed, requireClaudeRuntime, requireCodexRuntime },
  resolvePendingPermissionModeProbes,
  services,
  terminalOperationInvalidationSuppressions,
  terminalOutputBatcher,
  workspace,
}: DevelopmentSessionCoordinationDependencies): DevelopmentSessionCoordination => {
  /** Serializes launch-time PTY mutation across Claude and Codex for each workspace session. */
  const developmentSessionOperations = new SessionOperationCoordinator((sessionId) =>
    workspace.hasSession(sessionId),
  );
  const projectRuntimeSwitchOperations = new ProjectRuntimeSwitchCoordinator({
    cleanupBeforeCommit: async (_cwd, selected) => {
      if (selected === 'codex') {
        await requireClaudeRuntime().stopUnusedRoutingServices();
      }
    },
    commitRuntime: (cwd, selected) => agentRuntimeStore.set(cwd, selected),
    getCurrentRuntime: (cwd) => agentRuntimeStore.get(cwd),
    getSession: (sessionId) =>
      workspace.hasSession(sessionId) ? workspace.getStatus(sessionId) : undefined,
    hasActiveRuntime: (sessionId) =>
      requireClaudeRuntime().isActive(sessionId) || requireCodexRuntime().isActive(sessionId),
    invalidateAndWait: (sessionId) => developmentSessionOperations.invalidateAndWait(sessionId),
    prepareProvider: async (cwd, selected) => {
      const officialProvider =
        selected === 'codex' ? 'openai-codex' : requireClaudeRuntime().officialNetworkProvider(cwd);
      if (officialProvider) {
        await assertOfficialProviderAllowed(officialProvider, 'provider-switch', cwd);
      }
    },
    sessionsForDirectory: (cwd) =>
      workspace.sessionIdsForDirectory(cwd).map((sessionId) => workspace.getStatus(sessionId)),
  });
  const managedConfigTransactions = new SessionConfigTransactionCoordinator();

  const invalidateDevelopmentSessionOperation = (sessionId: string): void => {
    developmentSessionOperations.invalidate(sessionId);
  };

  const invalidateAndWaitForDevelopmentSessionOperation = (sessionId: string): Promise<void> =>
    developmentSessionOperations.invalidateAndWait(sessionId);

  const acquireConfigTransactionIsolation = (sessionId: string, cwd: string): Promise<void> =>
    managedConfigTransactions.acquireDevelopmentIsolation(
      sessionId,
      cwd,
      workspace.sessionIdsForDirectory(cwd),
      invalidateAndWaitForDevelopmentSessionOperation,
    );

  const withDevelopmentSessionOperation = <T>(
    sessionId: string,
    operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const initialStatus = workspace.getStatus(sessionId);
    projectRuntimeSwitchOperations.assertDevelopmentOperationAllowed(initialStatus.cwd);
    managedConfigTransactions.assertDevelopmentOperationAllowed(initialStatus.cwd, sessionId);
    return developmentSessionOperations.run(sessionId, (assertSessionCurrent, signal) =>
      operation(() => {
        assertSessionCurrent();
        const currentStatus = workspace.getStatus(sessionId);
        if (!sameDirectory(currentStatus.cwd, initialStatus.cwd)) {
          throw new Error('开发会话已不再属于发起操作时的项目。');
        }
        projectRuntimeSwitchOperations.assertDevelopmentOperationAllowed(currentStatus.cwd);
        managedConfigTransactions.assertDevelopmentOperationAllowed(currentStatus.cwd, sessionId);
      }, signal),
    );
  };

  const withoutTerminalOperationInvalidation = <T>(sessionId: string, operation: () => T): T => {
    terminalOperationInvalidationSuppressions.add(sessionId);
    try {
      return operation();
    } finally {
      terminalOperationInvalidationSuppressions.delete(sessionId);
    }
  };

  const directTerminalTransitionDependencies = {
    deactivateRuntimes: (sessionId: string, expectedGeneration: PtyGeneration) => {
      services.resolve(CLAUDE_RUNTIME).setInactive(sessionId, expectedGeneration);
      services.resolve(CODEX_RUNTIME).setInactive(sessionId, expectedGeneration);
    },
    discardOutput: (sessionId: string, expectedGeneration: PtyGeneration) => {
      terminalOutputBatcher.discard(sessionId, expectedGeneration);
    },
    getPtyGeneration: (sessionId: string) => workspace.getStatus(sessionId).ptyGeneration,
    invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,
    resolveProbes: resolvePendingPermissionModeProbes,
    withInvalidationSuppressed: withoutTerminalOperationInvalidation,
  };
  const directTerminalTransitions = new TerminalTransitionCoordinator(
    directTerminalTransitionDependencies,
  );

  return {
    acquireConfigTransactionIsolation,
    developmentSessionOperations,
    directTerminalTransitions,
    invalidateAndWaitForDevelopmentSessionOperation,
    invalidateDevelopmentSessionOperation,
    managedConfigTransactions,
    projectRuntimeSwitchOperations,
    withDevelopmentSessionOperation,
    withoutTerminalOperationInvalidation,
  };
};
