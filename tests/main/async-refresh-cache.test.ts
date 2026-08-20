import { describe, expect, it, vi } from 'vitest';
import { AsyncRefreshCache } from '../../src/main/infra/async-refresh-cache';

describe('AsyncRefreshCache', () => {
  it('coalesces concurrent refreshes and reuses the fresh result', async () => {
    let release: ((value: string) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new AsyncRefreshCache<string>(3_000);

    const first = cache.get(loader);
    const second = cache.get(loader);

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    release?.('ready');
    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    await expect(cache.get(loader)).resolves.toBe('ready');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('refreshes after expiry and lets an explicit value supersede an older request', async () => {
    let now = 1_000;
    let release: ((value: string) => void) | undefined;
    const cache = new AsyncRefreshCache<string>(100, () => now);
    cache.set('cached');

    await expect(cache.get(async () => 'unused')).resolves.toBe('cached');
    now += 101;
    const staleRequest = cache.get(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    cache.set('newer');
    release?.('stale');

    await expect(staleRequest).resolves.toBe('stale');
    await expect(cache.get(async () => 'unused')).resolves.toBe('newer');
  });

  it('does not cache rejected refreshes', async () => {
    const cache = new AsyncRefreshCache<string>(3_000);
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('recovered');

    await expect(cache.get(loader)).rejects.toThrow('offline');
    await expect(cache.get(loader)).resolves.toBe('recovered');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
