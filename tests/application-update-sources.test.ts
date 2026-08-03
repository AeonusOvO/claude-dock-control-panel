import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHINA_MIRROR_UPDATE_SOURCE,
  DEFAULT_GITHUB_UPDATE_SOURCE,
  isApplicationUpdateRequestAllowed,
  loadApplicationUpdateSources,
  selectApplicationUpdateSource,
  type ApplicationUpdateFetch,
} from '../src/main/application-update-sources';
import {
  CHINA_MIRROR_BASE_URL,
  GITHUB_RELEASE_ROOT,
  RELEASE_MANIFEST_KEY_ID,
  RELEASE_SAMPLE_BYTES,
} from '../src/main/application-update-manifest';

const directories: string[] = [];
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const sha512 = (value: Uint8Array): string => createHash('sha512').update(value).digest('base64');

const createDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-update-sources-'));
  directories.push(directory);
  return directory;
};

interface ReleaseFixture {
  blockmap: Uint8Array;
  installer: Uint8Array;
  latest: Uint8Array;
  manifest: Uint8Array;
  signature: Uint8Array;
  version: string;
}

const releaseFixture = (version = '4.1.0', byte = 7): ReleaseFixture => {
  const installer = new Uint8Array(RELEASE_SAMPLE_BYTES + 1024).fill(byte);
  const installerName = 'ClaudeDock-Setup-' + version + '-x64.exe';
  const latest = new TextEncoder().encode(
    ['version: ' + version, 'path: ' + installerName, 'sha512: ' + sha512(installer), ''].join(
      '\n',
    ),
  );
  const blockmap = new Uint8Array([1, 2, 3, byte]);
  const manifest = new TextEncoder().encode(
    JSON.stringify(
      {
        channel: 'stable',
        files: [
          {
            name: installerName,
            sampleSha512: sha512(installer.slice(0, RELEASE_SAMPLE_BYTES)),
            sampleSize: RELEASE_SAMPLE_BYTES,
            sha512: sha512(installer),
            size: installer.byteLength,
          },
          {
            name: installerName + '.blockmap',
            sha512: sha512(blockmap),
            size: blockmap.byteLength,
          },
          {
            name: 'latest.yml',
            sha512: sha512(latest),
            size: latest.byteLength,
          },
        ],
        keyId: RELEASE_MANIFEST_KEY_ID,
        publishedAt: '2026-08-03T12:00:00.000Z',
        schemaVersion: 1,
        sources: {
          github: GITHUB_RELEASE_ROOT + 'v' + version + '/',
          mirror: CHINA_MIRROR_BASE_URL,
        },
        version,
      },
      null,
      2,
    ) + '\n',
  );
  const signature = new TextEncoder().encode(
    sign(null, manifest, keyPair.privateKey).toString('base64') + '\n',
  );
  return { blockmap, installer, latest, manifest, signature, version };
};

const responseWithUrl = (
  body: BodyInit | Uint8Array | null,
  url: string,
  status = 200,
  headers?: HeadersInit,
): Response => {
  const responseBody = body instanceof Uint8Array ? (body.slice().buffer as ArrayBuffer) : body;
  const response = new Response(responseBody, { headers, status });
  Object.defineProperty(response, 'url', { configurable: true, value: url });
  return response;
};

const releaseResponse = (
  url: string,
  fixture: ReleaseFixture,
  delayMs = 0,
  validRange = true,
): Response => {
  if (url.endsWith('release-manifest.json')) {
    return responseWithUrl(fixture.manifest, url, 200, {
      'content-length': fixture.manifest.byteLength.toString(),
    });
  }
  if (url.endsWith('release-manifest.sig')) {
    return responseWithUrl(fixture.signature, url, 200, {
      'content-length': fixture.signature.byteLength.toString(),
    });
  }
  if (url.endsWith('latest.yml')) {
    return responseWithUrl(fixture.latest, url, 200, {
      'content-length': fixture.latest.byteLength.toString(),
    });
  }
  const sample = fixture.installer.slice(0, RELEASE_SAMPLE_BYTES);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(sample);
        controller.close();
      }, delayMs);
    },
  });
  return responseWithUrl(body, url, 206, {
    'content-length': sample.byteLength.toString(),
    'content-range': validRange
      ? 'bytes 0-' +
        (sample.byteLength - 1).toString() +
        '/' +
        fixture.installer.byteLength.toString()
      : 'bytes 1-' + sample.byteLength.toString() + '/' + fixture.installer.byteLength.toString(),
  });
};

const selectOptions = (highestTrustedVersion?: string) => ({
  currentVersion: '4.0.0',
  highestTrustedVersion,
  publicKeyPem,
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('application update source configuration', () => {
  it('rejects HTTP, query strings and unauthorized IP mirrors', () => {
    const filePath = path.join(createDirectory(), 'update-sources.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        sources: [
          DEFAULT_GITHUB_UPDATE_SOURCE,
          {
            allowedHosts: ['203.0.113.5'],
            baseUrl: 'https://203.0.113.5/claudedock/?channel=stable',
            id: 'mirror',
            label: 'unsafe',
            provider: 'generic',
          },
        ],
        version: 2,
      }),
    );

    expect(loadApplicationUpdateSources(filePath)).toEqual([
      DEFAULT_GITHUB_UPDATE_SOURCE,
      DEFAULT_CHINA_MIRROR_UPDATE_SOURCE,
    ]);
  });

  it('selects the faster mirror after both channels independently verify the same manifest', async () => {
    const fixture = releaseFixture();
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) =>
      releaseResponse(url, fixture, url.includes('124.221.158.247') ? 1 : 30),
    );

    const selected = await selectApplicationUpdateSource(
      [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
      fetchMock,
      selectOptions(),
    );

    expect(selected).toMatchObject({
      feed: { provider: 'generic', url: CHINA_MIRROR_BASE_URL },
      id: 'mirror',
      label: '中国大陆 HTTPS 兜底镜像',
      releaseVersion: '4.1.0',
    });
    expect(selected.throughputBps).toBeGreaterThan(0);
  });

  it('uses the signed mirror when GitHub is unavailable', async () => {
    const fixture = releaseFixture();
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) =>
      url.includes('github.com')
        ? responseWithUrl('unavailable', url, 503, { 'content-length': '11' })
        : releaseResponse(url, fixture, 1),
    );

    await expect(
      selectApplicationUpdateSource(
        [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
        fetchMock,
        selectOptions(),
      ),
    ).resolves.toMatchObject({
      id: 'mirror',
      releaseVersion: '4.1.0',
    });
  });

  it('rejects a mirror with a tampered manifest and keeps the valid GitHub source', async () => {
    const fixture = releaseFixture();
    const tampered = {
      ...fixture,
      manifest: new Uint8Array(fixture.manifest).fill(32, 1, 2),
    };
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) =>
      releaseResponse(url, url.includes('124.221.158.247') ? tampered : fixture, 1),
    );

    await expect(
      selectApplicationUpdateSource(
        [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
        fetchMock,
        selectOptions(),
      ),
    ).resolves.toMatchObject({ id: 'github' });
  });

  it('fails closed when two valid channels expose different signed manifests', async () => {
    const githubFixture = releaseFixture('4.2.0', 8);
    const mirrorFixture = releaseFixture('4.1.0', 7);
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) =>
      releaseResponse(url, url.includes('124.221.158.247') ? mirrorFixture : githubFixture, 1),
    );

    await expect(
      selectApplicationUpdateSource(
        [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
        fetchMock,
        selectOptions(),
      ),
    ).rejects.toThrow('签名发布清单不一致');
  });

  it('does not trust a fast partial response with a forged Content-Range', async () => {
    const fixture = releaseFixture();
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) =>
      releaseResponse(
        url,
        fixture,
        url.includes('124.221.158.247') ? 1 : 20,
        !url.includes('124.221.158.247'),
      ),
    );

    await expect(
      selectApplicationUpdateSource(
        [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
        fetchMock,
        selectOptions(),
      ),
    ).resolves.toMatchObject({ id: 'github' });
  });

  it('rejects cross-host redirects from the exact-IP mirror', async () => {
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) => {
      if (url.includes('github.com')) {
        return responseWithUrl('unavailable', url, 503, { 'content-length': '11' });
      }
      return responseWithUrl(null, url, 302, { location: 'https://example.com/release.json' });
    });

    await expect(
      selectApplicationUpdateSource(
        [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
        fetchMock,
        selectOptions(),
      ),
    ).rejects.toThrow('超出固定更新主机范围');
  });

  it('rejects an unlimited same-host redirect chain', async () => {
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) => {
      if (url.includes('github.com')) {
        return responseWithUrl('unavailable', url, 503, { 'content-length': '11' });
      }
      return responseWithUrl(null, url, 308, { location: url });
    });

    await expect(
      selectApplicationUpdateSource(
        [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
        fetchMock,
        selectOptions(),
      ),
    ).rejects.toThrow('重定向次数超过安全上限');
  });

  it('rejects a signed release below the persisted trusted version floor', async () => {
    const fixture = releaseFixture('4.1.0');
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) =>
      releaseResponse(url, fixture, 1),
    );

    await expect(
      selectApplicationUpdateSource(
        [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
        fetchMock,
        selectOptions('4.2.0'),
      ),
    ).rejects.toThrow('已验证版本 4.2.0');
  });

  it('allows only the selected fixed host set during electron-updater downloads', async () => {
    const fixture = releaseFixture();
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) =>
      releaseResponse(url, fixture, url.includes('124.221.158.247') ? 1 : 20),
    );
    const selected = await selectApplicationUpdateSource(
      [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE],
      fetchMock,
      selectOptions(),
    );

    expect(
      isApplicationUpdateRequestAllowed(
        selected,
        CHINA_MIRROR_BASE_URL + selected.expectedInstaller.name,
      ),
    ).toBe(true);
    expect(
      isApplicationUpdateRequestAllowed(
        selected,
        CHINA_MIRROR_BASE_URL + selected.expectedInstaller.name + '?bypass=1',
      ),
    ).toBe(false);
    expect(
      isApplicationUpdateRequestAllowed(
        selected,
        'https://124.221.158.248/claudedock/windows/x64/' + selected.expectedInstaller.name,
      ),
    ).toBe(false);
  });
});
