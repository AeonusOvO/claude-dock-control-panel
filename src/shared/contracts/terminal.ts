import type { FailureMetadata } from '../diagnostics/failure';

export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';

export type PtyGeneration = number;

export interface TerminalStatus {
  cwd: string;
  diagnosticCode?:
    | 'CWD_UNAVAILABLE'
    | 'NATIVE_BACKEND_UNAVAILABLE'
    | 'POWERSHELL_UNAVAILABLE'
    | 'PTY_START_FAILED';
  id: string;
  message?: string;
  phase: TerminalPhase;
  pid?: number;
  ptyGeneration: PtyGeneration;
  shell: string;
  title: string;
}

export interface OperationResult extends FailureMetadata {
  error?: string;
  message?: string;
  ok: boolean;
  /** Absent when the workspace has no conversation to report on — e.g. before a project is opened. */
  status?: TerminalStatus;
}
