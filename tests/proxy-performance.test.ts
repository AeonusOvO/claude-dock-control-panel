import { describe, expect, it, vi } from 'vitest';
import { testProxyPerformance } from '../src/main/proxy/performance-test';

describe('built-in proxy performance test', () => {
  it('checks real HTTP latency and update sources without a large download', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    });

    const result = await testProxyPerformance(fetchMock);

    expect(result.endpoints.map(({ label }) => label)).toEqual([
      '节点真实延迟（v2rayN 方法）',
      'GitHub API',
      'npm 官方源',
      'npm 国内镜像',
    ]);
    expect(result.endpoints[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('registry.npmmirror.com'),
      expect.any(Object),
    );
  });
});
