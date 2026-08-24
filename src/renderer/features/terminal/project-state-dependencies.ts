import type { NetworkProviderId } from '../../../shared/contracts/network';
import type {
  ClaudeProjectState,
  ClaudeRelaunchInput,
  ClaudeRouterManagementState,
  CodexProjectState,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';
import { SessionGenerationRegistry } from '../../platform/session-generation';
import { ClaudeLaunchAttemptRegistry } from '../../platform/claude-launch-attempt';
import type {
  CodexOperationPresentation,
  RuntimeSwitchOperationToken,
} from './codex-operation-state';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import type { ConfirmationRequest } from '../../shell/dialogs';

interface TerminalViewLike {
  observedPermissionMode?: string | undefined;
  terminal: { clear(): void; focus(): void };
}

/** terminal 只依赖连接表单的这组门面成员；装配处直接传入完整 ConnectionForm 实例。 */
interface ConnectionFormLike {
  readonly environmentSetup: HTMLElement;
  applyDefaultProviderGroupExpansion: (providerId?: ClaudeProviderId) => void;
  getConfigFormSessionId: () => string;
  getProviderGroupExpansionPending: () => boolean;
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  populateClaudeConfigForm: (state: ClaudeProjectState) => void;
  renderProviderPicker: () => void;
  setConnectionEnvironmentReady: (ready: boolean) => void;
  setProviderGroupExpansionPending: (pending: boolean) => void;
  syncConnectionInteractivity: () => void;
}

export interface TerminalProjectStateDeps {
  getWorkspaceState: () => WorkspaceState;
  activeDevelopmentRuntime: () => DevelopmentRuntime;
  claudeStates: Map<string, ClaudeProjectState>;
  codexStates: Map<string, CodexProjectState>;
  developmentRuntimeStates: Map<string, DevelopmentRuntimeState>;
  claudeStateLoadGenerations: SessionGenerationRegistry;
  codexStateLoadGenerations: SessionGenerationRegistry;
  runtimeStateLoadGenerations: SessionGenerationRegistry;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  codexLaunchAttempts: SessionGenerationRegistry;
  getCodexOperation: (state?: CodexProjectState) => CodexOperationPresentation | undefined;
  getRuntimeSwitchOperation: (sessionId: string) => RuntimeSwitchOperationToken | undefined;
  connectionForm: ConnectionFormLike;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  setWorkbenchOpen: (open: boolean) => void;
  setRuntimeSummaryOpen: (open: boolean) => void;
  renderFooterResource: (
    usage: ClaudeProjectState['resourceUsage'],
    contextWindowSelectable?: boolean,
  ) => void;
  managedContextWindowSelectable: (state: ClaudeProjectState) => boolean;
  renderTerminalFooterChips: (state: ClaudeProjectState) => void;
  getClaudeContextWindowMode: () => string;
  getClaudeContextWindowCustomTokens: () => number | undefined;
  applyContextWindowSettings: (
    settings: Awaited<ReturnType<typeof window.controlPanel.setClaudeContextWindowMode>>,
  ) => void;
  conversationFeature: {
    startingSessionId: () => string | undefined;
    hasActiveConversation: () => boolean;
    renderActiveFooter: () => void;
  };
  terminalFeature: {
    getTerminalView: (sessionId: string) => TerminalViewLike | undefined;
    renderControlStatus: (status?: TerminalStatus) => void;
    setComposerEnabled: (enabled: boolean) => void;
    showTerminalDiagnostic: (status: TerminalStatus) => void;
    relaunchClaudeSession: (
      summary: string,
      input: Omit<ClaudeRelaunchInput, 'compactFirst'>,
    ) => Promise<unknown>;
  };
  projectsFeature: {
    displayedConversationTitle: (status: TerminalStatus) => string;
    isTitleAnimating: (sessionId: string) => boolean;
    renderWorkspace: (state: WorkspaceState) => void;
  };
  routerFeature: {
    getManagementState: () => ClaudeRouterManagementState | undefined;
    renderRemediation: (state: ClaudeRouterManagementState) => void;
  };
  connectionFeature: {
    isTestInProgress: () => boolean;
    updateSmartGuidance: () => void;
    scheduleAutomaticConnectionTest: (state: ClaudeProjectState) => void;
  };
  preflightFeature: {
    runActiveNetworkPreflight: (force: boolean) => Promise<unknown>;
    isBlocked: (key: NetworkProviderId) => boolean;
    renderActiveNetworkPreflight: () => void;
  };
}
