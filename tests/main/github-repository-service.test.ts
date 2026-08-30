import { describe, expect, it, vi } from 'vitest';
import {
  GitHubRepositoryStarsService,
  type GitHubStarsFetch,
} from '../../src/main/claude/plugins/github-repository-service';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe('GitHubRepositoryStarsService', () => {
  it('normalizes repository spellings and performs one credential-free request per identity', async () => {
    const fetchImplementation = vi.fn<GitHubStarsFetch>(async (input, init) => {
      expect(input).toBe('https://api.github.com/repos/owner/repository');
      expect(init?.method).toBe('GET');
      const headers = new Headers(init?.headers);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.get('accept')).toBe('application/vnd.github+json');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ stargazers_count: 42 });
    });
    const service = new GitHubRepositoryStarsService({ fetch: fetchImplementation });

    const first = await service.get('https://github.com/Owner/Repository.git?view=readme#section');
    const second = await service.get('github:owner/repository');
    const third = await service.get('OWNER/REPOSITORY');

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      provenance: 'live',
      repositoryUri: 'https://github.com/owner/repository',
      stars: 42,
    });
    expect(second).toMatchObject({ provenance: 'cached', stars: 42 });
    expect(third).toMatchObject({ provenance: 'cached', stars: 42 });
  });

  it('uses the TTL cache and refreshes an expired entry independently of the caller', async () => {
    let now = 1_000;
    const fetchImplementation = vi
      .fn<GitHubStarsFetch>()
      .mockResolvedValueOnce(jsonResponse({ stargazers_count: 10 }))
      .mockResolvedValueOnce(jsonResponse({ stargazers_count: 11 }));
    const service = new GitHubRepositoryStarsService({
      fetch: fetchImplementation,
      now: () => now,
      ttlMs: 100,
    });

    await expect(service.get('owner/repository')).resolves.toMatchObject({
      provenance: 'live',
      stars: 10,
    });
    now = 1_050;
    await expect(service.get('owner/repository')).resolves.toMatchObject({
      provenance: 'cached',
      stars: 10,
    });
    now = 1_100;
    await expect(service.get('owner/repository')).resolves.toMatchObject({
      provenance: 'live',
      stars: 11,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent requests across alternate repository spellings', async () => {
    const pending = deferred<Response>();
    const fetchImplementation = vi.fn<GitHubStarsFetch>(() => pending.promise);
    const service = new GitHubRepositoryStarsService({ fetch: fetchImplementation });

    const first = service.get('owner/repository');
    const second = service.get('https://www.github.com/OWNER/REPOSITORY/');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    pending.resolve(jsonResponse({ stargazers_count: 7 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        provenance: 'live',
        repositoryUri: 'https://github.com/owner/repository',
        stars: 7,
      },
      {
        provenance: 'live',
        repositoryUri: 'https://github.com/owner/repository',
        stars: 7,
      },
    ]);
  });

  it('falls back to stale cached stars after a refresh failure', async () => {
    let now = 0;
    const fetchImplementation = vi
      .fn<GitHubStarsFetch>()
      .mockResolvedValueOnce(jsonResponse({ stargazers_count: 19 }))
      .mockRejectedValueOnce(new Error('network unavailable'));
    const service = new GitHubRepositoryStarsService({
      fetch: fetchImplementation,
      now: () => now,
      ttlMs: 10,
    });

    await expect(service.get('owner/repository')).resolves.toMatchObject({
      provenance: 'live',
      stars: 19,
    });
    now = 11;
    await expect(service.get('owner/repository')).resolves.toMatchObject({
      provenance: 'cached',
      stars: 19,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('falls back to normalized built-in metadata when live data is unavailable', async () => {
    const fetchImplementation = vi.fn<GitHubStarsFetch>().mockRejectedValue(new Error('offline'));
    const service = new GitHubRepositoryStarsService({
      builtInStars: { 'OWNER/REPOSITORY': 23 },
      fetch: fetchImplementation,
      ttlMs: 60_000,
    });

    await expect(service.get('https://github.com/owner/repository.git')).resolves.toEqual({
      provenance: 'built-in',
      repositoryUri: 'https://github.com/owner/repository',
      stars: 23,
    });
    await expect(service.get('owner/repository')).resolves.toMatchObject({
      provenance: 'built-in',
      stars: 23,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('fails closed on HTTP and malformed responses without rejecting metadata lookup', async () => {
    const invalidBodies: unknown[] = [
      { stargazers_count: -1 },
      { stargazers_count: 1.5 },
      { stargazers_count: '12' },
      { stargazers_count: Number.MAX_SAFE_INTEGER + 1 },
      [],
    ];

    for (const body of invalidBodies) {
      const fetchImplementation = vi.fn<GitHubStarsFetch>().mockResolvedValue(jsonResponse(body));
      const service = new GitHubRepositoryStarsService({
        builtInStars: { 'owner/repository': null },
        fetch: fetchImplementation,
      });
      await expect(service.get('owner/repository')).resolves.toEqual({
        provenance: 'built-in',
        repositoryUri: 'https://github.com/owner/repository',
        stars: null,
      });
    }

    const nonOk = new GitHubRepositoryStarsService({
      builtInStars: { 'owner/repository': 3 },
      fetch: vi.fn<GitHubStarsFetch>().mockResolvedValue(jsonResponse({}, 429)),
    });
    await expect(nonOk.get('owner/repository')).resolves.toMatchObject({
      provenance: 'built-in',
      stars: 3,
    });
  });

  it('passes an abort signal and resolves with fallback when the request times out', async () => {
    const fetchImplementation = vi.fn<GitHubStarsFetch>((_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const service = new GitHubRepositoryStarsService({
      builtInStars: { 'owner/repository': 8 },
      fetch: fetchImplementation,
      timeoutMs: 1,
    });

    await expect(service.get('owner/repository')).resolves.toMatchObject({
      provenance: 'built-in',
      stars: 8,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('does not issue a request for malformed or credential-bearing repository identities', async () => {
    const fetchImplementation = vi.fn<GitHubStarsFetch>();
    const service = new GitHubRepositoryStarsService({ fetch: fetchImplementation });

    await expect(
      service.get('https://user:secret@github.com/owner/repository'),
    ).resolves.toBeUndefined();
    await expect(
      service.get('https://github.com/owner/repository?token=secret'),
    ).resolves.toMatchObject({
      stars: null,
      provenance: 'built-in',
    });
    await expect(service.get('https://github.com/owner/repository#secret')).resolves.toMatchObject({
      stars: null,
      provenance: 'built-in',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
