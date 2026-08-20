import type {
  ClaudeConnectionTestResult,
  ClaudeProjectState,
  TerminalStatus,
} from '../../../shared/contracts';
import type { ClaudeCurlAnalysis } from '../../../shared/claude/curl';

export interface RouterConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface RouterActionsDependencies {
  activeStatus: () => TerminalStatus | undefined;
  applyRouterRelevance: () => void;
  getCurlAnalysis: () => ClaudeCurlAnalysis | undefined;
  getActiveProjectState: () => ClaudeProjectState | undefined;
  importCurlRouterButton: HTMLButtonElement;
  installRouterButton: HTMLButtonElement;
  loadConnectionHistory: () => Promise<void>;
  loadGatewayDiagnostics: () => Promise<void>;
  loadSoftwareUpdates: (refresh?: boolean) => Promise<void>;
  populateClaudeConfigForm: (state: ClaudeProjectState) => void;
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void;
  renderConnectionTest: (result: ClaudeConnectionTestResult) => void;
  requestConfirmation: (request: RouterConfirmationRequest) => Promise<boolean>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  runGuarded: <T>(
    button: HTMLButtonElement,
    busyLabel: string,
    operation: () => Promise<T>,
  ) => Promise<T | undefined>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  startRouterButton: HTMLButtonElement;
  syncUpdateActionVisibility: () => void;
  updateSmartGuidance: () => void;
}
