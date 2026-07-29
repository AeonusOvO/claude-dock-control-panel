import { getServers } from 'node:dns';
import { networkInterfaces } from 'node:os';
import type { NetworkPathView, NetworkProcessKind, NetworkProviderId } from '../shared/contracts';

export type ResolveProxy = (url: string) => Promise<string>;

const PROXY_ENVIRONMENT_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

const VIRTUAL_INTERFACE_PATTERN =
  /(vpn|wireguard|wintun|tap|tun|tailscale|zerotier|hyper-v|vmware|virtualbox|docker|wsl)/i;

const virtualInterfaceCategory = (name: string): string => {
  if (/(wireguard|wintun|tap|tun|vpn)/i.test(name)) {
    return 'VPN / 隧道接口';
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

const classifyEnvironmentProxy = (): Pick<NetworkPathView, 'proxyConfigured' | 'proxyKind'> => {
  const configured = PROXY_ENVIRONMENT_KEYS.map((key) => process.env[key]?.trim()).find(Boolean);
  if (!configured) {
    return { proxyConfigured: false, proxyKind: 'direct' };
  }
  return {
    proxyConfigured: true,
    proxyKind: /^socks(?:4|5|5h)?:/i.test(configured) ? 'socks' : 'environment',
  };
};

const interfaceFacts = (): {
  ipv4Available: boolean;
  ipv6Available: boolean;
  virtualInterfaces: string[];
} => {
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
  }
  return {
    ipv4Available,
    ipv6Available,
    virtualInterfaces: [...new Set(virtualInterfaces)].sort(),
  };
};

const processLabel = (processKind: NetworkProcessKind): string => {
  switch (processKind) {
    case 'application':
      return 'Electron 主进程';
    case 'claude-cli':
      return 'Claude Code CLI';
    case 'codex-cli':
      return 'Codex CLI';
    case 'oauth-browser':
      return '系统浏览器 OAuth';
    case 'renderer':
      return '受限渲染进程';
    case 'terminal':
      return '项目终端';
  }
};

export class NetworkPathResolver {
  public constructor(private readonly resolveProxy: ResolveProxy) {}

  public async resolve(provider: NetworkProviderId, targetUrl: string): Promise<NetworkPathView[]> {
    const interfaces = interfaceFacts();
    const dnsServers = getServers().map((server) => {
      const percent = server.indexOf('%');
      return percent >= 0 ? server.slice(0, percent) : server;
    });
    let resolvedProxy = 'UNKNOWN';
    try {
      resolvedProxy = await this.resolveProxy(targetUrl);
    } catch {
      // A failed proxy lookup is represented as unknown and assessed by the decision engine.
    }
    const applicationProxy =
      resolvedProxy === 'UNKNOWN'
        ? { proxyConfigured: false, proxyKind: 'unknown' as const }
        : classifyResolvedProxy(resolvedProxy);
    const cliProxy = classifyEnvironmentProxy();
    const cliProcess: NetworkProcessKind =
      provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli';
    const makePath = (
      processKind: NetworkProcessKind,
      proxy: Pick<NetworkPathView, 'proxyConfigured' | 'proxyKind'>,
      detail: string,
    ): NetworkPathView => ({
      ...interfaces,
      ...proxy,
      detail: `${processLabel(processKind)}：${detail}`,
      dnsServers,
      process: processKind,
    });

    const paths = [
      makePath('application', applicationProxy, '使用 Electron 会话的系统代理解析结果。'),
      makePath(
        'oauth-browser',
        applicationProxy,
        '登录页交由系统浏览器打开，代理解析仅用于风险提示。',
      ),
      makePath(cliProcess, cliProxy, '继承启动时的 HTTP(S)_PROXY / ALL_PROXY 环境。'),
      makePath('terminal', cliProxy, '继承项目终端环境，不改写系统或 CLI 路由。'),
      makePath('renderer', applicationProxy, '无直接网络权限，所有探测均由主进程执行。'),
    ];
    return provider === 'openai-api'
      ? paths.filter((pathView) =>
          ['application', 'oauth-browser', 'renderer'].includes(pathView.process),
        )
      : paths;
  }
}
