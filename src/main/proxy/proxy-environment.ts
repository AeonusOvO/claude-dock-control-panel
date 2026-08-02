import type { ProxyRuntimeView, ProxyScopeSettings } from '../../shared/contracts';
import type { TerminalEnvironmentOverrides } from '../terminal-session';

const REQUIRED_NO_PROXY = ['127.0.0.1', 'localhost', '::1'];
const LOOPBACK_BYPASS = '127.0.0.1,localhost,[::1]';

export const buildCliProxyEnvironment = (
  runtime: ProxyRuntimeView | undefined,
  scope: ProxyScopeSettings,
  inheritedNoProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '',
): TerminalEnvironmentOverrides => {
  if (!scope.cli || runtime?.status !== 'ready' || !runtime.httpProxyUrl) {
    return {};
  }
  const noProxy = [
    ...REQUIRED_NO_PROXY,
    ...inheritedNoProxy.split(',').map((item) => item.trim()),
  ].filter(Boolean);
  const normalizedNoProxy = [...new Set(noProxy.map((item) => item.toLowerCase()))].join(',');
  return {
    ALL_PROXY: null,
    all_proxy: null,
    CLAUDEDOCK_BUILT_IN_PROXY: '1',
    HTTPS_PROXY: runtime.httpProxyUrl,
    HTTP_PROXY: runtime.httpProxyUrl,
    NO_PROXY: normalizedNoProxy,
    https_proxy: runtime.httpProxyUrl,
    http_proxy: runtime.httpProxyUrl,
    no_proxy: normalizedNoProxy,
  };
};

/**
 * Accepts only what Chromium's `proxyRules` can actually use, and only shapes that cannot leak a
 * secret into a log line. Returns `undefined` for anything else so a malformed entry degrades to
 * "no bootstrap proxy" rather than silently poisoning every request the app makes.
 */
export const normalizeBootstrapProxyUrl = (candidate: unknown): string | undefined => {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return undefined;
  }
  try {
    const url = new URL(candidate.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'socks5:') {
      return undefined;
    }
    // Credentials in a proxy URL would end up in error text and audit records.
    if (url.username || url.password || !url.hostname) {
      return undefined;
    }
    const port = Number(url.port);
    if (!url.port || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return undefined;
    }
    return `${url.protocol}//${url.hostname}:${port}`;
  } catch {
    return undefined;
  }
};

/**
 * When the built-in tunnel is not applied to the app itself, ClaudeDock falls back to Windows' own
 * proxy settings rather than `direct`. `direct` would override a working system proxy for our own
 * network calls — including the Xray-core bootstrap download, which then stalls at 0% on machines
 * that can only reach GitHub through that proxy. Reading the OS setting is not modifying it.
 *
 * The middle branch is the bootstrap proxy: a route the user typed in themselves for the express
 * purpose of fetching the kernel, used only while the tunnel is not up. Nothing here is inferred
 * from the machine — an empty field means direct, and that is the default everyone ships with.
 */
export const builtInProxyRules = (
  runtime: ProxyRuntimeView | undefined,
  scope: ProxyScopeSettings,
): { mode: 'system' | 'fixed_servers'; proxyBypassRules?: string; proxyRules?: string } => {
  if (scope.application && runtime?.status === 'ready' && runtime.httpProxyUrl) {
    return {
      mode: 'fixed_servers',
      proxyBypassRules: LOOPBACK_BYPASS,
      proxyRules: runtime.httpProxyUrl,
    };
  }
  const bootstrap = normalizeBootstrapProxyUrl(scope.bootstrapProxyUrl);
  return bootstrap
    ? { mode: 'fixed_servers', proxyBypassRules: LOOPBACK_BYPASS, proxyRules: bootstrap }
    : { mode: 'system' };
};
