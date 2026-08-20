import { describe, expect, it } from 'vitest';
import {
  buildGitHubReleaseRoutes,
  pickFastestGitHubReleaseRoute,
} from '../../src/main/download/github-release-routes';

const url =
  'https://github.com/musistudio/claude-code-router/releases/download/v3.2.1/CCR-Setup.exe';

const responseAt = (target: string, chunks: number): Response => {
  let sent = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= chunks) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    }),
  );
  return Object.defineProperty(response, 'url', { value: target });
};

describe('GitHub release route selection', () => {
  it('builds an official route with redirect-chain whitelists', () => {
    const routes = buildGitHubReleaseRoutes(url);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ host: 'github.com', url });
    expect(
      routes.every((route) => route.allowedHosts.length === route.allowedPathPrefixes.length),
    ).toBe(true);
    expect(buildGitHubReleaseRoutes('https://api.github.com/repos/x/y')).toEqual([]);
  });

  it('chooses a reachable measured route through the injected app-session fetch', async () => {
    const selected = await pickFastestGitHubReleaseRoute(url, async (candidate) => {
      const target = String(candidate);
      if (target === url) {
        return responseAt(target, 2);
      }
      throw new Error('unreachable');
    });

    expect(selected?.host).toBe('github.com');
    expect(selected?.throughputBps).toBeGreaterThan(0);
  });
});
