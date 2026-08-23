import type {
  ClaudeLaunchOutcome,
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeProjectState,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';
import type {
  ClaudeLaunchAttemptRegistry,
  ClaudeLaunchAttemptToken,
  ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';

export interface RenameDialogCopy {
  description: string;
  fieldLabel: string;
  title: string;
}

export interface ProjectsActionsDependencies {
  beginClaudeLaunchAttempt: (
    status: TerminalStatus,
    state?: ClaudeProjectState,
  ) => ClaudeLaunchAttemptToken;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  failClaudeLaunchAttempt: (token: ClaudeLaunchAttemptToken) => boolean;
  getWorkspaceState: () => WorkspaceState;
  hideTerminalContextMenu: () => void;
  projectNameFromPath: (directoryPath: string) => string;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  requestComposerFocus: (sessionId?: string) => void;
  requestConfirmation: (request: {
    confirmLabel?: string;
    message: string;
    title: string;
    tone?: 'default' | 'danger';
  }) => Promise<boolean>;
  resolveClaudeLaunchDecision: (
    token: ClaudeLaunchAttemptToken,
    paused: Extract<ClaudeLaunchOutcome, { status: 'paused' }>,
  ) => Promise<Exclude<ClaudeLaunchPreflightDecisionOutcome, { status: 'paused' }>>;
  renderClaudeLaunchResult: (
    token: ClaudeLaunchAttemptToken,
    state: ClaudeProjectState,
    disposition: ClaudeLaunchResultDisposition,
  ) => boolean;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  retryTerminalFitUntilMeasured: () => void;
  setNativePanelVisible: (visible: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface ProjectsRowsApi {
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
}
