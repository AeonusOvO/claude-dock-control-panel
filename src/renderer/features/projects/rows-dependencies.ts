import type {
  ClaudeSessionMetadata,
  TerminalPhase,
  TerminalStatus,
  WorkspaceProjectView,
  WorkspaceState,
} from '../../../shared/contracts';
import type { ConversationContextTarget } from './state';

export interface ProjectsRowsDependencies {
  formatRelativeTime: (timestamp: number) => string;
  getWorkspaceState: () => WorkspaceState;
  phaseCopy: Record<TerminalPhase, { detail: string; footer: string; pill: string }>;
}

export interface ProjectsRowHandlers {
  activateProject: (sessionId: string) => Promise<void>;
  closeProject: (status: TerminalStatus) => Promise<void>;
  closeProjectFolder: (project: WorkspaceProjectView) => Promise<void>;
  deleteStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
  forgetProject: (project: WorkspaceProjectView) => Promise<void>;
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
  openConversation: (projectPath: string) => Promise<void>;
  renameConversation: (status: TerminalStatus) => Promise<void>;
  resumeStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
  showConversationContextMenu: (
    event: MouseEvent,
    target: Exclude<ConversationContextTarget, undefined>,
  ) => void;
}
