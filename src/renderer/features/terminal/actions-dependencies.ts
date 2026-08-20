import type {
  ClaudeLaunchAttemptRegistry,
  ClaudeLaunchAttemptToken,
  ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';
import type {
  ClaudeProjectState,
  OperationResult,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';

export interface TerminalActionsDependencies {
  activeStatus: () => TerminalStatus | undefined;
  beginClaudeLaunchAttempt: (
    status: TerminalStatus,
    state?: ClaudeProjectState,
  ) => ClaudeLaunchAttemptToken;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  failClaudeLaunchAttempt: (token: ClaudeLaunchAttemptToken) => boolean;
  getWindowsBuildNumber: () => number | undefined;
  getWorkspaceState: () => WorkspaceState;
  handleOperation: (result: OperationResult, successMessage?: string) => boolean;
  projectNameFromPath: (directoryPath: string) => string;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  renderClaudeLaunchResult: (
    token: ClaudeLaunchAttemptToken,
    state: ClaudeProjectState,
    disposition: ClaudeLaunchResultDisposition,
  ) => boolean;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  setNativePanelVisible: (visible: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
