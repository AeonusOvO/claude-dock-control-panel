export interface SessionGenerationToken {
  readonly generation: number;
  readonly sessionId: string;
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
