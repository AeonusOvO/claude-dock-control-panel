import type {
  ClaudePermissionMode,
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntime,
  TerminalStatus,
} from '../../../shared/contracts';
import type {
  ClaudeLaunchAttemptRegistry,
  ClaudeLaunchAttemptToken,
} from '../../platform/claude-launch-attempt';
import type { SessionGenerationRegistry } from '../../platform/session-generation';
import type { ConfirmationRequest } from '../dialogs';
import type { ToastShell } from '../toast';

export interface FooterSwitchesDeps {
  activeDevelopmentRuntime: () => DevelopmentRuntime;
  activeStatus: () => TerminalStatus | undefined;
  beginClaudeLaunchAttempt: (
    status: TerminalStatus,
    state: ClaudeProjectState,
  ) => ClaudeLaunchAttemptToken;
  beginTerminalMask: (sessionId: string, label: string) => () => void;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  claudeSpeedOperations: SessionGenerationRegistry;
  claudeStates: Map<string, ClaudeProjectState>;
  codexStates: Map<string, CodexProjectState>;
  effortRecoveryNotifications: Map<string, number>;
  failClaudeLaunchAttempt: (token: ClaudeLaunchAttemptToken) => boolean;
  hasActiveConversation: () => boolean;
  loadClaudeState: (sessionId: string) => Promise<void>;
  openNativeEffortMenu: () => void;
  openNativeModeMenu: () => void;
  openNativeModelMenu: () => void;
  openNativeSpeedMenu: () => void;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  relaunchClaudeSession: (
    summary: string,
    input: { entryId?: string; permissionMode?: ClaudePermissionMode },
  ) => Promise<void>;
  renderActiveConversation: () => void;
  renderClaudeState: (
    state: ClaudeProjectState,
    invalidatePendingLoad?: boolean,
    renderFooter?: boolean,
  ) => void;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  showToast: ToastShell['showToast'];
}
