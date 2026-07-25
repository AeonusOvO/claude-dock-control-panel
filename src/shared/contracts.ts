export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';

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
  getDroppedPath: (file: File) => string;
  getWorkspace: () => Promise<WorkspaceState>;
  onTerminalData: (listener: (sessionId: string, data: string) => void) => Unsubscribe;
  onWorkspaceState: (listener: (state: WorkspaceState) => void) => Unsubscribe;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  restartTerminal: (sessionId: string) => Promise<OperationResult>;
  startTerminal: (sessionId: string) => Promise<OperationResult>;
  stopTerminal: (sessionId: string) => Promise<OperationResult>;
  writeTerminal: (sessionId: string, data: string) => void;
}
