import type { RunClaudeProjectConfigTransaction } from './config-transaction';
import type { ClaudeConversationLifecycleCoordinator } from './conversation-lifecycle';
import type { ReportClaudeOperationFailure } from './operation-failure';
import type { ConversationOwner, ConversationOwnerRegistry } from '../conversation/owner-registry';
import type { LaunchPreflightDecisionCoordinator } from '../coordination/launch-preflight-decision';
import type {
  SessionOperationCoordinator,
  SessionOperationStamp,
  WithSessionOperation,
} from '../coordination/session-operation';
import type { MainGuards } from '../ipc/guards';
import type { AgentRuntimeStore } from '../runtime/store';
import type {
  FailedRuntimeLaunchCleanupDependencies,
  RestartRuntimeTerminal,
  ResumeConversationInTerminal,
} from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';

/** Dependencies shared by the isolated Claude launch IPC registrations. */
export interface ClaudeLaunchIpcDependencies {
  agentRuntimeStore: AgentRuntimeStore;
  claudeConversationLifecycle: ClaudeConversationLifecycleCoordinator;
  claudeFailure: ReportClaudeOperationFailure;
  conversationOwnerRegistry: ConversationOwnerRegistry;
  developmentSessionOperations: SessionOperationCoordinator;
  launchPreflightDecisions: LaunchPreflightDecisionCoordinator;
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  guards: Pick<
    MainGuards,
    | 'assertLaunchAdmissionAllowed'
    | 'withOfficialProviderAccess'
    | 'requireClaudeRuntime'
    | 'requireProviderAccessGuard'
    | 'validateSender'
  >;
  releaseTerminalConversationOwner: (sessionId: string) => void;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  runClaudeResumeLaunch: ResumeConversationInTerminal;
  terminalConversationOwners: Map<string, ConversationOwner>;
  withDevelopmentSessionOperation: WithSessionOperation;
  withLaunchDecisionSessionOperation: WithSessionOperation;
  withDevelopmentSessionOperationIfStampCurrent: <T>(
    stamp: SessionOperationStamp,
    operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  workspace: TerminalWorkspace;
}
