import type { ClaudeSessionMetadata, TerminalStatus } from '../../../shared/contracts';
import { ConversationTransitionQueue } from './conversation-transition-queue';
import { FolderHistoryLoadCoordinator } from './folder-history-load';

export interface TitleAnimationState {
  chars: string[];
  keep: number;
  phase: 'erasing' | 'typing';
  target: string[];
  timer: number;
}

export interface PendingConversation {
  cancel?: () => boolean;
  id: string;
  kind: 'creating' | 'restoring';
  phase: 'queued' | 'starting';
  projectPath: string;
  queuePosition?: number;
  queueTotal?: number;
  title: string;
}

export type ConversationTransitionKind = 'creating' | 'restoring';

export const storedConversationRestoreKey = (projectPath: string, conversationId: string): string =>
  `${projectPath.toLowerCase()}:${conversationId.toLowerCase()}`;

export type ConversationContextTarget =
  | { kind: 'history'; projectPath: string; session: ClaudeSessionMetadata }
  | { kind: 'running'; status: TerminalStatus }
  | undefined;

export interface ProjectsState {
  conversationContextTarget: ConversationContextTarget;
  conversationTransitionQueue: ConversationTransitionQueue;
  expandedFolders: Set<string>;
  failedConversationTransitions: Map<string, ConversationTransitionKind>;
  folderHistoryLoads: FolderHistoryLoadCoordinator;
  historyScrollPositions: Map<string, number>;
  pendingConversationSequence: number;
  pendingConversations: Map<string, PendingConversation>;
  transitioningConversations: Map<string, ConversationTransitionKind>;
  renderedConversationTitles: Map<string, string>;
  storedConversationRestores: Set<string>;
  restoredConversationSessions: Map<string, string>;
  storedConversations: Map<string, ClaudeSessionMetadata[]>;
  suppressedTitleAnimations: Set<string>;
  titleAnimations: Map<string, TitleAnimationState>;
  workspaceActivationSyncInProgress: boolean;
  /** Highest authoritative main-process workspace revision rendered so far. */
  workspaceRevision: number;
  workspaceTransitionDepth: number;
  /**
   * Workspace mutations currently in flight, keyed by what they act on.
   *
   * These rows are rebuilt by every workspace re-render, so disabling the button that started the
   * request is not enough — the replacement arrives enabled while the first call is still awaiting
   * the main process. Keying on the target instead of the element survives the re-render. New
   * conversations deliberately do not use this set because every plus click owns a distinct PTY.
   */
  workspaceMutations: Set<string>;
}

export const createProjectsState = (): ProjectsState => ({
  conversationContextTarget: undefined,
  conversationTransitionQueue: new ConversationTransitionQueue(),
  expandedFolders: new Set<string>(),
  failedConversationTransitions: new Map<string, ConversationTransitionKind>(),
  folderHistoryLoads: new FolderHistoryLoadCoordinator(),
  historyScrollPositions: new Map<string, number>(),
  pendingConversationSequence: 0,
  pendingConversations: new Map<string, PendingConversation>(),
  transitioningConversations: new Map<string, ConversationTransitionKind>(),
  renderedConversationTitles: new Map<string, string>(),
  storedConversationRestores: new Set<string>(),
  restoredConversationSessions: new Map<string, string>(),
  storedConversations: new Map<string, ClaudeSessionMetadata[]>(),
  suppressedTitleAnimations: new Set<string>(),
  titleAnimations: new Map<string, TitleAnimationState>(),
  workspaceActivationSyncInProgress: false,
  workspaceRevision: -1,
  workspaceTransitionDepth: 0,
  workspaceMutations: new Set<string>(),
});
