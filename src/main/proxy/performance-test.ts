import type { ProxyPerformanceEndpointView, ProxyPerformanceView } from '../../shared/contracts';

export type ProxyPerformanceFetch = (url: string, init?: RequestInit) => Promise<Response>;

const ENDPOINTS = Object.freeze([
  {
    accept: 'text/html,*/*',
    label: '节点真实延迟（v2rayN 方法）',
    url: 'https://www.apple.com/library/test/success.html',
  },
  { accept: 'application/json', label: 'GitHub API', url: 'https://api.github.com/rate_limit' },
  {
    accept: 'application/json',
    label: 'npm 官方源',
    url: 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest',
  },
  {
    accept: 'application/json',
    label: 'npm 国内镜像',
    url: 'https://registry.npmmirror.com/@anthropic-ai%2fclaude-code/latest',
  },
]);

const endpointProbe = async (
  fetcher: ProxyPerformanceFetch,
  endpoint: (typeof ENDPOINTS)[number],
): Promise<ProxyPerformanceEndpointView> => {
  const startedAt = performance.now();
  try {
    const response = await fetcher(endpoint.url, {
      cache: 'no-store',
      headers: { accept: endpoint.accept, 'user-agent': 'ClaudeDock/proxy-real-ping' },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    // v2rayN's real-ping path measures the HTTP request through the temporary proxy instead of
    // downloading a large payload. ClaudeDock uses its already-isolated Xray session and stops at
    // the response headers for the same low-traffic property; no GPL source is copied or linked.
    await response.body?.cancel().catch(() => undefined);
    return {
      detail: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}，来源响应异常`,
      label: endpoint.label,
      latencyMs,
      ok: response.ok,
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : '连接失败',
      label: endpoint.label,
      ok: false,
    };
  }
};

export const testProxyPerformance = async (
  fetcher: ProxyPerformanceFetch,
): Promise<ProxyPerformanceView> => {
  const endpoints = await Promise.all(
    ENDPOINTS.map((endpoint) => endpointProbe(fetcher, endpoint)),
  );
  const successful = endpoints.filter(({ ok }) => ok).length;
  return {
    checkedAt: Date.now(),
    endpoints,
    error: successful > 0 ? undefined : '所有真实延迟与更新源探测均失败。',
  };
};
