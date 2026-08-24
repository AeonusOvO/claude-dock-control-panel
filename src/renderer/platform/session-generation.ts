export interface SessionGenerationToken {
  readonly generation: number;
  readonly sessionId: string;
}

export interface OwnedSessionOperationToken<
  TOperation extends string,
> extends SessionGenerationToken {
  readonly operation: TOperation;
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
 * Couples a per-session generation with the operation that owns the visible busy state. Renderers can
 * ask for the current token on every repaint, so unrelated state loads cannot restore stale labels or
 * controls while the exact operation is still pending.
 */
export class OwnedSessionOperationRegistry<TOperation extends string> {
  private readonly active = new Map<string, OwnedSessionOperationToken<TOperation>>();
  private nextGeneration = 0;

  public begin(sessionId: string, operation: TOperation): OwnedSessionOperationToken<TOperation> {
    const token = Object.freeze({
      generation: ++this.nextGeneration,
      operation,
      sessionId,
    });
    this.active.set(sessionId, token);
    return token;
  }

  public current(sessionId: string): OwnedSessionOperationToken<TOperation> | undefined {
    return this.active.get(sessionId);
  }

  public finish(token: OwnedSessionOperationToken<TOperation>): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    this.active.delete(token.sessionId);
    return true;
  }

  public invalidate(sessionId: string): OwnedSessionOperationToken<TOperation> | undefined {
    const token = this.active.get(sessionId);
    if (!token) {
      return undefined;
    }
    this.active.delete(sessionId);
    return token;
  }

  public isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  public isCurrent(token: OwnedSessionOperationToken<TOperation>): boolean {
    return this.active.get(token.sessionId)?.generation === token.generation;
  }

  public prune(validSessionIds: ReadonlySet<string>): OwnedSessionOperationToken<TOperation>[] {
    const invalidated: OwnedSessionOperationToken<TOperation>[] = [];
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
 * Tracks one application-global operation while retaining the initiating session for result fencing.
 * Starting a replacement immediately makes every settlement from the previous owner stale.
 */
export class OwnedOperationRegistry<TOperation extends string> {
  private active?: OwnedSessionOperationToken<TOperation>;
  private nextGeneration = 0;

  public begin(sessionId: string, operation: TOperation): OwnedSessionOperationToken<TOperation> {
    const token = Object.freeze({
      generation: ++this.nextGeneration,
      operation,
      sessionId,
    });
    this.active = token;
    return token;
  }

  public current(): OwnedSessionOperationToken<TOperation> | undefined {
    return this.active;
  }

  public finish(token: OwnedSessionOperationToken<TOperation>): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    this.active = undefined;
    return true;
  }

  public isActive(): boolean {
    return Boolean(this.active);
  }

  public isCurrent(token: OwnedSessionOperationToken<TOperation>): boolean {
    return this.active?.generation === token.generation;
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
