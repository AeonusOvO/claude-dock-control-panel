import type { ClaudeOperationResult } from '../../shared/contracts';

/**
 * Turns a thrown error into a failed Claude operation result carrying the session's current project
 * state. Declared here so every IPC domain that reports a Claude failure injects the same signature
 * instead of restating it; the assembly owns the implementation because it closes over the runtime
 * handle and the workspace.
 */
export type ReportClaudeOperationFailure = (
  sessionId: string,
  error: unknown,
) => Promise<ClaudeOperationResult>;
