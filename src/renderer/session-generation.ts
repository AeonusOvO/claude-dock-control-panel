export interface SessionGenerationToken {
  readonly generation: number;
  readonly sessionId: string;
}

export type SessionOperationOutcome<TResult> =
  | { status: 'cancelled' | 'stale' }
  | { error: unknown; status: 'rejected' }
  | { result: TResult; status: 'resolved' };

export interface SessionOperationOrchestration<TResult> {
  applyResult: (result: TResult) => boolean;
  confirmation?: () => Promise<boolean>;
  onCancel?: () => void;
  registry: SessionGenerationRegistry;
  start: () => Promise<TResult>;
  token: SessionGenerationToken;
}

/**
 * Tracks the one asynchronous generation that currently owns work for each session. Generations are
 * globally unique so deleting and later recreating the same session id cannot make an old completion
 * current again.
 */
export class SessionGenerationRegistry {
  private readonly active = new Map<string, SessionGenerationToken>();
  private nextGeneration = 0;

  public begin(sessionId: string): SessionGenerationToken {
    const token = {
      generation: ++this.nextGeneration,
      sessionId,
    };
    this.active.set(sessionId, token);
    return token;
  }

  public current(sessionId: string): SessionGenerationToken | undefined {
    const token = this.active.get(sessionId);
    return token ? { ...token } : undefined;
  }

  public finish(token: SessionGenerationToken): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    this.active.delete(token.sessionId);
    return true;
  }

  public invalidate(sessionId: string): SessionGenerationToken | undefined {
    const token = this.active.get(sessionId);
    if (!token) {
      return undefined;
    }
    this.active.delete(sessionId);
    return { ...token };
  }

  public isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  public isCurrent(token: SessionGenerationToken): boolean {
    return this.active.get(token.sessionId)?.generation === token.generation;
  }

  public prune(validSessionIds: ReadonlySet<string>): SessionGenerationToken[] {
    const invalidated: SessionGenerationToken[] = [];
    for (const sessionId of this.active.keys()) {
      if (!validSessionIds.has(sessionId)) {
        const token = this.invalidate(sessionId);
        if (token) {
          invalidated.push(token);
        }
      }
    }
    return invalidated;
  }
}

/**
 * Keeps an async renderer operation current independently from any lifecycle lock it may create.
 * A PTY transition is allowed to release launch controls while the operation still owns its IPC
 * settlement and final repaint.
 */
export const orchestrateSessionOperation = async <TResult>({
  applyResult,
  confirmation,
  onCancel,
  registry,
  start,
  token,
}: SessionOperationOrchestration<TResult>): Promise<SessionOperationOutcome<TResult>> => {
  try {
    if (confirmation) {
      const confirmed = await confirmation();
      if (!registry.isCurrent(token)) {
        return { status: 'stale' };
      }
      if (!confirmed) {
        onCancel?.();
        return { status: 'cancelled' };
      }
    }
    if (!registry.isCurrent(token)) {
      return { status: 'stale' };
    }
    const result = await start();
    if (!registry.isCurrent(token) || !applyResult(result)) {
      return { status: 'stale' };
    }
    return { result, status: 'resolved' };
  } catch (error) {
    return registry.isCurrent(token) ? { error, status: 'rejected' } : { status: 'stale' };
  }
};
