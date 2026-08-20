import type {
  ClaudeLaunchAttemptRegistry,
  ClaudeLaunchAttemptToken,
  ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';
import type { ClaudeProjectState, TerminalStatus, WorkspaceState } from '../../../shared/contracts';

export interface TerminalIoDependencies {
  activeStatus: () => TerminalStatus | undefined;
  beginClaudeLaunchAttempt: (
    status: TerminalStatus,
    state?: ClaudeProjectState,
  ) => ClaudeLaunchAttemptToken;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  failClaudeLaunchAttempt: (token: ClaudeLaunchAttemptToken) => boolean;
  focusComposer: () => boolean;
  getWorkspaceState: () => WorkspaceState;
  hideConversationContextMenu: () => void;
  loadClaudeState: (sessionId: string) => Promise<void>;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  renderClaudeLaunchResult: (
    token: ClaudeLaunchAttemptToken,
    state: ClaudeProjectState,
    disposition: ClaudeLaunchResultDisposition,
  ) => boolean;
  requestConfirmation: (request: {
    confirmLabel?: string;
    message: string;
    title: string;
    tone?: 'default' | 'danger';
  }) => Promise<boolean>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
