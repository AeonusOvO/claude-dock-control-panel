export interface FolderHistoryLoadToken {
  readonly generation: number;
  readonly projectKey: string;
}

export interface FolderHistoryLoadCompletion {
  current: boolean;
  reloadRequested: boolean;
}

/**
 * Owns one history read per canonical project path. A forced refresh queues behind the current read;
 * invalidation tombstones that read so a late completion cannot update or clear a later replacement.
 */
export class FolderHistoryLoadCoordinator {
  private readonly active = new Map<string, FolderHistoryLoadToken>();
  private readonly failed = new Set<string>();
  private nextGeneration = 0;
  private readonly reloadRequested = new Set<string>();

  public finish(token: FolderHistoryLoadToken): FolderHistoryLoadCompletion {
    if (!this.isCurrent(token)) {
      return { current: false, reloadRequested: false };
    }
    this.active.delete(token.projectKey);
    return {
      current: true,
      reloadRequested: this.reloadRequested.delete(token.projectKey),
    };
  }

  /**
   * A read that failed must stay distinguishable from a folder that genuinely has no conversations:
   * caching the failure as an empty history would make every later non-forced read short-circuit,
   * permanently hiding the user's real history behind one transient error.
   */
  public hasFailed(projectKey: string): boolean {
    return this.failed.has(projectKey);
  }

  public markFailed(projectKey: string): void {
    this.failed.add(projectKey);
  }

  public markLoaded(projectKey: string): void {
    this.failed.delete(projectKey);
  }

  public invalidate(projectKey: string): FolderHistoryLoadToken | undefined {
    const token = this.active.get(projectKey);
    this.active.delete(projectKey);
    this.failed.delete(projectKey);
    this.reloadRequested.delete(projectKey);
    return token ? { ...token } : undefined;
  }

  public isCurrent(token: FolderHistoryLoadToken): boolean {
    return this.active.get(token.projectKey)?.generation === token.generation;
  }

  public request(projectKey: string, force: boolean): FolderHistoryLoadToken | undefined {
    if (this.active.has(projectKey)) {
      if (force) {
        this.reloadRequested.add(projectKey);
      }
      return undefined;
    }
    const token = {
      generation: ++this.nextGeneration,
      projectKey,
    };
    this.active.set(projectKey, token);
    return token;
  }
}
