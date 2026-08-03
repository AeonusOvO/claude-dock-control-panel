import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GITHUB_UPDATE_SOURCE,
  loadApplicationUpdateSources,
  selectApplicationUpdateSource,
  type ApplicationUpdateFetch,
  type ApplicationUpdateSource,
} from '../src/main/application-update-sources';

const directories: string[] = [];
const createDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-update-sources-'));
  directories.push(directory);
  return directory;
};
const metadata = (sha512 = 'A'.repeat(88)): string =>
  `version: 4.0.0\npath: ClaudeDock-Setup-4.0.0-x64.exe\nsha512: ${sha512}\n`;
const responseWithUrl = (body: BodyInit, url: string, status = 200): Response => {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { configurable: true, value: url });
  return response;
};
const artifactResponse = (url: string, delayMs: number): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new Uint8Array(256 * 1024));
        controller.close();
      }, delayMs);
    },
  });
  return responseWithUrl(body, url, 206);
};
const mirror: ApplicationUpdateSource = {
  allowedHosts: ['updates.example.com'],
  baseUrl: 'https://updates.example.com/claudedock/',
  id: 'china',
  label: '中国大陆更新镜像',
  provider: 'generic',
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('application update source configuration', () => {
  it('rejects an HTTP mirror and retains the trusted GitHub source', () => {
    const filePath = path.join(createDirectory(), 'update-sources.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        sources: [
          DEFAULT_GITHUB_UPDATE_SOURCE,
          { id: 'unsafe', label: 'unsafe', provider: 'generic', baseUrl: 'http://127.0.0.1/' },
        ],
        version: 1,
      }),
    );

    expect(loadApplicationUpdateSources(filePath)).toEqual([DEFAULT_GITHUB_UPDATE_SOURCE]);
  });

  it('selects the faster HTTPS mirror only after exact GitHub metadata verification', async () => {
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) => {
      if (url.endsWith('latest.yml')) return responseWithUrl(metadata(), url);
      return artifactResponse(url, url.includes('updates.example.com') ? 1 : 30);
    });

    const selected = await selectApplicationUpdateSource(
      [DEFAULT_GITHUB_UPDATE_SOURCE, mirror],
      fetchMock,
    );

    expect(selected).toMatchObject({
      feed: { provider: 'generic', url: mirror.baseUrl },
      id: 'china',
      label: '中国大陆更新镜像',
    });
    expect(selected.throughputBps).toBeGreaterThan(0);
  });

  it('excludes a fast mirror whose SHA-512 differs from GitHub', async () => {
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) => {
      if (url.endsWith('latest.yml')) {
        return responseWithUrl(
          metadata(url.includes('updates.example.com') ? 'B'.repeat(88) : undefined),
          url,
        );
      }
      return artifactResponse(url, 1);
    });

    const selected = await selectApplicationUpdateSource(
      [DEFAULT_GITHUB_UPDATE_SOURCE, mirror],
      fetchMock,
    );

    expect(selected.id).toBe('github');
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.includes('updates.example.com/claudedock/ClaudeDock'),
      ),
    ).toBe(false);
  });

  it('fails closed to the GitHub updater feed when canonical metadata is unavailable', async () => {
    const fetchMock = vi.fn<ApplicationUpdateFetch>(async (url) => {
      if (url.includes('github.com')) return responseWithUrl('unavailable', url, 503);
      return responseWithUrl(metadata(), url);
    });

    await expect(
      selectApplicationUpdateSource([DEFAULT_GITHUB_UPDATE_SOURCE, mirror], fetchMock),
    ).resolves.toMatchObject({
      feed: { owner: 'AeonusOvO', provider: 'github', repo: 'claude-dock-control-panel' },
      id: 'github',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
