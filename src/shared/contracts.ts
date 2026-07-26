export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';
export type ClaudeAuthMode = 'apiKey' | 'authToken' | 'existing' | 'none';
export type ClaudeCredentialAction = 'clear' | 'keep' | 'replace';
export type ClaudeLaunchMode = 'continue' | 'new' | 'resume';
export type ClaudePreset = 'anthropic' | 'custom' | 'deepseek' | 'gateway';
export type ClaudeProvider = 'anthropic' | 'gateway';
export type ClaudeSecurityStatus =
  'blocked-version' | 'not-installed' | 'ready' | 'update-required' | 'unknown';
export type ClaudeConnectionTestTone = 'error' | 'success' | 'warning';
export type ClaudeRouteHealthSource = 'connection-test' | 'router' | 'runtime';
export type ClaudeRouteHealthTone = 'error' | 'success' | 'warning';
export type ClaudeEndpointProtocol = 'anthropic' | 'openai' | 'unknown';
export type GatewayCandidateKind = 'claude-code-router' | 'custom' | 'litellm';
export type GatewayCandidateStatus = 'offline' | 'partial' | 'ready';
export type ClaudeRouterGatewayState = 'error' | 'running' | 'starting' | 'stopped' | 'unknown';
export type ClaudeRouterInstallationKind = 'desktop' | 'mixed' | 'npm' | 'unknown';
export type ClaudeRouterInstallSource = 'github' | 'npm' | 'npmmirror';
export type ClaudeCodeInstallSource = 'native' | 'npm' | 'npmmirror';
export type ClaudeRouterProviderProtocol =
  'anthropic_messages' | 'openai_chat_completions' | 'openai_responses';

export interface ClaudeConfigView {
  authMode: ClaudeAuthMode;
  baseUrl: string;
  credentialConfigured: boolean;
  model: string;
  preset: ClaudePreset;
  provider: ClaudeProvider;
}

export interface SaveClaudeConfigInput {
  authMode: ClaudeAuthMode;
  baseUrl: string;
  credential?: string;
  credentialAction: ClaudeCredentialAction;
  model: string;
  preset: ClaudePreset;
  provider: ClaudeProvider;
}

export interface ClaudeInstallationStatus {
  executable?: string;
  installed: boolean;
  message: string;
  security: ClaudeSecurityStatus;
  version?: string;
}

export interface ClaudeMetrics {
  capturedAt: number;
  contextWindowSize?: number;
  contextWindowUsed?: number;
  inputTokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
  modelDisplayName?: string;
  modelId?: string;
  outputTokens?: number;
  rateLimitFiveHour?: number;
  rateLimitSevenDay?: number;
  sessionCostUsd?: number;
  sessionDurationMs?: number;
  sessionId?: string;
  sessionName?: string;
}

export interface ClaudeRouteHealth {
  blocking: boolean;
  checkedAt: number;
  detail: string;
  headline: string;
  source: ClaudeRouteHealthSource;
  tone: ClaudeRouteHealthTone;
}

export interface ClaudeProjectState {
  active: boolean;
  config: ClaudeConfigView;
  cwd: string;
  expectedModel?: string;
  installation: ClaudeInstallationStatus;
  metrics?: ClaudeMetrics;
  modelMatches?: boolean;
  routeHealth?: ClaudeRouteHealth;
  sessionId: string;
  warning?: string;
}

export interface ClaudeConfigResult {
  error?: string;
  ok: boolean;
  state: ClaudeProjectState;
}

export interface ClaudeOperationResult {
  error?: string;
  ok: boolean;
  state: ClaudeProjectState;
}

export interface ClaudeConnectionTestStage {
  detail: string;
  id: 'authentication' | 'endpoint' | 'model';
  label: string;
  status: 'failed' | 'passed' | 'skipped' | 'warning';
}

export interface ClaudeConnectionTestResult {
  latencyMs?: number;
  message: string;
  ok: boolean;
  stages: ClaudeConnectionTestStage[];
  testedAt: number;
  tone: ClaudeConnectionTestTone;
}

export interface ClaudeGatewayCandidate {
  apiBaseUrl: string;
  authRequired: boolean;
  detail: string;
  detectedBy: string[];
  id: string;
  kind: GatewayCandidateKind;
  label: string;
  managementUrl?: string;
  status: GatewayCandidateStatus;
}

export interface ClaudeConfigurationHint {
  authConfigured: boolean;
  baseUrl?: string;
  label: string;
  source: 'environment' | 'project-settings' | 'user-settings';
}

export interface ClaudeGatewayDiagnostics {
  candidates: ClaudeGatewayCandidate[];
  checkedAt: number;
  configurationHints: ClaudeConfigurationHint[];
  message: string;
}

export interface ClaudeRouterProviderView {
  baseUrl: string;
  credentialConfigured: boolean;
  id: string;
  models: string[];
  name: string;
  preferred: boolean;
  protocol: ClaudeRouterProviderProtocol;
}

export interface ClaudeRouterManagementState {
  canUninstall: boolean;
  checkedAt: number;
  endpoint: string;
  gatewayState: ClaudeRouterGatewayState;
  installed: boolean;
  installationKind: ClaudeRouterInstallationKind;
  manageable: boolean;
  managementAvailable: boolean;
  message: string;
  providers: ClaudeRouterProviderView[];
  runtimeMismatch?: boolean;
  serviceRunning: boolean;
  version?: string;
}

export interface SaveClaudeRouterProviderInput {
  apiKey?: string;
  baseUrl: string;
  credentialAction: 'keep' | 'replace';
  id?: string;
  makePreferred: boolean;
  models: string[];
  name: string;
  protocol: ClaudeRouterProviderProtocol;
  useForCurrentProject: boolean;
}

export interface ClaudeRouterOperationResult {
  error?: string;
  message: string;
  ok: boolean;
  projectState?: ClaudeProjectState;
  provider?: ClaudeRouterProviderView;
  routerState: ClaudeRouterManagementState;
}

export interface TerminalStatus {
  cwd: string;
  id: string;
  message?: string;
  phase: TerminalPhase;
  pid?: number;
  shell: string;
  title: string;
}

export interface WorkspaceProject {
  addedAt: number;
  lastActiveAt: number;
  path: string;
}

/** Shape owned by TerminalWorkspace; it knows nothing about persisted projects. */
export interface TerminalWorkspaceState {
  activeSessionId: string;
  sessions: TerminalStatus[];
}

/** A project folder: either currently open (has live conversations) or only remembered. */
export interface WorkspaceProjectView {
  lastActiveAt?: number;
  missing: boolean;
  name: string;
  open: boolean;
  path: string;
  remembered: boolean;
  sessionIds: string[];
}

export interface WorkspaceState extends TerminalWorkspaceState {
  projects: WorkspaceProjectView[];
}

export interface ClaudeSessionMetadata {
  conversationId: string;
  estimatedCostUsd?: number;
  inputTokens?: number;
  lastActiveAt: number;
  messageCount: number;
  modelId?: string;
  outputTokens?: number;
  sessionId: string;
  sessionName?: string;
}

export type ClaudePluginScope = 'local' | 'project' | 'user';

export interface ClaudePluginView {
  description: string;
  enabled: boolean;
  installCount?: number;
  installed: boolean;
  latestVersion?: string;
  marketplaceName: string;
  name: string;
  pluginId: string;
  scope?: ClaudePluginScope;
  sourceLabel: string;
  sourceRevision?: string;
  latestSourceRevision?: string;
  updateAvailable: boolean;
  version?: string;
}

export interface ClaudePluginMarketplaceView {
  installLocation?: string;
  name: string;
  repo?: string;
  source: string;
}

export interface ClaudePluginCatalog {
  available: ClaudePluginView[];
  checkedAt: number;
  cliAvailable: boolean;
  installed: ClaudePluginView[];
  marketplaces: ClaudePluginMarketplaceView[];
  message: string;
  updatesAvailable: number;
}

export interface ClaudePluginOperationResult {
  catalog: ClaudePluginCatalog;
  error?: string;
  message: string;
  ok: boolean;
}

export interface SoftwareUpdateTarget {
  currentVersion?: string;
  installed: boolean;
  latestVersion?: string;
  message: string;
  updateAvailable: boolean;
}

export interface SoftwareUpdateState {
  checkedAt: number;
  claudeCode: SoftwareUpdateTarget;
  router: SoftwareUpdateTarget;
}

export interface SoftwareUpdateOperationResult {
  error?: string;
  message: string;
  ok: boolean;
  state: SoftwareUpdateState;
}

export type ClaudeConnectionAdviceTone = 'error' | 'info' | 'success' | 'warning';
export type ClaudeConnectionAdviceAction =
  | 'install-router'
  | 'import-curl'
  | 'open-router-management'
  | 'save-config'
  | 'start-router'
  | 'stop-router'
  | 'switch-to-direct'
  | 'switch-to-router'
  | 'test-connection';

export interface ClaudeConnectionAdvice {
  actions: ClaudeConnectionAdviceAction[];
  detail: string;
  /** When true the renderer greys out every Router control: this project does not need it. */
  routerNeeded: boolean;
  routerRunningButUnused: boolean;
  title: string;
  tone: ClaudeConnectionAdviceTone;
}

export interface OperationResult {
  error?: string;
  ok: boolean;
  status: TerminalStatus;
}

export interface WorkspaceResult {
  error?: string;
  ok: boolean;
  reused?: boolean;
  state: WorkspaceState;
}

export type DirectoryChoiceResult =
  | {
      canceled: true;
    }
  | {
      canceled: false;
      path: string;
    };

export type Unsubscribe = () => void;

export interface ControlPanelApi {
  activateProject: (sessionId: string) => Promise<WorkspaceResult>;
  addProject: (directoryPath: string) => Promise<WorkspaceResult>;
  chooseDirectory: () => Promise<DirectoryChoiceResult>;
  closeProject: (sessionId: string) => Promise<WorkspaceResult>;
  /** Close every live conversation of a folder but keep the folder remembered. */
  closeProjectFolder: (projectPath: string) => Promise<WorkspaceResult>;
  /** Open one more concurrent conversation inside an already-open folder. */
  openConversation: (projectPath: string) => Promise<WorkspaceResult>;
  /** Open a remembered folder's history entry as a live conversation. */
  openStoredConversation: (projectPath: string, conversationId: string) => Promise<WorkspaceResult>;
  renameConversation: (sessionId: string, title: string) => Promise<WorkspaceResult>;
  /** Forget a folder entirely: closes its conversations and drops it from disk. */
  forgetProject: (projectPath: string) => Promise<WorkspaceResult>;
  getClaudeProjectState: (sessionId: string) => Promise<ClaudeProjectState>;
  getClaudeGatewayDiagnostics: (sessionId: string) => Promise<ClaudeGatewayDiagnostics>;
  getClaudeRouterManagementState: (sessionId: string) => Promise<ClaudeRouterManagementState>;
  getClaudeConnectionAdvice: (sessionId: string) => Promise<ClaudeConnectionAdvice>;
  getDroppedPath: (file: File) => string;
  getWorkspace: () => Promise<WorkspaceState>;
  deleteClaudeRouterProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<ClaudeRouterOperationResult>;
  installClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  installClaudeRouterFromSource: (
    sessionId: string,
    source: ClaudeRouterInstallSource,
  ) => Promise<ClaudeRouterOperationResult>;
  uninstallClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  launchClaude: (sessionId: string, mode: ClaudeLaunchMode) => Promise<ClaudeOperationResult>;
  openClaudeRouterManagement: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  onClaudeState: (listener: (state: ClaudeProjectState) => void) => Unsubscribe;
  onTerminalData: (listener: (sessionId: string, data: string) => void) => Unsubscribe;
  onWorkspaceState: (listener: (state: WorkspaceState) => void) => Unsubscribe;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  restartTerminal: (sessionId: string) => Promise<OperationResult>;
  runClaudeCommand: (
    sessionId: string,
    command: string,
    argument?: string,
  ) => Promise<ClaudeOperationResult>;
  saveClaudeConfig: (
    sessionId: string,
    input: SaveClaudeConfigInput,
  ) => Promise<ClaudeConfigResult>;
  saveClaudeRouterProvider: (
    sessionId: string,
    input: SaveClaudeRouterProviderInput,
  ) => Promise<ClaudeRouterOperationResult>;
  repairClaudeRouterFromProject: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  startClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  stopClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  testClaudeConnection: (
    sessionId: string,
    input: SaveClaudeConfigInput,
  ) => Promise<ClaudeConnectionTestResult>;
  openExternal: (url: string) => Promise<boolean>;
  startTerminal: (sessionId: string) => Promise<OperationResult>;
  stopTerminal: (sessionId: string) => Promise<OperationResult>;
  writeTerminal: (sessionId: string, data: string) => void;
  getStoredProjects: () => Promise<WorkspaceProject[]>;
  removeStoredProject: (projectPath: string) => Promise<void>;
  getClaudeSessions: (sessionId: string) => Promise<ClaudeSessionMetadata[]>;
  getClaudeSessionsForPath: (projectPath: string) => Promise<ClaudeSessionMetadata[]>;
  deleteClaudeSession: (sessionId: string, conversationId: string) => Promise<boolean>;
  launchClaudeWithSession: (
    sessionId: string,
    conversationId: string,
  ) => Promise<ClaudeOperationResult>;
  getClaudePlugins: (refresh?: boolean) => Promise<ClaudePluginCatalog>;
  installClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  uninstallClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  setClaudePluginEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<ClaudePluginOperationResult>;
  updateClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  addClaudePluginMarketplace: (source: string) => Promise<ClaudePluginOperationResult>;
  removeClaudePluginMarketplace: (name: string) => Promise<ClaudePluginOperationResult>;
  refreshClaudePluginMarketplaces: () => Promise<ClaudePluginOperationResult>;
  updateAllClaudePlugins: () => Promise<ClaudePluginOperationResult>;
  getSoftwareUpdates: (refresh?: boolean) => Promise<SoftwareUpdateState>;
  installOrUpdateClaudeCode: (
    source: ClaudeCodeInstallSource,
  ) => Promise<SoftwareUpdateOperationResult>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<boolean>;
}
