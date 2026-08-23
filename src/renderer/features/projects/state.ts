import type { ClaudeSessionMetadata, TerminalStatus } from '../../../shared/contracts';
import { FolderHistoryLoadCoordinator } from './folder-history-load';

export interface TitleAnimationState {
  chars: string[];
  keep: number;
  phase: 'erasing' | 'typing';
  target: string[];
  timer: number;
}

export type ConversationContextTarget =
  | { kind: 'history'; projectPath: string; session: ClaudeSessionMetadata }
  | { kind: 'running'; status: TerminalStatus }
  | undefined;

export interface ProjectsState {
  conversationContextTarget: ConversationContextTarget;
  expandedFolders: Set<string>;
  folderHistoryLoads: FolderHistoryLoadCoordinator;
  historyScrollPositions: Map<string, number>;
  renderedConversationTitles: Map<string, string>;
  storedConversationRestores: Set<string>;
  storedConversations: Map<string, ClaudeSessionMetadata[]>;
  suppressedTitleAnimations: Set<string>;
  titleAnimations: Map<string, TitleAnimationState>;
  workspaceActivationSyncInProgress: boolean;
  /**
   * Workspace mutations currently in flight, keyed by what they act on.
   *
   * These rows are rebuilt by every workspace re-render, so disabling the button that started the
   * request is not enough — the replacement arrives enabled while the first call is still awaiting
   * the main process. Keying on the target instead of the element survives the re-render, which
   * matters most for opening a conversation: each accepted call spawns a real PTY, so a double click
   * costs a stray terminal process rather than a duplicated bit of UI state.
   */
  workspaceMutations: Set<string>;
}

export const createProjectsState = (): ProjectsState => ({
  conversationContextTarget: undefined,
  expandedFolders: new Set<string>(),
  folderHistoryLoads: new FolderHistoryLoadCoordinator(),
  historyScrollPositions: new Map<string, number>(),
  renderedConversationTitles: new Map<string, string>(),
  storedConversationRestores: new Set<string>(),
  storedConversations: new Map<string, ClaudeSessionMetadata[]>(),
  suppressedTitleAnimations: new Set<string>(),
  titleAnimations: new Map<string, TitleAnimationState>(),
  workspaceActivationSyncInProgress: false,
  workspaceMutations: new Set<string>(),
});
