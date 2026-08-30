import type {
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  RuntimeActivitySnapshot,
  TerminalStatus,
  WorkspaceState,
} from '../shared/contracts';
import type { Registry } from './platform/registry';
import type { SessionGenerationRegistry } from './platform/session-generation';
import type { ClaudeLaunchAttemptRegistry } from './platform/claude-launch-attempt';
import type { createConnectionForm } from './features/connection/form';
import type { createConnectionHistory } from './features/connection/history';
import type { createCodexLaunch } from './features/terminal/codex-launch';
import type { createTerminalProjectState } from './features/terminal/project-state';
import type { createDialogShell } from './shell/dialogs';
import type { createRailShell } from './shell/rail';
import type { createFooterShell } from './shell/footer';
import type { createThemeShell } from './shell/theme';
import type { createToastShell } from './shell/toast';
import type { createWorkbenchShell } from './shell/workbench';
import type { createRuntimeActivityShell } from './shell/runtime-activity';
import type { DownloadsFeature } from './features/downloads';
import type { McpFeature } from './features/mcp';
import type { PluginsFeature } from './features/plugins';
import type { UpdatesFeature } from './features/updates';
import type { PreflightFeature } from './features/preflight';
import type { SettingsFeature } from './features/settings';
import type { ProxyFeature } from './features/proxy';
import type { ArtifactFeature } from './features/artifact';
import type { ChatFeature } from './features/chat';
import type { ConversationFeature } from './features/conversation';
import type { TerminalFeature } from './features/terminal';
import type { RouterFeature } from './features/router';
import type { ConnectionFeature } from './features/connection';
import type { ProjectsFeature } from './features/projects';
import type { OnboardingFeature } from './features/onboarding';

/**
 * Shared mutable renderer state owned by the bootstrap layer: top-level DOM hooks, session/state
 * registries, the guarded button helper, and getter/setter pairs for values that outlive a single
 * function scope.
 */
export interface RuntimeState {
  rendererRegistry: Registry;
  importCurlRouterButton: HTMLButtonElement;
  brandLogo: HTMLImageElement;
  dropOverlay: HTMLElement;
  routerSettingsContent: HTMLElement;
  connectionAdvancedDialog: HTMLDialogElement;
  openConnectionAdvancedButton: HTMLButtonElement;
  closeConnectionAdvancedButton: HTMLButtonElement;
  cancelConnectionAdvancedButton: HTMLButtonElement;
  completeConnectionAdvancedButton: HTMLButtonElement;
  installRouterButton: HTMLButtonElement;
  routeHealthAction: HTMLButtonElement;
  startRouterButton: HTMLButtonElement;
  titleStatus: HTMLElement;
  routerManager: HTMLElement;
  routerActions: HTMLElement;
  chatMessagesElement: HTMLElement;
  chatComposer: HTMLFormElement;
  claudeStates: Map<string, ClaudeProjectState>;
  codexStates: Map<string, CodexProjectState>;
  developmentRuntimeStates: Map<string, DevelopmentRuntimeState>;
  runtimeActivityStates: Map<string, RuntimeActivitySnapshot>;
  claudeStateLoadGenerations: SessionGenerationRegistry;
  codexStateLoadGenerations: SessionGenerationRegistry;
  runtimeStateLoadGenerations: SessionGenerationRegistry;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  claudeSpeedOperations: SessionGenerationRegistry;
  codexLaunchAttempts: SessionGenerationRegistry;
  effortRecoveryNotifications: Map<string, number>;
  runGuarded: <T>(
    button: HTMLButtonElement,
    busyLabel: string,
    operation: () => Promise<T>,
  ) => Promise<T | undefined>;
  getWorkspaceState: () => WorkspaceState;
  setWorkspaceState: (state: WorkspaceState) => void;
  getWindowsBuildNumber: () => number | undefined;
  setWindowsBuildNumber: (value: number | undefined) => void;
  getDragDepth: () => number;
  setDragDepth: (value: number) => void;
  getFileDropConfirmationEnabled: () => boolean;
  setFileDropConfirmationEnabled: (value: boolean) => void;
  getLastClaudeSessionId: () => string;
  setLastClaudeSessionId: (value: string) => void;
}

/**
 * Cross-feature shell instances wired during bootstrap. The stack starts empty and is mounted
 * stage by stage so a later stage can be referenced lazily via `shells.xxx` inside callbacks.
 */
export interface ShellStack {
  toastShell: ReturnType<typeof createToastShell>;
  themeShell: ReturnType<typeof createThemeShell>;
  dialogShell: ReturnType<typeof createDialogShell>;
  railShell: ReturnType<typeof createRailShell>;
  connectionForm: ReturnType<typeof createConnectionForm>;
  terminalProjectState: ReturnType<typeof createTerminalProjectState>;
  codexLaunchShell: ReturnType<typeof createCodexLaunch>;
  footerShell: ReturnType<typeof createFooterShell>;
  workbenchShell: ReturnType<typeof createWorkbenchShell>;
  runtimeActivityShell: ReturnType<typeof createRuntimeActivityShell>;
  connectionHistory: ReturnType<typeof createConnectionHistory>;
  openExternal: (url: string) => Promise<void>;
  activeStatus: () => TerminalStatus | undefined;
  activeDevelopmentRuntime: () => DevelopmentRuntime;
}

/**
 * Resolved feature instances, mounted progressively by the registration functions. The bundle is
 * created empty before the shell stack is wired so late-binding deps can reference
 * `features.xxxFeature` inside callbacks that only run after registration completes.
 */
export interface FeatureBundle {
  downloadsFeature: DownloadsFeature;
  mcpFeature: McpFeature;
  pluginsFeature: PluginsFeature;
  updatesFeature: UpdatesFeature;
  preflightFeature: PreflightFeature;
  settingsFeature: SettingsFeature;
  proxyFeature: ProxyFeature;
  artifactFeature: ArtifactFeature;
  chatFeature: ChatFeature;
  conversationFeature: ConversationFeature;
  terminalFeature: TerminalFeature;
  routerFeature: RouterFeature;
  connectionFeature: ConnectionFeature;
  projectsFeature: ProjectsFeature;
  onboardingFeature: OnboardingFeature;
}

/** Everything `bootstrapApplication` wires: shared state, shells, and resolved features. */
export type ApplicationRuntime = RuntimeState & ShellStack & FeatureBundle;
