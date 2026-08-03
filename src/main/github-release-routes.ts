export type GitHubReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubReleaseRoute {
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  host: string;
  label: string;
  throughputBps?: number;
  url: string;
}

const GITHUB_HOST = 'github.com';
const RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com';
const SAMPLE_BYTES = 128 * 1024;
const SAMPLE_TIMEOUT_MS = 4_000;

const isOfficialReleaseUrl = (url: URL): boolean =>
  url.protocol === 'https:' &&
  url.hostname === GITHUB_HOST &&
  /^\/[^/]+\/[^/]+\/releases\/download\//.test(url.pathname);

export const buildGitHubReleaseRoutes = (candidate: string): GitHubReleaseRoute[] => {
  const official = new URL(candidate);
  if (!isOfficialReleaseUrl(official)) {
    return [];
  }
  const officialPrefix = official.pathname.slice(0, official.pathname.lastIndexOf('/') + 1);
  return [
    {
      allowedHosts: [GITHUB_HOST, RELEASE_ASSET_HOST],
      allowedPathPrefixes: [officialPrefix, '/'],
      host: GITHUB_HOST,
      label: '官方直连 · github.com',
      url: official.toString(),
    },
  ];
};

const finalUrlAllowed = (route: GitHubReleaseRoute, candidate: string): boolean => {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      route.allowedHosts.some(
        (host, index) =>
          host === url.hostname && url.pathname.startsWith(route.allowedPathPrefixes[index] ?? ''),
      )
    );
  } catch {
    return false;
  }
};

export const sampleGitHubReleaseRoute = async (
  route: GitHubReleaseRoute,
  fetchImpl: GitHubReleaseFetch,
): Promise<GitHubReleaseRoute | undefined> => {
  const startedAt = Date.now();
  let received = 0;
  try {
    const response = await fetchImpl(route.url, {
      cache: 'no-store',
      headers: { range: `bytes=0-${SAMPLE_BYTES - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
    });
    if (!response.ok || !finalUrlAllowed(route, response.url || route.url)) {
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return undefined;
    }
    try {
      while (received < SAMPLE_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += chunk.value?.byteLength ?? 0;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    // Partial samples remain useful; completely silent routes are excluded below.
  }
  if (received === 0) {
    return undefined;
  }
  return {
    ...route,
    throughputBps: Math.round((received * 1_000) / Math.max(Date.now() - startedAt, 1)),
  };
};

/**
 * Uses the same Electron session as the real download. This keeps Windows/PAC proxy inheritance,
 * authentication and route selection identical between the speed test and the transfer.
 */
export const pickFastestGitHubReleaseRoute = async (
  candidate: string,
  fetchImpl: GitHubReleaseFetch,
): Promise<GitHubReleaseRoute | undefined> => {
  const routes = buildGitHubReleaseRoutes(candidate);
  const measured = (
    await Promise.all(routes.map((route) => sampleGitHubReleaseRoute(route, fetchImpl)))
  )
    .filter((route): route is GitHubReleaseRoute & { throughputBps: number } =>
      Boolean(route?.throughputBps),
    )
    .sort((left, right) => right.throughputBps - left.throughputBps);
  return measured[0];
};
