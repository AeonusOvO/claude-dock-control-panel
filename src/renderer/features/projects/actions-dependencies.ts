import type { WorkspaceState } from '../../../shared/contracts';

export interface RenameDialogCopy {
  description: string;
  fieldLabel: string;
  title: string;
}

export interface ProjectsActionsDependencies {
  getWorkspaceState: () => WorkspaceState;
  hideTerminalContextMenu: () => void;
  projectNameFromPath: (directoryPath: string) => string;
  requestComposerFocus: (sessionId?: string) => void;
  requestConfirmation: (request: {
    confirmLabel?: string;
    message: string;
    title: string;
    tone?: 'default' | 'danger';
  }) => Promise<boolean>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  retryTerminalFitUntilMeasured: () => void;
  setNativePanelVisible: (visible: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface ProjectsRowsApi {
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
}
