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
});
