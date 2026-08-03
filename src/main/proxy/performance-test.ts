import type { ProxyPerformanceEndpointView, ProxyPerformanceView } from '../../shared/contracts';

export type ProxyPerformanceFetch = (url: string, init?: RequestInit) => Promise<Response>;

const ENDPOINTS = Object.freeze([
  { label: 'GitHub API', url: 'https://api.github.com/rate_limit' },
  {
    label: 'npm 官方源',
    url: 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest',
  },
  {
    label: 'npm 国内镜像',
    url: 'https://registry.npmmirror.com/@anthropic-ai%2fclaude-code/latest',
  },
]);
const SPEED_SOURCES = Object.freeze([
  { label: 'Cloudflare 10 MB', url: 'https://speed.cloudflare.com/__down?bytes=10000000' },
  { label: 'CacheFly 10 MB', url: 'https://cachefly.cachefly.net/10mb.test' },
]);
const MAX_SPEED_BYTES = 12 * 1024 * 1024;

const endpointProbe = async (
  fetcher: ProxyPerformanceFetch,
  endpoint: (typeof ENDPOINTS)[number],
): Promise<ProxyPerformanceEndpointView> => {
  const startedAt = Date.now();
  try {
    const response = await fetcher(endpoint.url, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'user-agent': 'ClaudeDock/proxy-test' },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    const latencyMs = Date.now() - startedAt;
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

const measureSource = async (
  fetcher: ProxyPerformanceFetch,
  source: (typeof SPEED_SOURCES)[number],
): Promise<{ bytes: number; bytesPerSecond: number; endpoint: ProxyPerformanceEndpointView }> => {
  const startedAt = performance.now();
  const response = await fetcher(source.url, {
    cache: 'no-store',
    headers: { accept: 'application/octet-stream', 'user-agent': 'ClaudeDock/proxy-test' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${source.label} 返回 HTTP ${response.status}。`);
  }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SPEED_BYTES) throw new Error('测速响应超过 12 MiB 安全上限。');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
  if (bytes < 1024 * 1024) throw new Error(`${source.label} 返回的数据不足 1 MiB。`);
  return {
    bytes,
    bytesPerSecond: Math.round(bytes / elapsedSeconds),
    endpoint: {
      detail: `HTTP ${response.status} · ${bytes.toLocaleString('en-US')} bytes`,
      label: source.label,
      latencyMs,
      ok: true,
    },
  };
};

export const testProxyPerformance = async (
  fetcher: ProxyPerformanceFetch,
): Promise<ProxyPerformanceView> => {
  const endpointPromise = Promise.all(
    ENDPOINTS.map((endpoint) => endpointProbe(fetcher, endpoint)),
  );
  let speed:
    { bytes: number; bytesPerSecond: number; endpoint: ProxyPerformanceEndpointView } | undefined;
  let lastError = '测速来源不可用。';
  for (const source of SPEED_SOURCES) {
    try {
      speed = await measureSource(fetcher, source);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  const endpoints = await endpointPromise;
  return {
    checkedAt: Date.now(),
    downloadBytes: speed?.bytes ?? 0,
    downloadBps: speed?.bytesPerSecond,
    endpoints: [...endpoints, ...(speed ? [speed.endpoint] : [])],
    error: speed ? undefined : lastError,
  };
};
