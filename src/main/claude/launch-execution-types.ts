import type {
  ClaudeLaunchMode,
  ClaudeRelaunchInput,
  NetworkPreflightResult,
  NetworkProviderId,
  PtyGeneration,
} from '../../shared/contracts';
import type { ConversationOwner, ConversationOwnerRegistry } from '../conversation/owner-registry';
import type { MainGuards } from '../ipc/guards';
import type {
  FailedRuntimeLaunchCleanupDependencies,
  RestartRuntimeTerminal,
  ResumeConversationInTerminal,
  WithExpectedPtyReplacement,
} from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';
import type { RunClaudeProjectConfigTransaction } from './config-transaction';
import type { ClaudeConversationLifecycleCoordinator } from './conversation-lifecycle';
import type { ClaudeLaunchAuthorization } from './runtime-types';

export type ClaudeRuntime = ReturnType<MainGuards['requireClaudeRuntime']>;

export type ProviderAuthorizedOperation = <T>(
  provider: NetworkProviderId | undefined,
  operation: (result?: NetworkPreflightResult) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export interface PreparedLaunchExecution {
  readonly assertCurrent: () => void;
  readonly assertPreparationCurrent: () => void;
  readonly authorization: ClaudeLaunchAuthorization;
  readonly cleanup: FailedRuntimeLaunchCleanupDependencies;
  readonly cwd: string;
  readonly mode: ClaudeLaunchMode;
  readonly preflightResult?: NetworkPreflightResult;
  readonly restartRuntimeTerminal: RestartRuntimeTerminal;
  readonly runtime: ClaudeRuntime;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly withExpectedPtyReplacement: WithExpectedPtyReplacement;
}

export interface RelaunchExecution {
  readonly assertCurrent: () => void;
  readonly assertOriginalConfigurationCurrent: () => void;
  readonly authorizeLaunchProvider: ProviderAuthorizedOperation;
  readonly authorizeNestedProvider: ProviderAuthorizedOperation;
  readonly cleanup: FailedRuntimeLaunchCleanupDependencies;
  readonly cwd: string;
  readonly input: Readonly<ClaudeRelaunchInput>;
  readonly restartRuntimeTerminal: RestartRuntimeTerminal;
  readonly runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  readonly runtime: ClaudeRuntime;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly withExpectedPtyReplacement: WithExpectedPtyReplacement;
  readonly workspacePtyGeneration: PtyGeneration;
}

export interface ResumeSessionExecution {
  readonly assertCurrent: () => void;
  readonly assertPreparationCurrent: () => void;
  readonly authorizeLaunchProvider: ProviderAuthorizedOperation;
  readonly claudeConversationLifecycle: ClaudeConversationLifecycleCoordinator;
  readonly cleanup: FailedRuntimeLaunchCleanupDependencies;
  readonly conversationId: string;
  readonly conversationOwnerRegistry: ConversationOwnerRegistry;
  readonly cwd: string;
  readonly expectedOfficialNetworkProvider: NetworkProviderId | undefined;
  readonly runClaudeResumeLaunch: ResumeConversationInTerminal;
  readonly runtime: ClaudeRuntime;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly terminalConversationOwners: Map<string, ConversationOwner>;
  readonly withExpectedPtyReplacement: WithExpectedPtyReplacement;
  readonly workspace: TerminalWorkspace;
}
