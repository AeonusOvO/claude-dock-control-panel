import type { FailureMetadata } from '../diagnostics/failure';
import type { TerminalStatus } from './terminal';

export type DevelopmentRuntime = 'claude' | 'codex';

export interface DevelopmentRuntimeState {
  cwd: string;
  runtime: DevelopmentRuntime;
  sessionId: string;
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

export interface WorkspaceResult extends FailureMetadata {
  error?: string;
  ok: boolean;
  reused?: boolean;
  state: WorkspaceState;
}

export type DirectoryChoiceResult =
  | {
      canceled: true;
      error?: string;
    }
  | {
      canceled: false;
      path: string;
    };
