import type { PtyGeneration } from '../../shared/contracts';
import type { PermissionModeProbes } from '../claude/permission-mode-probe';
import { effectiveClaudeNetworkAccess } from '../claude/runtime-types';
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
import { SessionOperationCoordinator, type SessionOperationStamp } from './session-operation';

export interface DevelopmentSessionCoordinationDependencies {
  agentRuntimeStore: AgentRuntimeStore;
  guards: Pick<
    MainGuards,
    'requireClaudeRuntime' | 'requireCodexRuntime' | 'withOfficialProviderAccess'
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
  invalidateAndWaitForMatchingDevelopmentSessionOperation: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  invalidateDevelopmentSessionOperation: (sessionId: string) => void;
  managedConfigTransactions: SessionConfigTransactionCoordinator;
  projectRuntimeSwitchOperations: ProjectRuntimeSwitchCoordinator;
  withDevelopmentSessionOperation: <T>(
    sessionId: string,
    operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  withDevelopmentSessionOperationIfStampCurrent: <T>(
    stamp: SessionOperationStamp,
    operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  withoutTerminalOperationInvalidation: <T>(sessionId: string, operation: () => T) => T;
}

export const createDevelopmentSessionCoordination = ({
  agentRuntimeStore,
  guards: { requireClaudeRuntime, requireCodexRuntime, withOfficialProviderAccess },
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
  // These reciprocal checks and reservations must stay synchronous. Together they prevent a runtime
  // switch from resolving provider access while a config transaction exposes tentative persisted config.
  const managedConfigTransactions = new SessionConfigTransactionCoordinator((cwd) =>
    projectRuntimeSwitchOperations.assertDevelopmentOperationAllowed(cwd),
  );
  const projectRuntimeSwitchOperations = new ProjectRuntimeSwitchCoordinator({
    assertSwitchAllowed: (cwd) => managedConfigTransactions.assertDevelopmentOperationAllowed(cwd),
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
    sessionsForDirectory: (cwd) =>
      workspace.sessionIdsForDirectory(cwd).map((sessionId) => workspace.getStatus(sessionId)),
    withProviderAccess: (cwd, selected, operation) => {
      const runtime = selected === 'claude' ? requireClaudeRuntime() : undefined;
      const networkAccess =
        selected === 'codex'
          ? ({ provider: 'openai-codex' } as const)
          : typeof runtime?.networkAccess === 'function'
            ? runtime.networkAccess(cwd)
            : effectiveClaudeNetworkAccess(undefined, runtime?.officialNetworkProvider(cwd));
      return networkAccess
        ? withOfficialProviderAccess(
            { action: 'provider-switch', cwd, ...networkAccess },
            operation,
          )
        : operation();
    },
  });

  const invalidateDevelopmentSessionOperation = (sessionId: string): void => {
    developmentSessionOperations.invalidate(sessionId);
  };

  const invalidateAndWaitForDevelopmentSessionOperation = (sessionId: string): Promise<void> =>
    developmentSessionOperations.invalidateAndWait(sessionId);

  const invalidateAndWaitForMatchingDevelopmentSessionOperation = (
    sessionId: string,
    signal: AbortSignal,
  ): Promise<boolean> => developmentSessionOperations.invalidateAndWaitIfSignal(sessionId, signal);

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

  const withDevelopmentSessionOperationIfStampCurrent = <T>(
    stamp: SessionOperationStamp,
    operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const initialStatus = workspace.getStatus(stamp.sessionId);
    projectRuntimeSwitchOperations.assertDevelopmentOperationAllowed(initialStatus.cwd);
    managedConfigTransactions.assertDevelopmentOperationAllowed(initialStatus.cwd, stamp.sessionId);
    return developmentSessionOperations.runIfStampCurrent(stamp, (assertSessionCurrent, signal) =>
      operation(() => {
        assertSessionCurrent();
        const currentStatus = workspace.getStatus(stamp.sessionId);
        if (!sameDirectory(currentStatus.cwd, initialStatus.cwd)) {
          throw new Error('开发会话已不再属于发起操作时的项目。');
        }
        projectRuntimeSwitchOperations.assertDevelopmentOperationAllowed(currentStatus.cwd);
        managedConfigTransactions.assertDevelopmentOperationAllowed(
          currentStatus.cwd,
          stamp.sessionId,
        );
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
    invalidateAndWaitForMatchingDevelopmentSessionOperation,
    invalidateDevelopmentSessionOperation,
    managedConfigTransactions,
    projectRuntimeSwitchOperations,
    withDevelopmentSessionOperation,
    withDevelopmentSessionOperationIfStampCurrent,
    withoutTerminalOperationInvalidation,
  };
};
