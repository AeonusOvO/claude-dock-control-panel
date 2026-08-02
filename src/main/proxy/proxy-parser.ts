import type {
  ProxyCredentialInput,
  ProxyImportPreview,
  ProxyProfileInput,
  ProxyProtocol,
  ProxySecurity,
  ProxyStreamOptions,
  ProxyTransport,
} from '../../shared/contracts';
import { normalizeProxyProfile } from './proxy-store';

const decodeBase64 = (value: string): string => {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
};

const booleanValue = (value: unknown): boolean =>
  value === true || (typeof value === 'string' && /^(?:1|true|tls)$/i.test(value));

const numberValue = (value: unknown): number =>
  typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);

/**
 * v2rayN accepts `raw` as the modern alias of the `tcp` transport, and treats anything it does not
 * recognise as `tcp` rather than rejecting the node.
 */
const transportValue = (value: unknown): ProxyTransport => {
  const normalized = String(value ?? 'tcp').toLowerCase();
  return normalized === 'ws' || normalized === 'grpc' || normalized === 'http' ? normalized : 'tcp';
};

/**
 * `security` is a mode, not a flag: v2rayN stores `reality` alongside `tls` and `none`. Older links
 * still write `security=1`/`true`, which mean TLS.
 */
const securityValue = (value: unknown): ProxySecurity => {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'reality') {
    return 'reality';
  }
  return normalized === 'tls' || booleanValue(normalized) ? 'tls' : 'none';
};

const queryText = (
  parameters: URLSearchParams,
  ...names: readonly string[]
): string | undefined => {
  for (const name of names) {
    const value = parameters.get(name);
    if (value) {
      return value;
    }
  }
  return undefined;
};

/**
 * The stream-layer half of a share link, mirroring `BaseFmt.ResolveUriQuery` in v2rayN: everything a
 * REALITY or XTLS node needs beyond host/port/uuid lives here, and dropping any of it turns the node
 * into a plaintext TCP connection that no server will answer.
 */
const streamOptionsFromQuery = (parameters: URLSearchParams): ProxyStreamOptions => {
  const security = securityValue(parameters.get('security'));
  return {
    allowInsecure: booleanValue(
      queryText(parameters, 'allowInsecure', 'allow_insecure', 'insecure') ?? '',
    ),
    alpn: queryText(parameters, 'alpn'),
    encryption: queryText(parameters, 'encryption'),
    fingerprint: queryText(parameters, 'fp'),
    flow: queryText(parameters, 'flow'),
    headerType: queryText(parameters, 'headerType'),
    host: queryText(parameters, 'host', 'authority'),
    publicKey: queryText(parameters, 'pbk'),
    security,
    shortId: queryText(parameters, 'sid'),
    spiderX: queryText(parameters, 'spx'),
  };
};

const decodedRemark = (value: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const validatedInput = (input: ProxyProfileInput): ProxyProfileInput => {
  const { credentials, profile } = normalizeProxyProfile(input);
  return {
    address: profile.address,
    allowInsecure: profile.allowInsecure,
    alpn: profile.alpn,
    credentials,
    encryption: profile.encryption,
    fingerprint: profile.fingerprint,
    flow: profile.flow,
    headerType: profile.headerType,
    host: profile.host,
    id: profile.id,
    port: profile.port,
    protocol: profile.protocol,
    publicKey: profile.publicKey,
    remark: profile.remark,
    security: profile.security,
    serverName: profile.serverName,
    shortId: profile.shortId,
    spiderX: profile.spiderX,
    subscriptionId: profile.subscriptionId,
    tls: profile.tls,
    transport: profile.transport,
    transportPath: profile.transportPath,
  };
};

const parseVmess = (link: string): ProxyProfileInput => {
  const raw = JSON.parse(decodeBase64(link.slice('vmess://'.length))) as Record<string, unknown>;
  return validatedInput({
    address: String(raw.add ?? ''),
    alpn: String(raw.alpn ?? '') || undefined,
    credentials: {
      alterId: numberValue(raw.aid) || 0,
      method: String(raw.scy ?? raw.security ?? 'auto'),
      uuid: String(raw.id ?? ''),
    },
    fingerprint: String(raw.fp ?? '') || undefined,
    headerType: String(raw.type ?? '') || undefined,
    host: String(raw.host ?? '') || undefined,
    port: numberValue(raw.port),
    protocol: 'vmess',
    remark: String(raw.ps ?? ''),
    security: securityValue(raw.tls),
    serverName: String(raw.sni ?? raw.host ?? '') || undefined,
    transport: transportValue(raw.net),
    transportPath: String(raw.path ?? '') || undefined,
  });
};

const parseUrlProfile = (link: string): ProxyProfileInput => {
  const url = new URL(link);
  const protocol = url.protocol.slice(0, -1) as ProxyProtocol;
  if (!['http', 'socks', 'trojan', 'vless'].includes(protocol)) {
    throw new Error('分享链接协议不受支持。');
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const credentials: ProxyCredentialInput =
    protocol === 'vless'
      ? { uuid: user }
      : protocol === 'trojan'
        ? { password: user || password }
        : { password: password || undefined, username: user || undefined };
  return validatedInput({
    ...streamOptionsFromQuery(url.searchParams),
    address: url.hostname,
    credentials,
    port: numberValue(url.port),
    protocol,
    remark: decodedRemark(url.hash.slice(1)),
    serverName: url.searchParams.get('sni') ?? url.searchParams.get('host') ?? undefined,
    transport: transportValue(url.searchParams.get('type')),
    transportPath: url.searchParams.get('path') ?? url.searchParams.get('serviceName') ?? undefined,
  });
};

const parseShadowsocks = (link: string): ProxyProfileInput => {
  const body = link.slice('ss://'.length);
  const [withoutFragment, fragment = ''] = body.split('#', 2);
  const [withoutQuery] = (withoutFragment ?? '').split('?', 1);
  if (!withoutQuery) {
    throw new Error('Shadowsocks 分享链接为空。');
  }
  let userInfo: string;
  let endpoint: string;
  const at = withoutQuery.lastIndexOf('@');
  if (at >= 0) {
    const rawUserInfo = withoutQuery.slice(0, at);
    userInfo = rawUserInfo.includes(':') ? rawUserInfo : decodeBase64(rawUserInfo);
    endpoint = withoutQuery.slice(at + 1);
  } else {
    const decoded = decodeBase64(withoutQuery);
    const decodedAt = decoded.lastIndexOf('@');
    if (decodedAt < 0) {
      throw new Error('Shadowsocks 分享链接缺少服务器地址。');
    }
    userInfo = decoded.slice(0, decodedAt);
    endpoint = decoded.slice(decodedAt + 1);
  }
  const colon = userInfo.indexOf(':');
  if (colon <= 0) {
    throw new Error('Shadowsocks 分享链接缺少加密方式或密码。');
  }
  const endpointUrl = new URL(`ss://${endpoint}`);
  return validatedInput({
    address: endpointUrl.hostname,
    credentials: {
      method: decodeURIComponent(userInfo.slice(0, colon)),
      password: decodeURIComponent(userInfo.slice(colon + 1)),
    },
    port: numberValue(endpointUrl.port),
    protocol: 'shadowsocks',
    remark: decodedRemark(fragment),
  });
};

export const parseProxyShareLink = (link: string): ProxyProfileInput => {
  const trimmed = link.trim();
  if (trimmed.startsWith('vmess://')) {
    return parseVmess(trimmed);
  }
  if (trimmed.startsWith('ss://')) {
    return parseShadowsocks(trimmed);
  }
  return parseUrlProfile(trimmed);
};

const parseScalar = (value: string): string | number | boolean => {
  const trimmed = value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (/^(?:true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true';
  }
  return trimmed;
};

const parseInlineMap = (body: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const part of body.replace(/^\{|\}$/g, '').split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/)) {
    const separator = part.indexOf(':');
    if (separator > 0) {
      result[part.slice(0, separator).trim()] = parseScalar(part.slice(separator + 1));
    }
  }
  return result;
};

const clashRecordToProfile = (record: Record<string, unknown>): ProxyProfileInput => {
  const protocol = String(record.type ?? '').toLowerCase() as ProxyProtocol;
  const credentials: ProxyCredentialInput =
    protocol === 'vmess' || protocol === 'vless'
      ? { alterId: numberValue(record.alterId) || 0, uuid: String(record.uuid ?? '') }
      : protocol === 'shadowsocks'
        ? { method: String(record.cipher ?? ''), password: String(record.password ?? '') }
        : protocol === 'trojan'
          ? { password: String(record.password ?? '') }
          : {
              password: record.password ? String(record.password) : undefined,
              username: record.username ? String(record.username) : undefined,
            };
  // Clash flattens REALITY under `reality-opts:`; the line reader above hoists its keys to the node.
  const publicKey = String(record['public-key'] ?? '') || undefined;
  return validatedInput({
    address: String(record.server ?? ''),
    allowInsecure: booleanValue(record['skip-cert-verify']),
    alpn: String(record.alpn ?? '') || undefined,
    credentials,
    fingerprint: String(record['client-fingerprint'] ?? '') || undefined,
    flow: String(record.flow ?? '') || undefined,
    host: String(record.host ?? '') || undefined,
    port: numberValue(record.port),
    protocol,
    publicKey,
    remark: String(record.name ?? ''),
    security: publicKey ? 'reality' : securityValue(record.tls),
    serverName: String(record.sni ?? record.servername ?? '') || undefined,
    shortId: String(record['short-id'] ?? '') || undefined,
    transport: transportValue(record.network),
    transportPath: String(record.path ?? record['ws-path'] ?? '') || undefined,
  });
};

export const parseClashProxies = (yaml: string): ProxyImportPreview => {
  const records: Record<string, unknown>[] = [];
  let inProxies = false;
  let current: Record<string, unknown> | undefined;
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!inProxies) {
      inProxies = /^proxies:\s*$/.test(line.trim());
      continue;
    }
    if (/^\S/.test(line) && !/^\s*-/.test(line)) {
      break;
    }
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item) {
      current = item[1]?.trim().startsWith('{') ? parseInlineMap(item[1].trim()) : {};
      records.push(current);
      if (item[1] && !item[1].trim().startsWith('{')) {
        const separator = item[1].indexOf(':');
        if (separator > 0) {
          current[item[1].slice(0, separator).trim()] = parseScalar(item[1].slice(separator + 1));
        }
      }
      continue;
    }
    const property = line.match(/^\s+([\w-]+):\s*(.*?)\s*$/);
    if (current && property?.[1]) {
      current[property[1]] = parseScalar(property[2] ?? '');
    }
  }
  const preview: ProxyImportPreview = { issues: [], profiles: [] };
  records.forEach((record, index) => {
    try {
      preview.profiles.push(clashRecordToProfile(record));
    } catch (error) {
      preview.issues.push({
        index: index + 1,
        message: `第 ${index + 1} 个节点${error instanceof Error ? error.message : '格式无效。'}，已跳过。`,
      });
    }
  });
  return preview;
};

export const parseProxyImportText = (text: string): ProxyImportPreview => {
  if (/^\s*proxies:\s*$/m.test(text)) {
    return parseClashProxies(text);
  }
  let candidate = text.trim();
  if (!/(?:vmess|vless|trojan|ss|socks|http):\/\//i.test(candidate)) {
    try {
      candidate = decodeBase64(candidate);
    } catch {
      // The per-line parser below returns an actionable error.
    }
  }
  const preview: ProxyImportPreview = { issues: [], profiles: [] };
  candidate
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      try {
        preview.profiles.push(parseProxyShareLink(line));
      } catch (error) {
        preview.issues.push({
          index: index + 1,
          message: `第 ${index + 1} 个节点${error instanceof Error ? error.message : '格式无效。'}，已跳过。`,
        });
      }
    });
  return preview;
};
