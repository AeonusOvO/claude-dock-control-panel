import type {
  ClaudeLaunchAttemptRegistry,
  ClaudeLaunchAttemptToken,
  ClaudeLaunchPresentationPhase,
  ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';
import type {
  ClaudeLaunchOutcome,
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeProjectState,
  OperationResult,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';

export interface TerminalActionsDependencies {
  activeStatus: () => TerminalStatus | undefined;
  getClaudeState?: (sessionId: string) => ClaudeProjectState | undefined;
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
  setClaudeLaunchPaused: (token: ClaudeLaunchAttemptToken) => boolean;
  setClaudeLaunchPresentationPhase: (
    token: ClaudeLaunchAttemptToken,
    phase: ClaudeLaunchPresentationPhase,
  ) => boolean;
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
  setNativePanelVisible: (visible: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
