import type { ApplicationProxyCandidate, ApplicationProxyView } from '../../shared/contracts';
import type { TerminalEnvironmentOverrides } from '../terminal-session';
import type { ApplicationProxyCredentials } from './application-proxy-store';

const REQUIRED_NO_PROXY = ['127.0.0.1', 'localhost', '::1'];
const ELECTRON_BYPASS = '127.0.0.1,localhost,[::1]';

const hostForUrl = (host: string): string => (host.includes(':') ? `[${host}]` : host);

export const applicationProxyUrl = (
  view: ApplicationProxyView,
  credentials?: ApplicationProxyCredentials,
): string | undefined => {
  if (!view.enabled || !view.host || !view.port) return undefined;
  const userInfo = credentials
    ? `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`
    : '';
  return `${view.protocol}://${userInfo}${hostForUrl(view.host)}:${view.port}`;
};

export const applicationProxyRules = (
  view: ApplicationProxyView,
  scope: 'application' | 'conversation',
): {
  mode: 'direct' | 'fixed_servers' | 'system';
  proxyBypassRules?: string;
  proxyRules?: string;
} => {
  const url = applicationProxyUrl(view);
  if (!url || !view.scope[scope]) {
    return { mode: scope === 'application' ? 'system' : 'direct' };
  }
  return {
    mode: 'fixed_servers',
    proxyBypassRules: ELECTRON_BYPASS,
    proxyRules: url,
  };
};

export const buildApplicationProxyEnvironment = (
  view: ApplicationProxyView,
  credentials?: ApplicationProxyCredentials,
  inheritedNoProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '',
): TerminalEnvironmentOverrides => {
  if (!view.enabled || !view.scope.cli || view.protocol !== 'http') return {};
  const url = applicationProxyUrl(view, credentials);
  if (!url) return {};
  const noProxy = [...REQUIRED_NO_PROXY, ...inheritedNoProxy.split(',').map((item) => item.trim())]
    .filter(Boolean)
    .map((item) => item.toLowerCase());
  const normalizedNoProxy = [...new Set(noProxy)].join(',');
  return {
    ALL_PROXY: null,
    all_proxy: null,
    CLAUDEDOCK_APPLICATION_PROXY: '1',
    CLAUDEDOCK_BUILT_IN_PROXY: null,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: normalizedNoProxy,
    https_proxy: url,
    http_proxy: url,
    no_proxy: normalizedNoProxy,
  };
};

export const parseApplicationProxyCandidate = (
  candidate: unknown,
  label: string,
): ApplicationProxyCandidate | undefined => {
  if (typeof candidate !== 'string' || !candidate.trim()) return undefined;
  try {
    const url = new URL(candidate.trim());
    const protocol =
      url.protocol === 'http:' ? 'http' : url.protocol === 'socks5:' ? 'socks5' : undefined;
    const port = Number(url.port);
    if (
      !protocol ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash ||
      !url.port ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      return undefined;
    }
    return { host: url.hostname.replace(/^\[/, '').replace(/\]$/, ''), label, port, protocol };
  } catch {
    return undefined;
  }
};
