/**
 * Where the Xray-core archive can be fetched from, and how to find out which of those routes is
 * actually usable right now.
 *
 * The built-in proxy has a bootstrap problem: the kernel has to be downloaded before the tunnel can
 * run, but the only source used to be GitHub's release CDN, which is exactly what many users need
 * the tunnel for. A single unreachable host therefore made the whole feature unusable with no way
 * out. Every route below is a *prefix reverse proxy* — the complete GitHub URL, `https://` and all,
 * is appended to the mirror's origin — so the same pinned asset is served through a different
 * network path.
 *
 * Trust never moves to the mirror: the archive is still verified against `XRAY_CORE_RELEASE.sha256`
 * by `DownloadEngine`, and the probe below rejects any route whose published digest disagrees with
 * that constant. Mirrors only change how the bytes travel, never which bytes are accepted.
 */

export interface XrayCoreRelease {
  bytes: number;
  fileName: string;
  sha256: string;
  version: string;
}

export interface XrayCoreSource {
  /** Paired index-for-index with `allowedPathPrefixes`, as `DownloadEngine` requires. */
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  /** Sibling `.dgst` checksum file used for probing; see `probeXrayCoreSource`. */
  digestUrl: string;
  host: string;
  id: string;
  kind: 'custom' | 'mirror' | 'official';
  label: string;
  url: string;
}

export type XrayCoreProbeStatus = 'blocked' | 'failed' | 'ok';

export interface XrayCoreProbeResult {
  /** Human-readable Chinese reason, shown verbatim in the panel. */
  detail?: string;
  id: string;
  latencyMs?: number;
  status: XrayCoreProbeStatus;
  /** Measured bytes/second over a short sample of the real archive; see `sampleXrayCoreThroughput`. */
  throughputBps?: number;
}

export type XrayCoreFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface XrayCoreProbeOptions {
  fetchImpl: XrayCoreFetch;
  release: XrayCoreRelease;
  /** Off only for tests that exercise the digest stage in isolation. */
  sampleThroughput?: boolean;
  throughputTimeoutMs?: number;
  timeoutMs?: number;
}

const OFFICIAL_HOST = 'github.com';
const OFFICIAL_ASSET_HOST = 'release-assets.githubusercontent.com';
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/**
 * A 299-byte `.dgst` answers "is this route alive and serving the right build", but it says nothing
 * about throughput: the first live run of this table picked the route with the lowest time-to-first-
 * byte and then took twenty minutes to pull 21 MB through it at ~13 KB/s. So the routes that pass
 * the digest check are sampled against the real archive before one is chosen.
 *
 * 256 KiB separates a trickle from a usable route, and sampling only the four best-latency routes
 * keeps the whole probe under a megabyte — small enough to run every time the panel asks.
 */
const THROUGHPUT_SAMPLE_BYTES = 256 * 1024;
const THROUGHPUT_TIMEOUT_MS = 3_000;
const THROUGHPUT_SAMPLE_LIMIT = 4;

/**
 * The `.dgst` file is 299 bytes. Anything materially larger is a captive-portal page or an error
 * document rather than a checksum, and reading it in full would let a hostile route stream forever.
 */
const MAX_DIGEST_BYTES = 4_096;

/**
 * Ordered by mainland-China reachability, official direct last. The last entry is not a fallback of
 * last resort so much as the best route for anyone who already has working connectivity — the probe
 * picks whichever is fastest, so a user with a proxy still ends up on GitHub itself.
 *
 * Treat this as a factory default, not a fixed truth: roughly half of the mirror domains published
 * in any given year are dead within two, which is why `buildXrayCoreSources` also accepts
 * user-supplied hosts.
 */
export const DEFAULT_XRAY_CORE_MIRRORS: readonly { host: string; label: string }[] = Object.freeze([
  { host: 'gh.zwy.one', label: '镜像 · gh.zwy.one' },
  { host: 'ghproxy.net', label: '镜像 · ghproxy.net（支持断点续传）' },
  { host: 'gh.xxooo.cf', label: '镜像 · gh.xxooo.cf' },
  { host: 'ghproxy.cxkpro.top', label: '镜像 · ghproxy.cxkpro.top' },
  { host: 'ghfast.top', label: '镜像 · ghfast.top' },
  { host: 'gh-proxy.com', label: '镜像 · gh-proxy.com' },
  { host: 'ghfile.geekertao.top', label: '镜像 · ghfile.geekertao.top' },
  { host: 'gh.ddlc.top', label: '镜像 · gh.ddlc.top' },
]);

const officialAssetPath = (release: XrayCoreRelease): string =>
  `/XTLS/Xray-core/releases/download/${release.version}/`;

const officialAssetUrl = (release: XrayCoreRelease): string =>
  `https://${OFFICIAL_HOST}${officialAssetPath(release)}${release.fileName}`;

/**
 * Accepts a bare hostname or a pasted URL and returns the hostname, or `undefined` when the value
 * cannot be one. A port is rejected deliberately: `DownloadEngine` matches `url.hostname`, so a
 * host:port entry would build a source that can never pass its own whitelist.
 */
export const normalizeMirrorHost = (candidate: string): string | undefined => {
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253) {
    return undefined;
  }
  const withoutScheme = trimmed.replace(/^https?:\/\//, '');
  const host = withoutScheme.split('/')[0] ?? '';
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
    ? host
    : undefined;
};

const mirrorSource = (
  host: string,
  label: string,
  kind: 'custom' | 'mirror',
  release: XrayCoreRelease,
): XrayCoreSource => {
  const target = officialAssetUrl(release);
  return {
    /*
     * The mirror host comes first, but the two GitHub hosts stay on the list: some prefix proxies
     * stream the asset themselves (a plain 200) while others answer with a 302 back to the origin,
     * and `DownloadEngine` validates every hop of the redirect chain.
     */
    allowedHosts: [host, OFFICIAL_HOST, OFFICIAL_ASSET_HOST],
    allowedPathPrefixes: [
      `/https://${OFFICIAL_HOST}${officialAssetPath(release)}`,
      officialAssetPath(release),
      '/',
    ],
    digestUrl: `https://${host}/${target}.dgst`,
    host,
    id: `mirror:${host}`,
    kind,
    label,
    url: `https://${host}/${target}`,
  };
};

export const officialXrayCoreSource = (release: XrayCoreRelease): XrayCoreSource => ({
  allowedHosts: [OFFICIAL_HOST, OFFICIAL_ASSET_HOST],
  allowedPathPrefixes: [officialAssetPath(release), '/'],
  digestUrl: `${officialAssetUrl(release)}.dgst`,
  host: OFFICIAL_HOST,
  id: 'official',
  kind: 'official',
  label: '官方直连 · github.com',
  url: officialAssetUrl(release),
});

/**
 * Factory defaults plus any hosts the user added, de-duplicated by host so a custom entry that
 * repeats a built-in one does not get probed twice.
 */
export const buildXrayCoreSources = (
  release: XrayCoreRelease,
  extraHosts: readonly string[] = [],
): XrayCoreSource[] => {
  const sources: XrayCoreSource[] = [];
  const seen = new Set<string>();
  const push = (source: XrayCoreSource): void => {
    if (!seen.has(source.host)) {
      seen.add(source.host);
      sources.push(source);
    }
  };
  for (const mirror of DEFAULT_XRAY_CORE_MIRRORS) {
    push(mirrorSource(mirror.host, mirror.label, 'mirror', release));
  }
  push(officialXrayCoreSource(release));
  for (const candidate of extraHosts) {
    const host = normalizeMirrorHost(candidate);
    if (host) {
      push(mirrorSource(host, `自定义 · ${host}`, 'custom', release));
    }
  }
  return sources;
};

/**
 * Xray publishes `<asset>.dgst` next to each archive: four `ALGO= hex` lines with no filename
 * column, so the digest has to be picked out by algorithm name rather than by splitting columns.
 */
export const parseDigestSha256 = (body: string): string | undefined =>
  /^SHA2-256=\s*([0-9a-f]{64})\s*$/im.exec(body)?.[1]?.toLowerCase();

export const isUrlAllowedBySource = (source: XrayCoreSource, candidate: string): boolean => {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      source.allowedHosts.some(
        (host, index) =>
          host === url.hostname && url.pathname.startsWith(source.allowedPathPrefixes[index] ?? ''),
      )
    );
  } catch {
    return false;
  }
};

/**
 * One request settles four questions at once: does the host resolve, does it connect, does it
 * follow the redirect through to real content, and is that content the release we pinned. `HEAD` is
 * deliberately not used — several of these mirrors are Cloudflare Workers that serve `HEAD` from
 * cache or refuse it outright, so a passing `HEAD` would not prove the `GET` will work.
 *
 * The digest the mirror returns is never trusted as *the* checksum; it is only compared against the
 * constant compiled into the app. A route that answers with a different digest is out, whether it
 * is stale, broken, or hostile.
 */
export const probeXrayCoreSource = async (
  source: XrayCoreSource,
  options: XrayCoreProbeOptions,
): Promise<XrayCoreProbeResult> => {
  const startedAt = Date.now();
  try {
    const response = await options.fetchImpl(source.digestUrl, {
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { detail: `HTTP ${response.status}`, id: source.id, latencyMs, status: 'failed' };
    }
    const finalUrl = response.url || source.digestUrl;
    if (!isUrlAllowedBySource(source, finalUrl)) {
      return {
        detail: `最终跳转到 ${new URL(finalUrl).hostname}，不在该来源的下载白名单内`,
        id: source.id,
        latencyMs,
        status: 'blocked',
      };
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_DIGEST_BYTES) {
      return { detail: '返回的不是校验文件', id: source.id, latencyMs, status: 'failed' };
    }
    const body = (await response.text()).slice(0, MAX_DIGEST_BYTES);
    const digest = parseDigestSha256(body);
    if (!digest) {
      return { detail: '返回内容不是校验文件', id: source.id, latencyMs, status: 'failed' };
    }
    if (digest !== options.release.sha256.toLowerCase()) {
      return { detail: '校验值与固定版本不一致', id: source.id, latencyMs, status: 'failed' };
    }
    return { id: source.id, latencyMs, status: 'ok' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '无法连接';
    return {
      detail: /abort|timeout/i.test(reason) ? '超时' : reason,
      id: source.id,
      status: 'failed',
    };
  }
};

/**
 * How fast this route actually moves the archive, in bytes/second, or `undefined` when it could not
 * be measured. The sample is a ranged read of the real asset — the same URL and the same whitelist
 * the download will use — so a mirror that serves the `.dgst` from cache but stalls on the archive
 * is caught here rather than twenty minutes into a download.
 *
 * A route that times out mid-stream is still measured from whatever it delivered: "slow" is a useful
 * answer, and discarding it would rank a trickle alongside a route that never answered at all.
 */
export const sampleXrayCoreThroughput = async (
  source: XrayCoreSource,
  options: XrayCoreProbeOptions,
): Promise<number | undefined> => {
  const startedAt = Date.now();
  let received = 0;
  try {
    const response = await options.fetchImpl(source.url, {
      cache: 'no-store',
      headers: { range: `bytes=0-${THROUGHPUT_SAMPLE_BYTES - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.throughputTimeoutMs ?? THROUGHPUT_TIMEOUT_MS),
    });
    if (!response.ok || !isUrlAllowedBySource(source, response.url || source.url)) {
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return undefined;
    }
    try {
      while (received < THROUGHPUT_SAMPLE_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += chunk.value?.byteLength ?? 0;
      }
    } finally {
      // A route that ignores `Range` is streaming all 21 MB; cancelling is what bounds the cost.
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    // Fall through: `received` may still hold a usable sample from before the abort.
  }
  // Clamped rather than guarded: a sample that lands inside one clock tick is very fast, not invalid.
  const elapsedMs = Math.max(Date.now() - startedAt, 1);
  return received > 0 ? Math.round((received * 1_000) / elapsedMs) : undefined;
};

/**
 * Two stages: every route is checked for liveness and integrity, then the most promising survivors
 * are raced on the real archive. Both stages run concurrently within themselves; the second is
 * skipped entirely when nothing passed the first.
 */
export const probeXrayCoreSources = async (
  sources: readonly XrayCoreSource[],
  options: XrayCoreProbeOptions,
): Promise<XrayCoreProbeResult[]> => {
  const results = await Promise.all(sources.map((source) => probeXrayCoreSource(source, options)));
  if (options.sampleThroughput === false) {
    return results;
  }
  const sampled = new Set(
    results
      .filter((result) => result.status === 'ok')
      .sort(
        (first, second) =>
          (first.latencyMs ?? Number.MAX_SAFE_INTEGER) -
          (second.latencyMs ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, THROUGHPUT_SAMPLE_LIMIT)
      .map((result) => result.id),
  );
  const byId = new Map(sources.map((source) => [source.id, source]));
  const throughputs = await Promise.all(
    [...sampled].map(async (id) => {
      const source = byId.get(id);
      return [id, source ? await sampleXrayCoreThroughput(source, options) : undefined] as const;
    }),
  );
  const throughputById = new Map(throughputs);
  return results.map((result) =>
    sampled.has(result.id) ? { ...result, throughputBps: throughputById.get(result.id) } : result,
  );
};

/**
 * A measured route always beats an unmeasured one, and among measured routes the fastest transfer
 * wins — not the lowest latency, which is what a `.dgst` round trip alone would tell us. Unmeasured
 * routes fall back to latency, and ties fall back to table order, which is why the list above is
 * kept in reachability order rather than alphabetically.
 */
export const pickFastestSource = (
  sources: readonly XrayCoreSource[],
  results: readonly XrayCoreProbeResult[],
): XrayCoreSource | undefined => {
  const usable = new Map(
    results.filter((result) => result.status === 'ok').map((result) => [result.id, result]),
  );
  // Higher is better, so latency is negated: any measured throughput outranks every unmeasured route.
  const rank = (id: string): number => {
    const result = usable.get(id);
    return result?.throughputBps ?? -(result?.latencyMs ?? Number.MAX_SAFE_INTEGER);
  };
  return sources
    .filter((source) => usable.has(source.id))
    .reduce<XrayCoreSource | undefined>(
      (best, source) => (!best || rank(source.id) > rank(best.id) ? source : best),
      undefined,
    );
};

/**
 * Turned into the error the user sees when nothing is reachable. Listing what was tried and why it
 * failed is the difference between an actionable message and 「下载失败」, and the last line points
 * at the escape hatch that always works: download it by hand and drop it into the panel.
 */
export const describeProbeFailure = (
  sources: readonly XrayCoreSource[],
  results: readonly XrayCoreProbeResult[],
): string => {
  const byId = new Map(results.map((result) => [result.id, result]));
  const lines = sources.map((source) => {
    const result = byId.get(source.id);
    return `· ${source.label}：${result?.detail ?? '不可达'}`;
  });
  return [
    '所有 Xray-core 下载线路都不可用，已停止重试。',
    ...lines,
    '可在代理设置里填写「内核下载引导代理」，或手动下载内核后拖入面板的内核安装区。',
  ].join('\n');
};
