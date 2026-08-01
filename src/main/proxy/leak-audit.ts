import { isIP } from 'node:net';
import type { ProxyAuditItem } from '../../shared/contracts';

export type AuditFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface EgressEvidence {
  asn?: string;
  countryCode?: string;
  ip?: string;
  organization?: string;
  sources: string[];
  sourcesAgree: boolean;
}

const MAX_EGRESS_RESPONSE_BYTES = 64 * 1024;
export const LEAK_AUDIT_ALLOWED_HOSTS = Object.freeze([
  'bash.ws',
  'www.cloudflare.com',
  'ipinfo.io',
]);

const DATACENTER_ORGANIZATION_PATTERN =
  /(amazon|aws|google|digitalocean|hetzner|ovh|linode|akamai|vultr|m247|leaseweb|choopa|oracle cloud|azure|microsoft hosting)/i;

const isPrivateDnsServer = (address: string): boolean => {
  const normalized =
    address
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%', 1)[0] ?? '';
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  const parts = normalized.split('.').map(Number);
  return (
    parts.length === 4 &&
    (parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
};

export const evaluateDns = (
  dnsServers: string[],
  proxyReady: boolean,
  onlineResolvers?: string[],
): ProxyAuditItem => {
  const localResolvers = dnsServers.filter(isPrivateDnsServer);
  const onlineAvailable = onlineResolvers !== undefined;
  const evidence = [
    `系统解析器：${dnsServers.length > 0 ? dnsServers.join('、') : '未读取到'}`,
    onlineAvailable
      ? `在线观测：${onlineResolvers.length > 0 ? onlineResolvers.join('、') : '未发现解析器'}`
      : '在线探测不可用，仅采用本地判据',
    proxyReady
      ? 'CLI 使用 HTTP CONNECT host:443，Xray domainStrategy=AsIs，目标域名由代理链路远端解析'
      : '内置代理未就绪，无法提供远端解析保障',
  ];
  if (!proxyReady) {
    return {
      advice: '先启动内置代理，再运行完整 DNS 体检。',
      evidence,
      explanation: '未启用内置代理，无法确认 CLI 域名是否经代理远端解析。',
      name: 'DNS 泄露',
      verdict: 'warning',
    };
  }
  if (localResolvers.length > 0) {
    return {
      advice: 'CLI 流量已由远端解析保护；其他未代理应用仍可能使用这些本地解析器。',
      evidence,
      explanation:
        '系统存在内网/本地 DNS，属于“可能本地解析”的提示；ClaudeDock 启动的 CLI 通过本地 HTTP 入站发送域名，Xray 保持 AsIs 并在代理链路远端解析。',
      name: 'DNS 泄露',
      verdict: onlineAvailable && onlineResolvers.length === 0 ? 'passed' : 'warning',
    };
  }
  return {
    advice: '切换网络、节点或 DNS 后重新检测。',
    evidence,
    explanation: '未发现私网 DNS，且 CLI 的代理请求使用远端域名解析机制。',
    name: 'DNS 泄露',
    verdict: onlineAvailable ? 'passed' : 'warning',
  };
};

const readLimitedText = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EGRESS_RESPONSE_BYTES) {
    throw new Error('出口探测响应超过 64 KiB 上限。');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_EGRESS_RESPONSE_BYTES) {
    throw new Error('出口探测响应超过 64 KiB 上限。');
  }
  return text;
};

const probeCloudflare = async (fetcher: AuditFetch): Promise<EgressEvidence> => {
  const response = await fetcher('https://www.cloudflare.com/cdn-cgi/trace', {
    cache: 'no-store',
    credentials: 'omit',
    headers: { Accept: 'text/plain' },
    method: 'GET',
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Cloudflare 出口探测返回 HTTP ${response.status}。`);
  }
  const values = new Map(
    (await readLimitedText(response))
      .split(/\r?\n/)
      .map((line) => line.split('=', 2) as [string, string])
      .filter(([key, value]) => Boolean(key && value)),
  );
  const ip = values.get('ip');
  if (!ip || isIP(ip) === 0) {
    throw new Error('Cloudflare 出口探测未返回有效 IP。');
  }
  return {
    countryCode: values.get('loc')?.toUpperCase(),
    ip,
    sources: ['Cloudflare trace'],
    sourcesAgree: true,
  };
};

const probeIpInfo = async (fetcher: AuditFetch): Promise<EgressEvidence> => {
  const response = await fetcher('https://ipinfo.io/json', {
    cache: 'no-store',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
    method: 'GET',
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`IPinfo 出口探测返回 HTTP ${response.status}。`);
  }
  const parsed = JSON.parse(await readLimitedText(response)) as Record<string, unknown>;
  const ip = typeof parsed.ip === 'string' ? parsed.ip : undefined;
  if (!ip || isIP(ip) === 0) {
    throw new Error('IPinfo 出口探测未返回有效 IP。');
  }
  const organization = typeof parsed.org === 'string' ? parsed.org.slice(0, 256) : undefined;
  const asn = organization?.match(/^AS\d+/i)?.[0]?.toUpperCase();
  return {
    asn,
    countryCode:
      typeof parsed.country === 'string' ? parsed.country.toUpperCase().slice(0, 2) : undefined,
    ip,
    organization,
    sources: ['IPinfo'],
    sourcesAgree: true,
  };
};

export const probeEgress = async (fetcher: AuditFetch): Promise<EgressEvidence> => {
  const results = await Promise.allSettled([probeCloudflare(fetcher), probeIpInfo(fetcher)]);
  const evidence = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (evidence.length === 0) {
    throw new Error('两路出口探测均不可用。');
  }
  const primary = evidence[0];
  if (!primary) {
    throw new Error('出口探测没有有效证据。');
  }
  const ipSet = new Set(evidence.map(({ ip }) => ip).filter(Boolean));
  const countrySet = new Set(evidence.map(({ countryCode }) => countryCode).filter(Boolean));
  return {
    asn: evidence.find(({ asn }) => asn)?.asn,
    countryCode: evidence.find(({ countryCode }) => countryCode)?.countryCode,
    ip: primary.ip,
    organization: evidence.find(({ organization }) => organization)?.organization,
    sources: evidence.flatMap(({ sources }) => sources),
    sourcesAgree: ipSet.size <= 1 && countrySet.size <= 1 && evidence.length === 2,
  };
};

export const evaluateEgress = (
  direct: EgressEvidence | undefined,
  proxied: EgressEvidence | undefined,
  hasGlobalIpv6: boolean,
): ProxyAuditItem[] => {
  const items: ProxyAuditItem[] = [];
  if (!direct || !proxied) {
    items.push({
      advice: '确认网络可用后重试；在证据不完整时不要把结论当作“无泄露”。',
      evidence: [`直连探测：${direct?.ip ?? '不可用'}`, `代理探测：${proxied?.ip ?? '不可用'}`],
      explanation: '至少一路出口探测失败，无法完成直连与代理出口对比。',
      name: '出口 IP 对比',
      verdict: 'warning',
    });
    return items;
  }
  const changed = direct.ip !== proxied.ip;
  items.push({
    advice: changed
      ? '保持当前节点稳定，切换节点后重新体检。'
      : '检查节点是否实际接管了 CLI 流量。',
    evidence: [
      `直连：${direct.ip ?? '未知'} ${direct.countryCode ?? ''}`.trim(),
      `代理：${proxied.ip ?? '未知'} ${proxied.countryCode ?? ''}`.trim(),
      `来源：${proxied.sources.join(' + ')}${proxied.sourcesAgree ? '（双源一致）' : '（双源未形成一致结论）'}`,
    ],
    explanation: changed
      ? '代理出口与直连出口不同，说明节点已经改变公网出口。'
      : '代理出口与直连出口相同，节点可能未生效或发生了旁路。',
    name: '出口 IP 对比',
    verdict: changed ? (proxied.sourcesAgree ? 'passed' : 'warning') : 'risk',
  });
  if (hasGlobalIpv6 && isIP(proxied.ip ?? '') === 4) {
    items.push({
      advice: '禁用未代理的 IPv6，或选择同时支持 IPv6 的节点后重试。',
      evidence: ['本机存在全局 IPv6', `代理探测仅得到 IPv4：${proxied.ip}`],
      explanation: '本机 IPv6 可能绕过仅支持 IPv4 的代理直接出网。',
      name: 'IPv6 旁路',
      verdict: 'risk',
    });
  } else {
    items.push({
      advice: '网络接口变化或切换节点后重新检测。',
      evidence: [hasGlobalIpv6 ? '代理出口具备 IPv6 证据' : '本机未发现全局 IPv6'],
      explanation: '当前证据没有显示 IPv6 会绕过代理。',
      name: 'IPv6 旁路',
      verdict: 'passed',
    });
  }
  const datacenter = DATACENTER_ORGANIZATION_PATTERN.test(proxied.organization ?? '');
  items.push({
    advice: datacenter
      ? '如服务对机房出口敏感，考虑使用信誉更稳定的住宅或企业出口。'
      : '继续结合供应商地区政策判断。',
    evidence: [`ASN：${proxied.asn ?? '未知'}`, `组织：${proxied.organization ?? '未知'}`],
    explanation: datacenter
      ? '组织名称命中常见云厂商/机房关键词；这是启发式提示，不是确定的 IP 信誉结论。'
      : '未命中内置机房关键词；这同样不能证明出口一定是住宅网络。',
    name: 'ASN / 机房启发式',
    verdict: datacenter ? 'warning' : 'passed',
  });
  return items;
};
