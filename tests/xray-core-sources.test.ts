import { describe, expect, it } from 'vitest';
import {
  buildXrayCoreSources,
  DEFAULT_XRAY_CORE_MIRRORS,
  describeProbeFailure,
  isUrlAllowedBySource,
  normalizeMirrorHost,
  officialXrayCoreSource,
  parseDigestSha256,
  pickFastestSource,
  probeXrayCoreSources,
  sampleXrayCoreThroughput,
  type XrayCoreProbeResult,
  type XrayCoreRelease,
} from '../src/main/proxy/xray-core-sources';

const release: XrayCoreRelease = {
  bytes: 20_913_304,
  fileName: 'Xray-windows-64.zip',
  sha256: 'd004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad',
  version: 'v26.3.27',
};

const ASSET_PATH = '/XTLS/Xray-core/releases/download/v26.3.27/Xray-windows-64.zip';
const OFFICIAL_ASSET = `https://github.com${ASSET_PATH}`;

const digestBody = (sha256: string): string =>
  [
    'MD5= 5d41402abc4b2a76b9719d911017c592',
    'SHA1= aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    `SHA2-256= ${sha256}`,
    'SHA2-512= abcdef',
  ].join('\n');

const respond = (body: string, init: { status?: number; url?: string } = {}): Response =>
  Object.defineProperty(
    new Response(body, {
      headers: { 'content-length': String(Buffer.byteLength(body)) },
      status: init.status ?? 200,
    }),
    'url',
    { value: init.url ?? '' },
  );

/**
 * A body far larger than the sample window, wired so the test can see how much of it was actually
 * pulled — the point of the throughput stage is that it stops early rather than downloading 21 MB.
 */
const streamOf = (
  chunkBytes: number,
  chunkCount: number,
  url: string,
): { pulled: () => number; response: Response } => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return {
    pulled: () => pulled,
    response: Object.defineProperty(new Response(body), 'url', { value: url }),
  };
};

describe('Xray-core download sources', () => {
  it('builds prefix-proxy mirror URLs that survive URL normalization', () => {
    const sources = buildXrayCoreSources(release);
    const mirror = sources.find((source) => source.host === 'ghproxy.net');
    expect(mirror?.url).toBe(`https://ghproxy.net/${OFFICIAL_ASSET}`);
    expect(mirror?.digestUrl).toBe(`https://ghproxy.net/${OFFICIAL_ASSET}.dgst`);
    /*
     * `DownloadEngine` re-parses whatever it is handed and matches on the parsed value, so a URL
     * whose path contains an empty `https://` segment has to round-trip byte-for-byte or the
     * `will-download` event can never be claimed back by its task.
     */
    expect(new URL(mirror!.url).toString()).toBe(mirror!.url);
    expect(new URL(mirror!.url).hostname).toBe('ghproxy.net');
    expect(new URL(mirror!.url).pathname).toBe(`/${OFFICIAL_ASSET}`);
  });

  it('keeps the official host reachable directly and last in the built-in table', () => {
    const official = officialXrayCoreSource(release);
    expect(official.url).toBe(OFFICIAL_ASSET);
    expect(official.kind).toBe('official');
    const builtIn = buildXrayCoreSources(release);
    expect(builtIn.at(-1)?.id).toBe('official');
    expect(builtIn).toHaveLength(DEFAULT_XRAY_CORE_MIRRORS.length + 1);
  });

  it('pairs every allowed host with a path prefix, as DownloadEngine requires', () => {
    for (const source of buildXrayCoreSources(release, ['gh.example.com'])) {
      expect(source.allowedHosts).toHaveLength(source.allowedPathPrefixes.length);
      expect(source.allowedHosts.length).toBeGreaterThan(0);
    }
  });

  it('whitelists both the mirror itself and the GitHub origin it may redirect to', () => {
    const [mirror] = buildXrayCoreSources(release);
    expect(isUrlAllowedBySource(mirror!, mirror!.url)).toBe(true);
    expect(isUrlAllowedBySource(mirror!, OFFICIAL_ASSET)).toBe(true);
    expect(
      isUrlAllowedBySource(mirror!, `https://release-assets.githubusercontent.com/anything`),
    ).toBe(true);
    expect(isUrlAllowedBySource(mirror!, 'https://evil.example/payload.zip')).toBe(false);
    expect(isUrlAllowedBySource(mirror!, `http://github.com${ASSET_PATH}`)).toBe(false);
  });

  it('accepts user mirrors as bare hosts or pasted URLs and rejects unusable ones', () => {
    expect(normalizeMirrorHost('GH.Example.com')).toBe('gh.example.com');
    expect(normalizeMirrorHost('https://gh.example.com/whatever')).toBe('gh.example.com');
    // A port would build a source that can never match `url.hostname` in DownloadEngine.
    expect(normalizeMirrorHost('gh.example.com:8443')).toBeUndefined();
    expect(normalizeMirrorHost('localhost')).toBeUndefined();
    expect(normalizeMirrorHost('   ')).toBeUndefined();
    const custom = buildXrayCoreSources(release, ['https://gh.example.com/']).at(-1);
    expect(custom?.kind).toBe('custom');
    expect(custom?.url).toBe(`https://gh.example.com/${OFFICIAL_ASSET}`);
  });

  it('does not probe a user mirror that repeats a built-in host', () => {
    const sources = buildXrayCoreSources(release, ['ghproxy.net']);
    expect(sources.filter((source) => source.host === 'ghproxy.net')).toHaveLength(1);
  });

  it('reads the SHA2-256 line out of a .dgst file that has no filename column', () => {
    expect(parseDigestSha256(digestBody(release.sha256))).toBe(release.sha256);
    expect(parseDigestSha256('SHA2-512= abc\n')).toBeUndefined();
    expect(parseDigestSha256('<html>404</html>')).toBeUndefined();
  });

  it('passes a route only when its published digest matches the pinned release', async () => {
    const sources = buildXrayCoreSources(release).slice(0, 3);
    const results = await probeXrayCoreSources(sources, {
      fetchImpl: async (url) => {
        if (url.startsWith('https://gh.zwy.one/')) {
          return respond(digestBody(release.sha256), { url });
        }
        if (url.startsWith('https://ghproxy.net/')) {
          // Alive, but serving a different build — connectivity alone must not qualify it.
          return respond(digestBody('0'.repeat(64)), { url });
        }
        return respond('not found', { status: 404, url });
      },
      release,
      sampleThroughput: false,
    });
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['mirror:gh.zwy.one', 'ok'],
      ['mirror:ghproxy.net', 'failed'],
      ['mirror:gh.xxooo.cf', 'failed'],
    ]);
    expect(results[1]?.detail).toBe('校验值与固定版本不一致');
    expect(results[2]?.detail).toBe('HTTP 404');
  });

  it('marks a route blocked when it lands somewhere the download whitelist would refuse', async () => {
    const [mirror] = buildXrayCoreSources(release);
    const [result] = await probeXrayCoreSources([mirror!], {
      fetchImpl: async () =>
        respond(digestBody(release.sha256), { url: 'https://cdn.elsewhere.example/x.dgst' }),
      release,
      sampleThroughput: false,
    });
    expect(result?.status).toBe('blocked');
    expect(result?.detail).toContain('cdn.elsewhere.example');
  });

  it('samples the real archive with a bounded ranged read instead of the checksum file', async () => {
    const [mirror] = buildXrayCoreSources(release);
    const stream = streamOf(64 * 1024, 64, mirror!.url);
    let requested: { init?: RequestInit; url: string } | undefined;
    const bps = await sampleXrayCoreThroughput(mirror!, {
      fetchImpl: async (url, init) => {
        requested = { init, url };
        return stream.response;
      },
      release,
    });
    // The digest lives at a sibling URL; measuring it would say nothing about the 21 MB transfer.
    expect(requested?.url).toBe(mirror!.url);
    expect((requested?.init?.headers as Record<string, string>).range).toBe('bytes=0-262143');
    expect(bps).toBeGreaterThan(0);
    // A route that ignores `Range` streams the whole archive, so the reader has to stop on its own.
    expect(stream.pulled()).toBeLessThan(64);
  });

  it('refuses to measure a route that redirects out of its own whitelist', async () => {
    const [mirror] = buildXrayCoreSources(release);
    const stream = streamOf(64 * 1024, 8, 'https://cdn.elsewhere.example/Xray-windows-64.zip');
    expect(
      await sampleXrayCoreThroughput(mirror!, {
        fetchImpl: async () => stream.response,
        release,
      }),
    ).toBeUndefined();
  });

  it('samples every verified route so latency cannot hide a faster mirror', async () => {
    const sources = buildXrayCoreSources(release).slice(0, 6);
    const slowHosts = new Set([sources[4]!.host, sources[5]!.host]);
    const archiveRequests: string[] = [];
    const results = await probeXrayCoreSources(sources, {
      fetchImpl: async (url) => {
        if (url.endsWith('.dgst')) {
          if (slowHosts.has(new URL(url).hostname)) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return respond(digestBody(release.sha256), { url });
        }
        archiveRequests.push(url);
        return streamOf(64 * 1024, 8, url).response;
      },
      release,
    });
    expect(results.every((result) => result.status === 'ok')).toBe(true);
    expect(archiveRequests).toHaveLength(6);
    expect(results.filter((result) => result.throughputBps !== undefined)).toHaveLength(6);
  });

  it('picks the fastest verified route and nothing at all when every route fails', () => {
    const sources = buildXrayCoreSources(release).slice(0, 3);
    const results: XrayCoreProbeResult[] = [
      { id: sources[0]!.id, latencyMs: 900, status: 'ok' },
      { id: sources[1]!.id, latencyMs: 120, status: 'ok' },
      { id: sources[2]!.id, latencyMs: 10, status: 'failed' },
    ];
    expect(pickFastestSource(sources, results)?.id).toBe(sources[1]!.id);
    expect(
      pickFastestSource(
        sources,
        results.map((result) => ({ ...result, status: 'failed' as const })),
      ),
    ).toBeUndefined();
  });

  it('ranks a measured transfer rate above a low-latency trickle', () => {
    const sources = buildXrayCoreSources(release).slice(0, 3);
    /*
     * The shape that broke the first live run: the route that answered the 299-byte checksum fastest
     * delivered the archive at ~13 KB/s, so latency alone would have chosen a 25-minute download.
     */
    expect(
      pickFastestSource(sources, [
        { id: sources[0]!.id, latencyMs: 1_600, status: 'ok', throughputBps: 5_200_000 },
        { id: sources[1]!.id, latencyMs: 200, status: 'ok' },
        { id: sources[2]!.id, latencyMs: 90, status: 'ok', throughputBps: 13_000 },
      ])?.id,
    ).toBe(sources[0]!.id);
    // An unmeasured route still beats one measured to be slow only if nothing was measured at all.
    expect(
      pickFastestSource(sources, [
        { id: sources[1]!.id, latencyMs: 200, status: 'ok' },
        { id: sources[2]!.id, latencyMs: 90, status: 'ok', throughputBps: 13_000 },
      ])?.id,
    ).toBe(sources[2]!.id);
  });

  it('explains every route it tried and points at the manual escape hatch', () => {
    const sources = buildXrayCoreSources(release).slice(0, 2);
    const message = describeProbeFailure(sources, [
      { detail: '超时', id: sources[0]!.id, status: 'failed' },
      { detail: 'HTTP 502', id: sources[1]!.id, status: 'failed' },
    ]);
    expect(message).toContain(sources[0]!.label);
    expect(message).toContain('超时');
    expect(message).toContain('HTTP 502');
    expect(message).toContain('引导代理');
    expect(message).toContain('拖入');
  });
});
