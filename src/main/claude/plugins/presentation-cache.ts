export type PresentationCacheStatus = 'fresh' | 'stale-degraded';

export interface PresentationCacheResult<T> {
  checkedAt: number;
  lastSuccessfulAt?: number;
  message?: string;
  status: PresentationCacheStatus;
  value: T;
}

interface CachedPresentation<T> {
  cachedAt: number;
  result: PresentationCacheResult<T>;
}

interface PresentationLoad<T> {
  generation: number;
  promise: Promise<PresentationCacheResult<T>>;
}

export interface GenerationFencedPresentationCacheOptions<T> {
  createFallback: () => T;
  failureMessage?: string;
  now?: () => number;
  ttlMs: number;
}

/**
 * A presentation-oriented cache that keeps last-known-good data on refresh failure. Invalidation
 * advances a generation, so a request that began earlier can neither publish nor clear newer state.
 */
export class GenerationFencedPresentationCache<T> {
  private current?: CachedPresentation<T>;
  private generation = 0;
  private inFlight?: PresentationLoad<T>;
  private lastGood?: { successfulAt: number; value: T };
  private readonly createFallback: () => T;
  private readonly failureMessage: string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(options: GenerationFencedPresentationCacheOptions<T>) {
    this.createFallback = options.createFallback;
    this.failureMessage =
      options.failureMessage ?? 'Refresh failed; showing last-known-good plugin catalog data.';
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(0, options.ttlMs);
  }

  public get(loader: () => Promise<T> | T, force = false): Promise<PresentationCacheResult<T>> {
    if (!force && this.current && this.now() - this.current.cachedAt < this.ttlMs) {
      return Promise.resolve(this.current.result);
    }

    const generation = this.generation;
    if (this.inFlight?.generation === generation) {
      return this.inFlight.promise;
    }

    const load = {} as PresentationLoad<T>;
    load.generation = generation;
    load.promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (generation !== this.generation) {
          return this.get(loader, false);
        }
        const successfulAt = this.now();
        const result: PresentationCacheResult<T> = {
          checkedAt: successfulAt,
          lastSuccessfulAt: successfulAt,
          status: 'fresh',
          value,
        };
        this.lastGood = { successfulAt, value };
        this.current = { cachedAt: successfulAt, result };
        return result;
      })
      .catch(() => {
        if (generation !== this.generation) {
          return this.get(loader, false);
        }
        const checkedAt = this.now();
        const result: PresentationCacheResult<T> = {
          checkedAt,
          lastSuccessfulAt: this.lastGood?.successfulAt,
          message: this.failureMessage,
          status: 'stale-degraded',
          value: this.lastGood?.value ?? this.createFallback(),
        };
        this.current = { cachedAt: checkedAt, result };
        return result;
      })
      .finally(() => {
        if (this.inFlight === load) {
          this.inFlight = undefined;
        }
      });
    this.inFlight = load;
    return load.promise;
  }

  /** Invalidates freshness without discarding the last successful presentation. */
  public invalidate(): void {
    this.generation += 1;
    this.current = undefined;
    this.inFlight = undefined;
  }

  public peek(): PresentationCacheResult<T> | undefined {
    return this.current?.result;
  }

  public set(value: T): PresentationCacheResult<T> {
    this.generation += 1;
    this.inFlight = undefined;
    const successfulAt = this.now();
    const result: PresentationCacheResult<T> = {
      checkedAt: successfulAt,
      lastSuccessfulAt: successfulAt,
      status: 'fresh',
      value,
    };
    this.lastGood = { successfulAt, value };
    this.current = { cachedAt: successfulAt, result };
    return result;
  }
}
