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
  checkedAt: number;
  endpoint: string;
  gatewayState: ClaudeRouterGatewayState;
  installed: boolean;
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
}

export interface WorkspaceProject {
  addedAt: number;
  lastActiveAt: number;
  path: string;
}

export interface WorkspaceState {
  activeSessionId: string;
  sessions: TerminalStatus[];
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
  getClaudeProjectState: (sessionId: string) => Promise<ClaudeProjectState>;
  getClaudeGatewayDiagnostics: (sessionId: string) => Promise<ClaudeGatewayDiagnostics>;
  getClaudeRouterManagementState: (sessionId: string) => Promise<ClaudeRouterManagementState>;
  getDroppedPath: (file: File) => string;
  getWorkspace: () => Promise<WorkspaceState>;
  deleteClaudeRouterProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<ClaudeRouterOperationResult>;
  installClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
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
  deleteClaudeSession: (sessionId: string, conversationId: string) => Promise<boolean>;
  launchClaudeWithSession: (
    sessionId: string,
    conversationId: string,
  ) => Promise<ClaudeOperationResult>;
}
