export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';

export interface TerminalStatus {
  cwd: string;
  message?: string;
  phase: TerminalPhase;
  pid?: number;
  shell: string;
}

export interface OperationResult {
  error?: string;
  ok: boolean;
  status: TerminalStatus;
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
  changeDirectory: (directoryPath: string) => Promise<OperationResult>;
  chooseDirectory: () => Promise<DirectoryChoiceResult>;
  getDroppedPath: (file: File) => string;
  getStatus: () => Promise<TerminalStatus>;
  onTerminalData: (listener: (data: string) => void) => Unsubscribe;
  onTerminalStatus: (listener: (status: TerminalStatus) => void) => Unsubscribe;
  resizeTerminal: (cols: number, rows: number) => void;
  restartTerminal: (cwd?: string) => Promise<OperationResult>;
  startTerminal: (cwd?: string) => Promise<OperationResult>;
  stopTerminal: () => Promise<OperationResult>;
  writeTerminal: (data: string) => void;
}
