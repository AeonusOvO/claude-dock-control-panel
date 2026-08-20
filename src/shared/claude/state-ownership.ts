import type { PtyGeneration } from '../contracts';

export interface ClaudeStateOwnership {
  ptyGeneration?: PtyGeneration;
  stateRevision: number;
}

/**
 * Rejects an out-of-order Claude state or a state owned by a replaced ConPTY generation. Inactive
 * states deliberately omit PTY ownership, but they still have to advance the state revision.
 */
export const claudeStateOwnershipIsCurrent = (
  incoming: ClaudeStateOwnership,
  currentRevision: number | undefined,
  currentPtyGeneration: PtyGeneration,
): boolean =>
  (incoming.ptyGeneration === undefined || incoming.ptyGeneration === currentPtyGeneration) &&
  (currentRevision === undefined || incoming.stateRevision >= currentRevision);
