import type { ClaudeProjectState } from '../../shared/contracts';
import type { ClaudeRuntime } from './runtime';

export interface ClaudeProjectConfigTransactionOptions<TPrepared> {
  assertCurrent: () => void;
  commit: (prepared: TPrepared) => void;
  complete: (prepared: TPrepared) => Promise<ClaudeProjectState>;
  cwd: string;
  prepare: () => Promise<TPrepared> | TPrepared;
  validatePrepared?: (prepared: TPrepared) => Promise<void> | void;
  runtime: ClaudeRuntime;
  sessionId: string;
}

/**
 * Runs one prepare → optional validation → commit → complete write against a project's Claude
 * configuration under snapshot rollback. Declared here so every IPC domain that writes project
 * configuration injects the same signature instead of restating it; the assembly owns the
 * implementation because it closes over the transaction coordinator and the workspace.
 */
export type RunClaudeProjectConfigTransaction = <TPrepared>(
  options: ClaudeProjectConfigTransactionOptions<TPrepared>,
) => Promise<ClaudeProjectState>;
