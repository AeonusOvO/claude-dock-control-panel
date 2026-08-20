const GLOBAL_SCOPE = '__global__';

const operationScope = (sessionId?: string): string => sessionId || GLOBAL_SCOPE;

/**
 * Tracks the renderer-side gap before the main process can publish its authoritative `busy` state.
 * Progress for every project is recorded, so changing tabs cannot strand a stale global boolean and
 * permanently disable the newly rendered setup button.
 */
export class ManagedChatGptOperationTracker {
  private readonly localInFlightScopes = new Set<string>();
  private readonly activeProgressScopes = new Set<string>();

  public get busy(): boolean {
    return this.localInFlightScopes.size > 0 || this.activeProgressScopes.size > 0;
  }

  /** Atomically acquires the local click lock. */
  public begin(sessionId?: string): boolean {
    if (this.busy) return false;
    this.localInFlightScopes.add(operationScope(sessionId));
    return true;
  }

  public finish(sessionId?: string): void {
    this.localInFlightScopes.delete(operationScope(sessionId));
  }

  public update(sessionId: string | undefined, active: boolean): void {
    if (active) this.activeProgressScopes.add(operationScope(sessionId));
    else this.activeProgressScopes.delete(operationScope(sessionId));
  }
}

export type ManagedChatGptOperationResult<TResult> =
  { started: false } | { result: TResult; started: true };

/**
 * Acquires the renderer click lock before invoking setup and releases it on every completion path.
 * `sessionId` is deliberately optional: `undefined` is the global install/login scope used before
 * any project has been opened.
 */
export const runManagedChatGptOperation = async <TResult>(
  tracker: ManagedChatGptOperationTracker,
  sessionId: string | undefined,
  operation: (sessionId: string | undefined) => Promise<TResult>,
): Promise<ManagedChatGptOperationResult<TResult>> => {
  if (!tracker.begin(sessionId)) return { started: false };
  try {
    return { result: await operation(sessionId), started: true };
  } finally {
    tracker.finish(sessionId);
  }
};
