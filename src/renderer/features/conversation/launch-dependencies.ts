import type {
  ClaudeProjectState,
  ClaudeSessionMetadata,
  RuntimeActivitySnapshot,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';

export interface ConversationLaunchActionsDependencies {
  activeStatus: () => TerminalStatus | undefined;
  expandFolder: (folder: string) => void;
  focusActiveTerminal: () => void;
  getActiveSessionId: () => string;
  getClaudeState: (sessionId: string) => ClaudeProjectState | undefined;
  getRuntimeActivity: (sessionId: string) => RuntimeActivitySnapshot | undefined;
  getStoredConversations: (folder: string) => ClaudeSessionMetadata[] | undefined;
  getWorkspaceState: () => WorkspaceState;
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  renderRuntimeActivity: (snapshot?: RuntimeActivitySnapshot) => void;
  renderWorkspace: (state: WorkspaceState) => void;
  requestConfirmation: (request: {
    confirmLabel?: string;
    message: string;
    title: string;
    tone?: 'danger' | 'default';
  }) => Promise<boolean>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  selectRailTab: (tab: string) => void;
  setRuntimeSummaryOpen: (open: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  terminalThemeSelect: HTMLSelectElement;
}
