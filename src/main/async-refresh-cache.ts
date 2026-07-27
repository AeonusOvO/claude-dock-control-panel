interface CachedValue<T> {
  checkedAt: number;
  value: T;
}

/**
 * Shares one expensive refresh between concurrent callers and keeps its result for a short TTL.
 * `clear`/`set` advance a generation so an older request cannot overwrite newer mutation state.
 */
export class AsyncRefreshCache<T> {
  private cached?: CachedValue<T>;
  private generation = 0;
  private inFlight?: Promise<T>;

  public constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public clear(): void {
    this.cached = undefined;
    this.generation += 1;
    this.inFlight = undefined;
  }

  public set(value: T): void {
    this.generation += 1;
    this.inFlight = undefined;
    this.cached = { checkedAt: this.now(), value };
  }

  public get(loader: () => Promise<T>, force = false): Promise<T> {
    if (!force && this.cached && this.now() - this.cached.checkedAt < this.ttlMs) {
      return Promise.resolve(this.cached.value);
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const generation = this.generation;
    const request = loader()
      .then((value) => {
        if (generation === this.generation) {
          this.cached = { checkedAt: this.now(), value };
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight === request) {
          this.inFlight = undefined;
        }
      });
    this.inFlight = request;
    return request;
  }
}
