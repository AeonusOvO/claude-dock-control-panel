import type {
  ClaudeLaunchMode,
  CodexProjectState,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';
import type { ConfirmationRequest } from '../../shell/dialogs';
import { SessionGenerationRegistry } from '../../platform/session-generation';
import type { TerminalProjectState } from './project-state';

export interface CodexLaunchDeps {
  getWorkspaceState: () => WorkspaceState;
  activeStatus: () => TerminalStatus | undefined;
  activeDevelopmentRuntime: () => DevelopmentRuntime;
  codexStates: Map<string, CodexProjectState>;
  developmentRuntimeStates: Map<string, DevelopmentRuntimeState>;
  runtimeStateLoadGenerations: SessionGenerationRegistry;
  codexLaunchAttempts: SessionGenerationRegistry;
  terminalState: TerminalProjectState;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  setWorkbenchOpen: (open: boolean) => void;
  terminalFeature: {
    getTerminalView: (
      sessionId: string,
    ) => { terminal: { clear(): void; focus(): void } } | undefined;
    requestComposerFocus: (sessionId: string) => void;
    launchClaudeTerminal: (mode: ClaudeLaunchMode) => Promise<unknown>;
  };
  preflightFeature: {
    invalidateAndRun: (reason: string) => Promise<unknown>;
  };
}

export interface CodexLaunchMutableState {
  codexOperationInProgress: boolean;
  codexAutoLaunchSessionId: string;
}

export const createCodexLaunchMutableState = (): CodexLaunchMutableState => ({
  codexOperationInProgress: false,
  codexAutoLaunchSessionId: '',
});
