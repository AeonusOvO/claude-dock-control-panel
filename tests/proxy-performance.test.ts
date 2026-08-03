import { describe, expect, it, vi } from 'vitest';
import { testProxyPerformance } from '../src/main/proxy/performance-test';

describe('built-in proxy performance test', () => {
  it('checks actual update sources and falls back between V2RayN-style speed sources', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('speed.cloudflare.com')) return new Response('unavailable', { status: 503 });
      if (url.includes('cachefly.cachefly.net')) {
        return new Response(new Uint8Array(2 * 1024 * 1024), {
          headers: { 'content-type': 'application/octet-stream' },
          status: 200,
        });
      }
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    });

    const result = await testProxyPerformance(fetchMock);

    expect(result.downloadBytes).toBe(2 * 1024 * 1024);
    expect(result.downloadBps).toBeGreaterThan(0);
    expect(result.endpoints.map(({ label }) => label)).toEqual([
      'GitHub API',
      'npm 官方源',
      'npm 国内镜像',
      'CacheFly 10 MB',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('registry.npmmirror.com'),
      expect.any(Object),
    );
  });
});
