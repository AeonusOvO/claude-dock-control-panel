import type { ProxyRuntimeView, ProxyScopeSettings } from '../../shared/contracts';
import type { TerminalEnvironmentOverrides } from '../terminal-session';

const REQUIRED_NO_PROXY = ['127.0.0.1', 'localhost', '::1'];

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
 * When the built-in tunnel is not applied to the app itself, ClaudeDock falls back to Windows' own
 * proxy settings rather than `direct`. `direct` would override a working system proxy for our own
 * network calls — including the Xray-core bootstrap download, which then stalls at 0% on machines
 * that can only reach GitHub through that proxy. Reading the OS setting is not modifying it.
 */
export const builtInProxyRules = (
  runtime: ProxyRuntimeView | undefined,
  scope: ProxyScopeSettings,
): { mode: 'system' | 'fixed_servers'; proxyBypassRules?: string; proxyRules?: string } =>
  scope.application && runtime?.status === 'ready' && runtime.httpProxyUrl
    ? {
        mode: 'fixed_servers',
        proxyBypassRules: '127.0.0.1,localhost,[::1]',
        proxyRules: runtime.httpProxyUrl,
      }
    : { mode: 'system' };
