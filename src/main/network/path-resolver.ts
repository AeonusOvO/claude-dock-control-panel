import { getServers } from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type {
  NetworkPathView,
  NetworkPreflightScope,
  NetworkProcessKind,
  NetworkProviderId,
} from '../../shared/contracts';

export type ResolveProxy = (
  url: string,
  networkScope: NetworkPreflightScope,
  signal?: AbortSignal,
) => Promise<string>;

export const PROXY_ENVIRONMENT_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

export const NO_PROXY_ENVIRONMENT_KEYS = ['NO_PROXY', 'no_proxy'] as const;

export const VIRTUAL_INTERFACE_PATTERN =
  /(vpn|wireguard|wintun|tap|tun|tailscale|zerotier|hyper-v|vmware|virtualbox|docker|wsl)/i;

export const virtualInterfaceCategory = (name: string): string => {
  if (/(wireguard|wintun|tap|tun|vpn)/i.test(name)) {
    return '虚拟网络接口';
  }
  if (/(tailscale|zerotier)/i.test(name)) {
    return '覆盖网络接口';
  }
  if (/(hyper-v|vmware|virtualbox)/i.test(name)) {
    return '虚拟机网络接口';
  }
  if (/(docker|wsl)/i.test(name)) {
    return '容器 / WSL 网络接口';
  }
  return '虚拟网络接口';
};

const classifyResolvedProxy = (
  value: string,
): Pick<NetworkPathView, 'proxyConfigured' | 'proxyKind'> => {
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized === 'DIRECT') {
    return { proxyConfigured: false, proxyKind: 'direct' };
  }
  if (normalized.includes('SOCKS')) {
    return { proxyConfigured: true, proxyKind: 'socks' };
  }
  if (normalized.includes('PROXY') || normalized.includes('HTTPS')) {
    return { proxyConfigured: true, proxyKind: 'system' };
  }
  return { proxyConfigured: true, proxyKind: 'pac' };
};

interface EnvironmentProxyDecision {
  bypassedByNoProxy: boolean;
  proxy: Pick<NetworkPathView, 'proxyConfigured' | 'proxyKind'>;
}

const targetPort = (url: URL): string =>
  url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');

const noProxyEntry = (rawEntry: string): { host: string; port?: string } | undefined => {
  const entry = rawEntry.trim();
  if (!entry) return undefined;
  if (entry.startsWith('[')) {
    const closingBracket = entry.indexOf(']');
    if (closingBracket < 0) return undefined;
    const host = entry.slice(1, closingBracket).toLowerCase();
    const remainder = entry.slice(closingBracket + 1);
    return remainder.startsWith(':') && /^\d+$/.test(remainder.slice(1))
      ? { host, port: remainder.slice(1) }
      : { host };
  }
  const separator = entry.lastIndexOf(':');
  const hasOneColon = separator >= 0 && entry.indexOf(':') === separator;
  const port =
    hasOneColon && /^\d+$/.test(entry.slice(separator + 1))
      ? entry.slice(separator + 1)
      : undefined;
  const host = (port ? entry.slice(0, separator) : entry).replace(/^\./, '').toLowerCase();
  return host ? { host, ...(port ? { port } : {}) } : undefined;
};

const targetBypassesEnvironmentProxy = (targetUrl: string): boolean => {
  let target: URL;
  try {
    target = new URL(targetUrl.replace(/^wss:/i, 'https:'));
  } catch {
    return false;
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = targetPort(target);
  const entries = NO_PROXY_ENVIRONMENT_KEYS.map((key) => process.env[key])
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(','));
  return entries.some((rawEntry) => {
    const entry = rawEntry.trim();
    if (entry === '*') return true;
    const parsed = noProxyEntry(entry);
    if (!parsed || (parsed.port && parsed.port !== port)) return false;
    if (isIP(parsed.host) !== 0 || parsed.host === 'localhost') {
      return hostname === parsed.host;
    }
    return hostname === parsed.host || hostname.endsWith(`.${parsed.host}`);
  });
};

const environmentProxyDecision = (
  applicationProxyUrl?: string,
  targetUrl?: string,
): EnvironmentProxyDecision => {
  const applicationProxyConfigured = /^https?:\/\//i.test(applicationProxyUrl ?? '');
  const configured = PROXY_ENVIRONMENT_KEYS.map((key) => process.env[key]?.trim()).find(Boolean);
  const bypassedByNoProxy = Boolean(
    targetUrl &&
    (applicationProxyConfigured || configured) &&
    targetBypassesEnvironmentProxy(targetUrl),
  );
  if (bypassedByNoProxy || (!applicationProxyConfigured && !configured)) {
    return {
      bypassedByNoProxy,
      proxy: { proxyConfigured: false, proxyKind: 'direct' },
    };
  }
  if (applicationProxyConfigured) {
    return {
      bypassedByNoProxy: false,
      proxy: { proxyConfigured: true, proxyKind: 'application-proxy' },
    };
  }
  if (!configured) {
    return {
      bypassedByNoProxy: false,
      proxy: { proxyConfigured: false, proxyKind: 'direct' },
    };
  }
  return {
    bypassedByNoProxy: false,
    proxy: {
      proxyConfigured: true,
      proxyKind: /^socks5h:/i.test(configured)
        ? 'socks5h'
        : /^socks(?:4|5)?:/i.test(configured)
          ? 'socks'
          : 'environment',
    },
  };
};

export const classifyEnvironmentProxy = (
  applicationProxyUrl?: string,
  targetUrl?: string,
): Pick<NetworkPathView, 'proxyConfigured' | 'proxyKind'> =>
  environmentProxyDecision(applicationProxyUrl, targetUrl).proxy;

export interface NetworkPathLocalFacts {
  dnsServers: string[];
  globalIpv6Available: boolean;
  ipv4Available: boolean;
  ipv6Available: boolean;
  virtualInterfaces: string[];
}

export const interfaceFacts = (): Omit<NetworkPathLocalFacts, 'dnsServers'> => {
  let globalIpv6Available = false;
  let ipv4Available = false;
  let ipv6Available = false;
  const virtualInterfaces: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses?.some((address) => !address.internal)) {
      continue;
    }
    if (VIRTUAL_INTERFACE_PATTERN.test(name)) {
      virtualInterfaces.push(virtualInterfaceCategory(name));
    }
    ipv4Available ||= addresses.some((address) => !address.internal && address.family === 'IPv4');
    ipv6Available ||= addresses.some((address) => !address.internal && address.family === 'IPv6');
    globalIpv6Available ||= addresses.some((address) => {
      if (address.internal || address.family !== 'IPv6') return false;
      const normalized = address.address.toLowerCase().split('%', 1)[0] ?? '';
      return !/^(?:fe[89ab]|f[cd]|ff|::ffff:|::1$|::$)/i.test(normalized);
    });
  }
  return {
    globalIpv6Available,
    ipv4Available,
    ipv6Available,
    virtualInterfaces: [...new Set(virtualInterfaces)].sort(),
  };
};

const hostLocalFacts = (): NetworkPathLocalFacts => ({
  ...interfaceFacts(),
  dnsServers: getServers().map((server) => {
    const percent = server.indexOf('%');
    return percent >= 0 ? server.slice(0, percent) : server;
  }),
});

const processLabel = (processKind: NetworkProcessKind): string => {
  switch (processKind) {
    case 'application':
      return 'Electron 主进程';
    case 'claude-cli':
      return 'Claude Code CLI';
    case 'codex-cli':
      return 'Codex CLI';
    case 'network-diagnostics':
      return '网络诊断进程';
    case 'oauth-browser':
      return '系统浏览器 OAuth';
    case 'renderer':
      return '受限渲染进程';
    case 'terminal':
      return '项目终端';
  }
};

export class NetworkPathResolver {
  public constructor(
    private readonly resolveProxy: ResolveProxy,
    private readonly applicationProxyUrl: () => string | undefined = () => undefined,
    private readonly readLocalFacts: () => NetworkPathLocalFacts = hostLocalFacts,
  ) {}

  public async resolve(
    provider: NetworkProviderId,
    targetUrl: string,
    networkScope: NetworkPreflightScope = 'application',
    signal?: AbortSignal,
  ): Promise<NetworkPathView[]> {
    signal?.throwIfAborted();
    let localFacts: NetworkPathLocalFacts;
    try {
      localFacts = this.readLocalFacts();
    } catch {
      // Without authoritative host-interface facts, returning no path rows is safer than fabricating
      // an offline observation from false placeholders.
      return [];
    }
    let resolvedProxy = 'UNKNOWN';
    try {
      resolvedProxy = await this.resolveProxy(targetUrl, networkScope, signal);
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      // A failed proxy lookup is represented as unknown and assessed by the decision engine.
    }
    const applicationProxy =
      resolvedProxy === 'UNKNOWN'
        ? { proxyConfigured: false, proxyKind: 'unknown' as const }
        : classifyResolvedProxy(resolvedProxy);
    const cliProxyDecision = environmentProxyDecision(this.applicationProxyUrl(), targetUrl);
    const cliProxy = cliProxyDecision.proxy;
    const cliProcess: NetworkProcessKind =
      provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli';
    const makePath = (
      processKind: NetworkProcessKind,
      proxy: Pick<NetworkPathView, 'proxyConfigured' | 'proxyKind'>,
      detail: string,
    ): NetworkPathView => ({
      ...localFacts,
      ...proxy,
      detail: `${processLabel(processKind)}：${detail}`,
      networkScope,
      process: processKind,
      target: targetUrl,
    });

    const paths = [
      makePath(
        'application',
        applicationProxy,
        applicationProxy.proxyConfigured
          ? '使用 Electron 会话解析出的本机可见代理第一跳；后续链路由代理内核决定。'
          : '未解析到本机显式代理；TUN、透明代理或软路由链路仍可能接管后续流量。',
      ),
      makePath(
        cliProcess,
        cliProxy,
        cliProxy.proxyKind === 'application-proxy'
          ? '经用户配置的外部 HTTP 代理转发；ClaudeDock 不提供该代理或其后续线路。'
          : cliProxy.proxyConfigured
            ? '继承启动时 HTTP(S)_PROXY / ALL_PROXY 指定的可见第一跳；代理内核可继续链式转发。'
            : cliProxyDecision.bypassedByNoProxy
              ? '当前目标命中 NO_PROXY，未使用已配置的代理环境变量；CLI 仍可能经过 TUN、透明代理或软路由链路。'
              : '未发现代理环境变量；CLI 仍可能经过 TUN、透明代理或软路由链路。',
      ),
      makePath(
        'terminal',
        cliProxy,
        cliProxy.proxyKind === 'application-proxy'
          ? '经用户配置的外部 HTTP 代理转发；仅影响由 ClaudeDock 启动的项目终端。'
          : cliProxy.proxyConfigured
            ? '继承项目终端的代理环境第一跳，不改写系统或 CLI 路由。'
            : cliProxyDecision.bypassedByNoProxy
              ? '当前目标命中 NO_PROXY，未使用已配置的代理环境变量；不据此断言公网直连。'
              : '未发现代理环境变量，不据此断言公网直连。',
      ),
      makePath('renderer', applicationProxy, '无直接网络权限，所有探测均由主进程执行。'),
    ];
    return provider === 'openai-api' || provider === 'ai-services' || provider === 'xai-grok'
      ? paths.filter((pathView) => ['application', 'renderer'].includes(pathView.process))
      : paths;
  }

  /**
   * Reports Electron/PAC-dependent paths as unknown after a deadline while preserving independently
   * observable CLI and terminal proxy configuration. This keeps a hung PAC lookup from hiding an
   * unsupported CLI proxy or inventing uncertainty about process environment that was read locally.
   */
  public unknownPaths(
    provider: NetworkProviderId,
    targetUrl: string,
    networkScope: NetworkPreflightScope,
    detail: string,
  ): NetworkPathView[] {
    let localFacts: NetworkPathLocalFacts;
    try {
      localFacts = this.readLocalFacts();
    } catch {
      return [];
    }
    const cliProcess: NetworkProcessKind =
      provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli';
    const unknownProxy = { proxyConfigured: false, proxyKind: 'unknown' as const };
    const cliProxy = environmentProxyDecision(this.applicationProxyUrl(), targetUrl).proxy;
    const processes: NetworkProcessKind[] = ['application', cliProcess, 'terminal', 'renderer'];
    const paths = processes.map((processKind) => {
      const cliOrTerminal = processKind === cliProcess || processKind === 'terminal';
      const proxy = cliOrTerminal ? cliProxy : unknownProxy;
      const processDetail = cliOrTerminal
        ? `${detail}；该进程的代理配置已从本地配置独立判定。`
        : detail;
      return {
        ...localFacts,
        ...proxy,
        detail: `${processLabel(processKind)}：${processDetail}`,
        networkScope,
        process: processKind,
        target: targetUrl,
      };
    });
    return provider === 'openai-api' || provider === 'ai-services' || provider === 'xai-grok'
      ? paths.filter((pathView) => ['application', 'renderer'].includes(pathView.process))
      : paths;
  }
}
