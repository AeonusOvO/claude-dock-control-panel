import { normalizeGitHubRepositoryIdentity, type GitHubRepositoryIdentity } from './source-types';
import type {
  ClaudePluginGitHubMetadata,
  ClaudePluginGitHubStarsProvenance,
} from '../../../shared/contracts';

const GITHUB_REPOSITORY_API = 'https://api.github.com/repos';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_STARS = Number.MAX_SAFE_INTEGER;

interface CachedRepositoryStars {
  lastAttemptAt: number;
  stars?: number | null;
  successfulAt?: number;
}

export type GitHubStarsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubRepositoryStarsServiceOptions {
  builtInStars?: ReadonlyMap<string, number | null> | Readonly<Record<string, number | null>>;
  fetch?: GitHubStarsFetch;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const safeNormalizeIdentity = (value: unknown): GitHubRepositoryIdentity | undefined => {
  try {
    return normalizeGitHubRepositoryIdentity(value);
  } catch {
    return undefined;
  }
};

const safeBuiltInStars = (
  value: GitHubRepositoryStarsServiceOptions['builtInStars'],
): ReadonlyMap<string, number | null> => {
  if (!value) {
    return new Map();
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  const normalized = new Map<string, number | null>();
  for (const [identityValue, stars] of entries) {
    const identity = safeNormalizeIdentity(identityValue)?.repositoryIdentity;
    if (!identity) {
      continue;
    }
    if (stars === null) {
      normalized.set(identity, null);
      continue;
    }
    if (
      typeof stars !== 'number' ||
      !Number.isSafeInteger(stars) ||
      stars < 0 ||
      stars > MAX_STARS
    ) {
      continue;
    }
    normalized.set(identity, stars);
  }
  return normalized;
};

const readBoundedResponse = async (response: Response): Promise<unknown> => {
  if (!response.ok || response.status !== 200) {
    throw new Error(`GitHub repository lookup failed with HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('GitHub repository response is too large.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('GitHub repository response is too large.');
  }
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
};

const parseStars = (value: unknown): number => {
  if (!isPlainRecord(value)) {
    throw new Error('GitHub repository response is invalid.');
  }
  const stars = value.stargazers_count;
  if (typeof stars !== 'number' || !Number.isSafeInteger(stars) || stars < 0 || stars > MAX_STARS) {
    throw new Error('GitHub repository stars are invalid.');
  }
  return stars;
};

const metadata = (
  identity: GitHubRepositoryIdentity,
  stars: number | null,
  provenance: ClaudePluginGitHubStarsProvenance,
): ClaudePluginGitHubMetadata =>
  Object.freeze({
    provenance,
    repositoryUri: identity.uri,
    stars,
  });

/**
 * Reads public GitHub repository star counts without credentials. Keys are normalized repository
 * identities, so alternate casing and supported URL spellings share one cache and one request.
 * Lookup failures are presentation-only and always resolve to stale or built-in metadata.
 */
export class GitHubRepositoryStarsService {
  private readonly builtInStars: ReadonlyMap<string, number | null>;
  private readonly cache = new Map<string, CachedRepositoryStars>();
  private readonly fetchImplementation: GitHubStarsFetch;
  private readonly inFlight = new Map<string, Promise<ClaudePluginGitHubMetadata>>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;

  public constructor(options: GitHubRepositoryStarsServiceOptions = {}) {
    this.builtInStars = safeBuiltInStars(options.builtInStars);
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  }

  public get(value: unknown): Promise<ClaudePluginGitHubMetadata | undefined> {
    const identity = safeNormalizeIdentity(value);
    if (!identity) {
      return Promise.resolve(undefined);
    }
    const key = identity.repositoryIdentity;
    const currentTime = this.now();
    const state = this.cache.get(key);
    if (state && currentTime - state.lastAttemptAt < this.ttlMs) {
      return Promise.resolve(this.cachedOrBuiltIn(identity, state));
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const request = this.fetchLive(identity)
      .then((stars) => {
        const successfulAt = this.now();
        this.cache.set(key, { lastAttemptAt: successfulAt, stars, successfulAt });
        return metadata(identity, stars, 'live');
      })
      .catch(() => {
        const attemptedAt = this.now();
        const previous = this.cache.get(key);
        this.cache.set(key, {
          lastAttemptAt: attemptedAt,
          ...(previous?.stars !== undefined ? { stars: previous.stars } : {}),
          ...(previous?.successfulAt !== undefined ? { successfulAt: previous.successfulAt } : {}),
        });
        return this.cachedOrBuiltIn(identity, this.cache.get(key)!);
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, request);
    return request;
  }

  /** Alias kept explicit for callers that want to name the operation rather than the cache lookup. */
  public getRepositoryMetadata(value: unknown): Promise<ClaudePluginGitHubMetadata | undefined> {
    return this.get(value);
  }

  private cachedOrBuiltIn(
    identity: GitHubRepositoryIdentity,
    state: CachedRepositoryStars,
  ): ClaudePluginGitHubMetadata {
    if (state.stars !== undefined) {
      return metadata(identity, state.stars, 'cached');
    }
    const builtIn = this.builtInStars.get(identity.repositoryIdentity) ?? null;
    return metadata(identity, builtIn, 'built-in');
  }

  private async fetchLive(identity: GitHubRepositoryIdentity): Promise<number> {
    const response = await this.fetchImplementation(
      `${GITHUB_REPOSITORY_API}/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repository)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ClaudeDock',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    return parseStars(await readBoundedResponse(response));
  }
}

export { GITHUB_REPOSITORY_API };
