import { readFileSync } from 'node:fs';
import { compareSemanticVersions } from '../shared/provider-profiles';

export type ApplicationUpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApplicationUpdateSource {
  allowedHosts: string[];
  baseUrl?: string;
  id: string;
  label: string;
  owner?: string;
  provider: 'generic' | 'github';
  repo?: string;
}

export interface ApplicationUpdateSourceSelection {
  feed: Record<string, unknown>;
  id: string;
  label: string;
  throughputBps?: number;
}

interface UpdateMetadata {
  artifactPath: string;
  sha512: string;
  version: string;
}

interface StoredSourceConfiguration {
  sources?: unknown;
  version?: unknown;
}

const METADATA_LIMIT_BYTES = 64 * 1024;
const SAMPLE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 6_000;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export const DEFAULT_GITHUB_UPDATE_SOURCE: ApplicationUpdateSource = {
  allowedHosts: [
    'github.com',
    'api.github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ],
  id: 'github',
  label: 'GitHub 官方发布',
  owner: 'AeonusOvO',
  provider: 'github',
  repo: 'claude-dock-control-panel',
};

const safeHttpsBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url.toString();
  } catch {
    return undefined;
  }
};

const safeHostList = (value: unknown, primaryHost: string): string[] => {
  const candidates = Array.isArray(value) ? value : [];
  return [
    ...new Set([
      primaryHost,
      ...candidates.filter(
        (entry): entry is string =>
          typeof entry === 'string' &&
          /^[a-z0-9.-]{1,253}$/i.test(entry) &&
          !entry.startsWith('.') &&
          !entry.endsWith('.'),
      ),
    ]),
  ];
};

const parseSource = (value: unknown): ApplicationUpdateSource | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !SOURCE_ID_PATTERN.test(record.id) ||
    typeof record.label !== 'string' ||
    !record.label.trim() ||
    record.label.length > 80
  ) {
    return undefined;
  }
  if (record.provider === 'github') {
    if (
      typeof record.owner !== 'string' ||
      !REPOSITORY_PART_PATTERN.test(record.owner) ||
      typeof record.repo !== 'string' ||
      !REPOSITORY_PART_PATTERN.test(record.repo)
    ) {
      return undefined;
    }
    return {
      allowedHosts: DEFAULT_GITHUB_UPDATE_SOURCE.allowedHosts,
      id: record.id,
      label: record.label.trim(),
      owner: record.owner,
      provider: 'github',
      repo: record.repo,
    };
  }
  if (record.provider !== 'generic') return undefined;
  const baseUrl = safeHttpsBaseUrl(record.baseUrl);
  if (!baseUrl) return undefined;
  const host = new URL(baseUrl).hostname;
  return {
    allowedHosts: safeHostList(record.allowedHosts, host),
    baseUrl,
    id: record.id,
    label: record.label.trim(),
    provider: 'generic',
  };
};

export const loadApplicationUpdateSources = (filePath: string): ApplicationUpdateSource[] => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as StoredSourceConfiguration;
    if (parsed.version !== 1 || !Array.isArray(parsed.sources)) {
      return [DEFAULT_GITHUB_UPDATE_SOURCE];
    }
    const sources = parsed.sources
      .map(parseSource)
      .filter((source): source is ApplicationUpdateSource => Boolean(source));
    const github = sources.find((source) => source.provider === 'github');
    if (!github) return [DEFAULT_GITHUB_UPDATE_SOURCE];
    return [github, ...sources.filter((source) => source !== github)];
  } catch {
    return [DEFAULT_GITHUB_UPDATE_SOURCE];
  }
};

const metadataUrl = (source: ApplicationUpdateSource): string =>
  source.provider === 'github'
    ? `https://github.com/${source.owner}/${source.repo}/releases/latest/download/latest.yml`
    : new URL('latest.yml', source.baseUrl).toString();

const artifactUrl = (source: ApplicationUpdateSource, artifactPath: string): string =>
  source.provider === 'github'
    ? `https://github.com/${source.owner}/${source.repo}/releases/latest/download/${encodeURIComponent(artifactPath)}`
    : new URL(artifactPath, source.baseUrl).toString();

const parseMetadata = (text: string): UpdateMetadata | undefined => {
  const version = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(text)?.[1];
  const artifactPath = /^path:\s*['"]?([^\r\n'"]+)['"]?\s*$/m.exec(text)?.[1]?.trim();
  const sha512 = /^sha512:\s*([A-Za-z0-9+/=]{40,})\s*$/m.exec(text)?.[1];
  if (
    !version ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ||
    !artifactPath ||
    artifactPath.startsWith('/') ||
    artifactPath.includes('..') ||
    artifactPath.includes('\\') ||
    !sha512
  ) {
    return undefined;
  }
  return { artifactPath, sha512, version };
};

const responseUrlAllowed = (source: ApplicationUpdateSource, responseUrl: string): boolean => {
  try {
    const url = new URL(responseUrl);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      source.allowedHosts.includes(url.hostname)
    );
  } catch {
    return false;
  }
};

const readMetadata = async (
  source: ApplicationUpdateSource,
  fetchImpl: ApplicationUpdateFetch,
): Promise<UpdateMetadata | undefined> => {
  try {
    const response = await fetchImpl(metadataUrl(source), {
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || !responseUrlAllowed(source, response.url || metadataUrl(source))) {
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (length <= METADATA_LIMIT_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value) {
          chunks.push(chunk.value);
          length += chunk.value.byteLength;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (length === 0 || length > METADATA_LIMIT_BYTES) return undefined;
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseMetadata(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
};

const sampleArtifact = async (
  source: ApplicationUpdateSource,
  metadata: UpdateMetadata,
  fetchImpl: ApplicationUpdateFetch,
): Promise<number | undefined> => {
  const url = artifactUrl(source, metadata.artifactPath);
  const startedAt = Date.now();
  let received = 0;
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { range: `bytes=0-${SAMPLE_BYTES - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || !responseUrlAllowed(source, response.url || url)) return undefined;
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    try {
      while (received < SAMPLE_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value?.byteLength ?? 0;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    // A timed-out partial sample still measures a slow-but-working route.
  }
  return received > 0
    ? Math.round((received * 1_000) / Math.max(Date.now() - startedAt, 1))
    : undefined;
};

const feedFor = (source: ApplicationUpdateSource): Record<string, unknown> =>
  source.provider === 'github'
    ? {
        owner: source.owner,
        provider: 'github',
        releaseType: 'release',
        repo: source.repo,
      }
    : { provider: 'generic', url: source.baseUrl };

/**
 * GitHub's `latest.yml` is the trust anchor. A mirror is eligible only when its version, artifact
 * path and SHA-512 exactly match GitHub; this lets a fast domestic server carry the large installer
 * without allowing it to announce a different binary. If that small canonical file cannot be
 * verified, selection fails closed to the ordinary GitHub updater configuration.
 */
export const selectApplicationUpdateSource = async (
  sources: ApplicationUpdateSource[],
  fetchImpl: ApplicationUpdateFetch,
): Promise<ApplicationUpdateSourceSelection> => {
  const github =
    sources.find((source) => source.provider === 'github') ?? DEFAULT_GITHUB_UPDATE_SOURCE;
  const fallback: ApplicationUpdateSourceSelection = {
    feed: feedFor(github),
    id: github.id,
    label: github.label,
  };
  const canonical = await readMetadata(github, fetchImpl);
  if (!canonical) return fallback;

  const metadataEntries = await Promise.all(
    sources.map(async (source) => ({ metadata: await readMetadata(source, fetchImpl), source })),
  );
  const highestVersion = metadataEntries
    .flatMap(({ metadata }) => (metadata ? [metadata.version] : []))
    .sort((left, right) => compareSemanticVersions(right, left))[0];
  if (!highestVersion || compareSemanticVersions(canonical.version, highestVersion) < 0) {
    return fallback;
  }
  const eligible = metadataEntries.filter(({ metadata, source }) => {
    if (!metadata) return false;
    if (source.provider === 'github') return true;
    return (
      metadata.version === canonical.version &&
      metadata.artifactPath === canonical.artifactPath &&
      metadata.sha512 === canonical.sha512
    );
  });
  const measured = (
    await Promise.all(
      eligible.map(async ({ metadata, source }) => ({
        source,
        throughputBps: await sampleArtifact(source, metadata!, fetchImpl),
      })),
    )
  )
    .filter(
      (entry): entry is { source: ApplicationUpdateSource; throughputBps: number } =>
        typeof entry.throughputBps === 'number',
    )
    .sort((left, right) => right.throughputBps - left.throughputBps);
  const selected = measured[0];
  return selected
    ? {
        feed: feedFor(selected.source),
        id: selected.source.id,
        label: selected.source.label,
        throughputBps: selected.throughputBps,
      }
    : fallback;
};
