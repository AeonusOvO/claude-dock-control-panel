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
  ClaudeLaunchPresentationPhase,
  ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';
import type { TerminalProgressHandle } from '../../platform/terminal-progress';

export interface RenameDialogCopy {
  description: string;
  fieldLabel: string;
  title: string;
}

export interface ProjectsActionsDependencies {
  beginTerminalMask: (sessionId: string, label: string) => TerminalProgressHandle;
  beginWorkspaceTerminalPreview: (label: string) => TerminalProgressHandle;
  beginClaudeLaunchAttempt: (
    status: TerminalStatus,
    state?: ClaudeProjectState,
  ) => ClaudeLaunchAttemptToken;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  failClaudeLaunchAttempt: (token: ClaudeLaunchAttemptToken) => boolean;
  getClaudeState?: (sessionId: string) => ClaudeProjectState | undefined;
  getWorkspaceState: () => WorkspaceState;
  hideTerminalContextMenu: () => void;
  launchCreatedConversation: (
    sessionId: string,
    runtime: 'claude' | 'codex',
    onProgress?: (label: string) => void,
  ) => Promise<boolean>;
  projectNameFromPath: (directoryPath: string) => string;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  setClaudeLaunchPaused: (token: ClaudeLaunchAttemptToken) => boolean;
  setClaudeLaunchPresentationPhase: (
    token: ClaudeLaunchAttemptToken,
    phase: ClaudeLaunchPresentationPhase,
  ) => boolean;
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
  renderProjectList: () => void;
}
