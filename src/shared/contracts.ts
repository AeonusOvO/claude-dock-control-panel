export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';
export type ClaudeAuthMode = 'apiKey' | 'authToken' | 'existing' | 'none';
export type ClaudeCredentialAction = 'clear' | 'keep' | 'replace';
export type ClaudeLaunchMode = 'continue' | 'new' | 'resume';
export type ClaudePreset = 'anthropic' | 'custom' | 'deepseek' | 'gateway';
export type ClaudeProvider = 'anthropic' | 'gateway';
export type ClaudeSecurityStatus =
  'blocked-version' | 'not-installed' | 'ready' | 'update-required' | 'unknown';

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

export interface ClaudeProjectState {
  active: boolean;
  config: ClaudeConfigView;
  cwd: string;
  expectedModel?: string;
  installation: ClaudeInstallationStatus;
  metrics?: ClaudeMetrics;
  modelMatches?: boolean;
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

export interface TerminalStatus {
  cwd: string;
  id: string;
  message?: string;
  phase: TerminalPhase;
  pid?: number;
  shell: string;
}

export interface WorkspaceState {
  activeSessionId: string;
  sessions: TerminalStatus[];
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
  getDroppedPath: (file: File) => string;
  getWorkspace: () => Promise<WorkspaceState>;
  launchClaude: (sessionId: string, mode: ClaudeLaunchMode) => Promise<ClaudeOperationResult>;
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
  startTerminal: (sessionId: string) => Promise<OperationResult>;
  stopTerminal: (sessionId: string) => Promise<OperationResult>;
  writeTerminal: (sessionId: string, data: string) => void;
}
