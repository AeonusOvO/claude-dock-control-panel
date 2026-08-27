import type { FailureMetadata } from '../diagnostics/failure';

/** Maximum clipboard text retained for a single application-owned paste operation. */
export const MAX_CLIPBOARD_TEXT_LENGTH = 5 * 1024 * 1024;
/** xterm adds `ESC[200~` and `ESC[201~` around one bracketed-paste payload. */
export const XTERM_BRACKETED_PASTE_OVERHEAD = 12;
/** Preserves one xterm data event as one generation-fenced PTY write without truncation or chunking. */
export const MAX_TERMINAL_WRITE_LENGTH = MAX_CLIPBOARD_TEXT_LENGTH + XTERM_BRACKETED_PASTE_OVERHEAD;

export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';

export type PtyGeneration = number;

export interface TerminalSize {
  cols: number;
  rows: number;
}

export const DEFAULT_TERMINAL_SIZE: Readonly<TerminalSize> = { cols: 100, rows: 30 };

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
  /** Adopted PTY grid; a replacement renderer must use it before parsing the first output byte. */
  size?: TerminalSize;
  title: string;
}

export interface OperationResult extends FailureMetadata {
  error?: string;
  message?: string;
  ok: boolean;
  /** Absent when the workspace has no conversation to report on — e.g. before a project is opened. */
  status?: TerminalStatus;
}
