import { randomBytes } from 'node:crypto';
import { getServers } from 'node:dns';
import { resolveTxt as nodeResolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type {
  NetworkEnvironmentAssessment,
  NetworkEnvironmentCheck,
  NetworkEnvironmentIssue,
  NetworkPreflightPreferences,
  NetworkPublicAddressObservation,
} from '../../shared/contracts';
import {
  isIpv4MappedIpv6Address,
  transientEgressAddressPrefix,
} from '../egress-diagnostics/address-redactor';
import { runWindowsCommand } from '../infra/windows-command';
import { redactDiagnosticText } from './diagnostics-store';

type JsonObject = Record<string, unknown>;

export interface NetworkEnvironmentRiskProbeOptions {
  cliEnvironment?: () => Record<string, null | string>;
  globalIpv6Available?: () => boolean;
  now?: () => number;
  readDnsServers?: () => string[];
  requestJson?: (url: string, signal?: AbortSignal) => Promise<unknown>;
  requestText?: (url: string, signal?: AbortSignal) => Promise<string>;
  resolveTxt?: (hostname: string, signal?: AbortSignal) => Promise<string[][]>;
  settings: () => NetworkPreflightPreferences;
  systemLanguages: () => readonly string[];
  timezone?: () => string;
}

const COUNTRY_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  AE: ['ar-AE', 'en-AE'],
  AR: ['es-AR'],
  AT: ['de-AT'],
  AU: ['en-AU'],
  BE: ['nl-BE', 'fr-BE', 'de-BE'],
  BR: ['pt-BR'],
  CA: ['en-CA', 'fr-CA'],
  CH: ['de-CH', 'fr-CH', 'it-CH'],
  CL: ['es-CL'],
  CN: ['zh-CN'],
  CZ: ['cs-CZ'],
  DE: ['de-DE'],
  DK: ['da-DK'],
  ES: ['es-ES'],
  FI: ['fi-FI', 'sv-FI'],
  FR: ['fr-FR'],
  GB: ['en-GB'],
  HK: ['zh-HK', 'en-HK'],
  ID: ['id-ID'],
  IE: ['en-IE'],
  IL: ['he-IL', 'en-IL'],
  IN: ['en-IN', 'hi-IN'],
  IT: ['it-IT'],
  JP: ['ja-JP'],
  KR: ['ko-KR'],
  MX: ['es-MX'],
  MY: ['ms-MY', 'en-MY'],
  NL: ['nl-NL'],
  NO: ['nb-NO', 'nn-NO'],
  NZ: ['en-NZ'],
  PH: ['en-PH', 'fil-PH'],
  PL: ['pl-PL'],
  SE: ['sv-SE'],
  SG: ['en-SG', 'zh-SG'],
  TH: ['th-TH'],
  TW: ['zh-TW'],
  US: ['en-US', 'es-US'],
  VN: ['vi-VN'],
  ZA: ['en-ZA'],
};

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, maximum = 160): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;

const sanitizeThirdPartyValue = (value: string): string =>
  redactDiagnosticText(value)
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    );

const thirdPartyText = (value: unknown, maximum = 160): string | undefined => {
  const candidate = text(value, maximum);
  return candidate ? sanitizeThirdPartyValue(candidate).slice(0, maximum) : undefined;
};

const thirdPartyError = (error: unknown, maximum: number): string =>
  sanitizeThirdPartyValue(error instanceof Error ? error.message : String(error)).slice(0, maximum);

const bool = (record: JsonObject | undefined, ...keys: string[]): boolean =>
  keys.some((key) => record?.[key] === true || record?.[key] === 'yes');

const explicitBooleanEvidence = (value: unknown): boolean =>
  value === true || value === false || value === 'yes' || value === 'no';

const usableIpquerySecurity = (security: JsonObject | undefined): boolean =>
  Boolean(
    security &&
    ([
      'tor',
      'is_tor',
      'proxy',
      'is_proxy',
      'vpn',
      'is_vpn',
      'hosting',
      'is_datacenter',
      'abuser',
      'is_abuser',
    ].some((key) => explicitBooleanEvidence(security[key])) ||
      (typeof security.risk_score === 'number' && Number.isFinite(security.risk_score))),
  );

const privateIpv4 = (address: string): boolean => {
  const [first = -1, second = -1] = address.split('.').map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 198 && (second === 18 || second === 19))
  );
};

const privateAddress = (address: string): boolean => {
  if (isIP(address) === 4) return privateIpv4(address);
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized)
  );
};

const redactedPrefix = (address: string | undefined): string | undefined => {
  if (!address || isIP(address) === 0 || isIpv4MappedIpv6Address(address)) return undefined;
  try {
    return transientEgressAddressPrefix(address);
  } catch {
    return undefined;
  }
};

const languageBase = (language: string): string => language.split(/[-_]/)[0]?.toLowerCase() ?? '';

const languageMatchesCountry = (languageTag: string, countryCode: string): boolean =>
  (COUNTRY_LANGUAGES[countryCode] ?? []).some(
    (countryLanguage) => languageBase(countryLanguage) === languageBase(languageTag),
  );

const normalizedSystemLanguages = (languages: readonly string[]): string[] => {
  return [...new Set(languages.map((language) => language.trim()).filter(Boolean))];
};

const defaultRequestText = async (
  cliEnvironment: () => Record<string, null | string>,
  url: string,
  signal?: AbortSignal,
): Promise<string> =>
  runWindowsCommand(
    'curl.exe',
    [
      '--silent',
      '--show-error',
      '--connect-timeout',
      '5',
      '--max-time',
      '9',
      '--header',
      'Accept: application/json, text/plain;q=0.9',
      url,
    ],
    { env: cliEnvironment(), maxBuffer: 128 * 1024, signal, timeout: 10_000 },
  );

const hasGlobalIpv6 = (): boolean =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .some(
      (entry) =>
        entry.family === 'IPv6' &&
        !entry.internal &&
        isIP(entry.address) === 6 &&
        !privateAddress(entry.address),
    );

const makeCheck = (
  id: NetworkEnvironmentCheck['id'],
  label: string,
  status: NetworkEnvironmentCheck['status'],
  detail: string,
  source: string,
  checkedAt: number,
  target: string,
  transport: NetworkEnvironmentCheck['transport'],
  freshness: NetworkEnvironmentCheck['freshness'] = 'live',
  confidence: NetworkEnvironmentCheck['confidence'] = status === 'passed' || status === 'risk'
    ? 'medium'
    : 'unknown',
): NetworkEnvironmentCheck => ({
  authority: 'advisory-only',
  checkedAt,
  confidence,
  detail,
  freshness,
  id,
  label,
  networkScope: 'application',
  process: 'network-diagnostics',
  source,
  status,
  target,
  transport,
});

const securityIssues = (security: JsonObject | undefined): NetworkEnvironmentIssue[] => {
  const signals = [
    [['tor', 'is_tor'], 'Tor 地址观察', '该公网地址被第三方情报标记为 Tor。'],
    [['proxy', 'is_proxy'], '代理地址观察', '该公网地址被第三方情报标记为公开代理。'],
    [['vpn', 'is_vpn'], 'VPN 地址观察', '该公网地址被第三方情报标记为 VPN。'],
    [['hosting', 'is_datacenter'], '机房地址观察', '该公网地址被第三方情报标记为托管或机房网络。'],
    [['abuser', 'is_abuser'], '滥用记录', '该公网地址被第三方情报标记为近期存在滥用信号。'],
  ] as const;
  const issues: NetworkEnvironmentIssue[] = signals.flatMap(([keys, title, detail]) =>
    bool(security, ...keys)
      ? [{ detail, kind: 'ip-hygiene' as const, severity: 'high' as const, title }]
      : [],
  );
  const riskScore = security?.risk_score;
  if (
    issues.length === 0 &&
    typeof riskScore === 'number' &&
    Number.isFinite(riskScore) &&
    riskScore >= 50
  ) {
    issues.push({
      detail: `第三方情报给出的出口风险分为 ${Math.round(riskScore)}/100，但未返回更具体的分类。`,
      kind: 'ip-hygiene',
      severity: riskScore >= 75 ? 'high' : 'warning',
      title: 'IP 风险分较高',
    });
  }
  return issues;
};

interface DnsObservation {
  detail: string;
  status: 'passed' | 'risk' | 'unknown';
}

const KNOWN_PRIVACY_DNS =
  /adguard|cisco|cloudflare|control d|google|mullvad|nextdns|opendns|quad9/i;

const waitForUncancellableWork = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
};

const sameNetworkOperator = (
  resolverProvider: string,
  observedNetworkProvider?: string,
): boolean => {
  if (!observedNetworkProvider) return false;
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/\b(?:corp(?:oration)?|enterprises?|group|inc|llc|ltd|limited)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const resolver = normalize(resolverProvider);
  const exit = normalize(observedNetworkProvider);
  return (
    resolver.length >= 4 && exit.length >= 4 && (resolver.includes(exit) || exit.includes(resolver))
  );
};

const parseAuthoritativeDns = (
  records: string[][],
  referenceCountryCode?: string,
  referenceNetworkProvider?: string,
): DnsObservation => {
  const from = records.flat().find((value) => value.trim().startsWith('FROM:'));
  const match = from
    ? /^FROM:\s+([^\s#]+)#\d+\s+(.+?)\s+\(([A-Z]{2})\)$/i.exec(from.trim())
    : undefined;
  if (!match) {
    return {
      detail: '权威 DNS 测试没有返回可识别的递归解析器身份，无法完成端点限定的 DNS 对照。',
      status: 'unknown',
    };
  }
  const [, address = '', rawProvider = '未知服务商', rawCountry = ''] = match;
  const countryCode = rawCountry.toUpperCase();
  const provider = thirdPartyText(rawProvider, 100) ?? '未知服务商';
  const resolver = `${redactedPrefix(address) ?? '地址已隐藏'} · ${provider} · ${countryCode}`;
  if (!referenceCountryCode) {
    return {
      detail: `dnscheck.tools 观察到递归解析器 ${resolver}，但 api.ipquery.io 的地区证据未知，无法完成这两个目标之间的对照。`,
      status: 'unknown',
    };
  }
  if (countryCode !== referenceCountryCode) {
    return {
      detail: `dnscheck.tools 观察到递归解析器 ${resolver}；与 api.ipquery.io 观察到的国家 ${referenceCountryCode} 不一致。该差异只描述这两个目标，不证明提供商端点路由。`,
      status: 'risk',
    };
  }
  if (KNOWN_PRIVACY_DNS.test(provider) || sameNetworkOperator(provider, referenceNetworkProvider)) {
    return {
      detail: `dnscheck.tools 观察到递归解析器 ${resolver}；它与 api.ipquery.io 的国家一致，且解析服务商属于已知公共解析服务或与该地址运营商一致。`,
      status: 'passed',
    };
  }
  return {
    detail: `dnscheck.tools 观察到递归解析器 ${resolver}；它与 api.ipquery.io 的国家一致，但服务商归属关系无法确认。该结果不能证明提供商端点是否使用同一路径。`,
    status: 'unknown',
  };
};

const parseAddress = (value: string): string | undefined =>
  value.match(/(?<![\d.:])(?:\d{1,3}\.){3}\d{1,3}(?![\d.:])/)?.[0];

const PUBLIC_ADDRESS_SCOPE_STATEMENT =
  '该结果只描述此收集进程访问该观察端点时的公网地址，不证明 Anthropic、OpenAI 或其他提供商端点使用相同公网地址。';

const publicAddressObservation = (
  input: Omit<
    NetworkPublicAddressObservation,
    'networkScope' | 'process' | 'statement' | 'transport'
  >,
): NetworkPublicAddressObservation => ({
  ...input,
  networkScope: 'application',
  process: 'network-diagnostics',
  statement: PUBLIC_ADDRESS_SCOPE_STATEMENT,
  transport: 'curl-cli',
});

export class NetworkEnvironmentRiskProbe {
  private pendingAuthoritativeDnsLookup?: Promise<string[][]>;
  private readonly globalIpv6Available: () => boolean;
  private readonly now: () => number;
  private readonly requestJson: (url: string, signal?: AbortSignal) => Promise<unknown>;
  private readonly requestText: (url: string, signal?: AbortSignal) => Promise<string>;
  private readonly resolveTxt: (hostname: string, signal?: AbortSignal) => Promise<string[][]>;

  public constructor(private readonly options: NetworkEnvironmentRiskProbeOptions) {
    this.now = options.now ?? Date.now;
    const cliEnvironment = options.cliEnvironment ?? (() => ({}));
    this.requestText =
      options.requestText ??
      (options.requestJson
        ? async () => {
            throw new Error('测试未配置文本出口探测。');
          }
        : (url, signal) => defaultRequestText(cliEnvironment, url, signal));
    this.requestJson =
      options.requestJson ??
      (async (url, signal) => JSON.parse(await this.requestText(url, signal)) as unknown);
    this.resolveTxt =
      options.resolveTxt ??
      (options.requestJson
        ? async () => {
            throw new Error('测试未配置权威 DNS 探测。');
          }
        : async (hostname, signal) => {
            signal?.throwIfAborted();
            const records = await nodeResolveTxt(hostname);
            signal?.throwIfAborted();
            return records;
          });
    this.globalIpv6Available = options.globalIpv6Available ?? hasGlobalIpv6;
  }

  private resolveAuthoritativeDns(signal?: AbortSignal): Promise<string[][]> {
    const currentLookup = this.pendingAuthoritativeDnsLookup;
    if (currentLookup) return waitForUncancellableWork(currentLookup, signal);

    const token = randomBytes(4).toString('hex');
    const lookup = Promise.resolve().then(() => this.resolveTxt(`${token}.test.dnscheck.tools`));
    this.pendingAuthoritativeDnsLookup = lookup;
    const clearLookup = (): void => {
      if (this.pendingAuthoritativeDnsLookup === lookup) {
        this.pendingAuthoritativeDnsLookup = undefined;
      }
    };
    void lookup.then(clearLookup, clearLookup);
    return waitForUncancellableWork(lookup, signal);
  }

  // Keep the evidence collection and final fail-closed verdict in one transaction so a partial
  // helper result can never be published as a completed assessment.
  // eslint-disable-next-line max-lines-per-function
  public async run(signal?: AbortSignal): Promise<NetworkEnvironmentAssessment> {
    const checkedAt = this.now();
    const settings = this.options.settings();
    const localTimezone =
      this.options.timezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown';
    const systemLanguages = normalizedSystemLanguages(this.options.systemLanguages());
    const localLanguage = systemLanguages[0] ?? 'unknown';
    const dnsServers = (this.options.readDnsServers ?? getServers)().filter(
      (address) => isIP(address) !== 0,
    );
    const base = {
      checkedAt,
      ...(settings.cliLanguages ? { cliLanguages: [...settings.cliLanguages] } : {}),
      ...(settings.cliTimezone ? { cliTimezone: settings.cliTimezone } : {}),
      localLanguage,
      localTimezone,
    };

    const ipqueryEndpoint = 'https://api.ipquery.io/?format=json';
    let observedAddress: string | undefined;
    let countryCode: string | undefined;
    let observedTimezone: string | undefined;
    let observedNetworkProvider: string | undefined;
    let security: JsonObject | undefined;
    const issues: NetworkEnvironmentIssue[] = [];
    const publicAddressObservations: NetworkPublicAddressObservation[] = [];
    const checks: NetworkEnvironmentCheck[] = [];
    try {
      const value = await this.requestJson(ipqueryEndpoint, signal);
      signal?.throwIfAborted();
      if (!isObject(value) || value.success === false) {
        throw new Error('api.ipquery.io 公网地址观察响应无效。');
      }
      observedAddress = text(value.ip, 64);
      if (!observedAddress || isIP(observedAddress) === 0) {
        throw new Error('api.ipquery.io 没有返回有效公网地址。');
      }
      if (isIpv4MappedIpv6Address(observedAddress)) {
        observedAddress = undefined;
        throw new Error('api.ipquery.io 返回了 IPv4 映射 IPv6 地址，不能作为独立 IPv6 证据。');
      }
      const location = isObject(value.location) ? value.location : value;
      const timezoneRecord = isObject(location.timezone) ? location.timezone : undefined;
      const connection = isObject(value.isp)
        ? value.isp
        : isObject(value.connection)
          ? value.connection
          : undefined;
      security = isObject(value.risk)
        ? value.risk
        : isObject(value.security)
          ? value.security
          : undefined;
      countryCode = text(location.country_code, 2)?.toUpperCase();
      observedTimezone = thirdPartyText(timezoneRecord?.id ?? location.timezone, 128);
      observedNetworkProvider = thirdPartyText(connection?.isp ?? connection?.org, 160);
      issues.push(...securityIssues(security));
      const ipqueryCheckedAt = this.now();
      const observation = publicAddressObservation({
        addressFamily: isIP(observedAddress) === 6 ? 'ipv6' : 'ipv4',
        addressPrefix: redactedPrefix(observedAddress),
        checkedAt: ipqueryCheckedAt,
        confidence: 'medium',
        ...(countryCode ? { countryCode } : {}),
        ...(thirdPartyText(location.country, 120)
          ? { countryName: thirdPartyText(location.country, 120) }
          : {}),
        detail:
          countryCode && observedTimezone
            ? `api.ipquery.io 观察到国家 ${countryCode} 和时区 ${observedTimezone}。`
            : 'api.ipquery.io 返回了公网地址，但地区或时区证据不完整。',
        endpoint: ipqueryEndpoint,
        freshness: 'live',
        ...(observedNetworkProvider ? { networkProvider: observedNetworkProvider } : {}),
        observationProvider: 'IPQuery',
        sourceAgreement: 'single-source',
        state: 'complete',
        ...(observedTimezone ? { timezone: observedTimezone } : {}),
      });
      publicAddressObservations.push(observation);
      checks.push(
        makeCheck(
          'public-address-ipquery',
          '公网地址观察（api.ipquery.io）',
          countryCode && observedTimezone ? 'passed' : 'unknown',
          `${observation.detail}${PUBLIC_ADDRESS_SCOPE_STATEMENT}`,
          'api.ipquery.io',
          ipqueryCheckedAt,
          ipqueryEndpoint,
          'curl-cli',
        ),
      );
    } catch (error) {
      signal?.throwIfAborted();
      const detail = `api.ipquery.io 公网地址观察不可用：${thirdPartyError(error, 160)}`;
      const ipqueryCheckedAt = this.now();
      publicAddressObservations.push(
        publicAddressObservation({
          checkedAt: ipqueryCheckedAt,
          confidence: 'unknown',
          detail,
          endpoint: ipqueryEndpoint,
          freshness: 'unknown',
          observationProvider: 'IPQuery',
          sourceAgreement: 'not-comparable',
          state: 'unavailable',
        }),
      );
      checks.push(
        makeCheck(
          'public-address-ipquery',
          '公网地址观察（api.ipquery.io）',
          'unknown',
          `${detail}${PUBLIC_ADDRESS_SCOPE_STATEMENT}`,
          'api.ipquery.io',
          ipqueryCheckedAt,
          ipqueryEndpoint,
          'curl-cli',
          'unknown',
        ),
      );
    }

    if (observedAddress) {
      const reputationResults = await Promise.allSettled([
        this.requestJson(
          `https://proxycheck.io/v2/${encodeURIComponent(observedAddress)}?risk=1&vpn=1&asn=1`,
          signal,
        ),
        this.requestJson(
          `https://api.stopforumspam.org/api?json=1&ip=${encodeURIComponent(observedAddress)}`,
          signal,
        ),
      ]);
      signal?.throwIfAborted();
      const reputationSources: string[] = usableIpquerySecurity(security) ? ['IPQuery'] : [];
      const proxycheckValue = reputationResults[0];
      if (proxycheckValue?.status === 'fulfilled' && isObject(proxycheckValue.value)) {
        const record = isObject(proxycheckValue.value[observedAddress])
          ? (proxycheckValue.value[observedAddress] as JsonObject)
          : undefined;
        const proxyRisk = typeof record?.risk === 'number' ? record.risk : Number(record?.risk);
        const hasProxyVerdict = record?.proxy === 'yes' || record?.proxy === 'no';
        if (record && (hasProxyVerdict || Number.isFinite(proxyRisk))) {
          reputationSources.push('ProxyCheck');
          if (record.proxy === 'yes' || (Number.isFinite(proxyRisk) && proxyRisk >= 60)) {
            issues.push({
              detail: `ProxyCheck 将 api.ipquery.io 观察到的地址标记为代理或较高风险（风险分 ${Number.isFinite(proxyRisk) ? Math.round(proxyRisk) : '未知'}/100）。该情报不代表提供商端点的公网地址。`,
              kind: 'ip-hygiene',
              severity: Number.isFinite(proxyRisk) && proxyRisk < 75 ? 'warning' : 'high',
              title: '地址信誉情报风险',
            });
          }
        }
      }
      const spamValue = reputationResults[1];
      if (spamValue?.status === 'fulfilled' && isObject(spamValue.value)) {
        const record = isObject(spamValue.value.ip) ? spamValue.value.ip : undefined;
        if (typeof record?.appears === 'number') {
          reputationSources.push('Stop Forum Spam');
          if (record.appears > 0) {
            issues.push({
              detail: `Stop Forum Spam 记录到 api.ipquery.io 观察到的地址出现过滥用报告（频次 ${typeof record.frequency === 'number' ? record.frequency : '未知'}）。该情报不代表提供商端点的公网地址。`,
              kind: 'ip-hygiene',
              severity: 'high',
              title: '地址存在公开滥用记录',
            });
          }
        }
      }
      const reputationRisk = issues.some((issue) => issue.kind === 'ip-hygiene');
      const reputationCheckedAt = this.now();
      checks.push(
        makeCheck(
          'ip-reputation',
          '地址信誉（api.ipquery.io 观察）',
          reputationRisk ? 'risk' : reputationSources.length >= 2 ? 'passed' : 'unknown',
          reputationRisk
            ? '至少一个已完成的独立情报源对 api.ipquery.io 观察到的地址返回风险信号。该结果不代表提供商端点。'
            : reputationSources.length >= 2
              ? `已有 ${reputationSources.length} 个独立情报源完成检查，未返回已知风险标记；该结果仅适用于 api.ipquery.io 观察到的地址。`
              : '独立地址情报源返回不足，信誉状态未知；这不影响提供商端点连接结论。',
          reputationSources.length > 0 ? reputationSources.join(' + ') : '无可用情报源',
          reputationCheckedAt,
          'https://proxycheck.io/v2/{redacted-address} + https://api.stopforumspam.org/api',
          'curl-cli',
          reputationSources.length > 0 ? 'live' : 'unknown',
          reputationSources.length >= 2 ? 'medium' : 'unknown',
        ),
      );
    } else {
      checks.push(
        makeCheck(
          'ip-reputation',
          '地址信誉（api.ipquery.io 观察）',
          'unknown',
          '没有可用的端点限定公网地址，无法查询第三方地址信誉；这不影响提供商端点连接结论。',
          '无可用情报源',
          this.now(),
          'https://proxycheck.io/v2/{redacted-address} + https://api.stopforumspam.org/api',
          'not-collected',
          'unknown',
        ),
      );
    }

    const ipipEndpoint = 'https://myip.ipip.net';
    let ipipAddress: string | undefined;
    try {
      ipipAddress = parseAddress(await this.requestText(ipipEndpoint, signal));
    } catch {
      signal?.throwIfAborted();
      // A failed third-party source remains an endpoint-specific unavailable observation.
    }
    const ipipCheckedAt = this.now();
    if (!ipipAddress || isIP(ipipAddress) !== 4) {
      const detail = 'myip.ipip.net 未返回可识别的 IPv4 公网地址。';
      publicAddressObservations.push(
        publicAddressObservation({
          checkedAt: ipipCheckedAt,
          confidence: 'unknown',
          detail,
          endpoint: ipipEndpoint,
          freshness: 'unknown',
          observationProvider: 'IPIP',
          sourceAgreement: 'not-comparable',
          state: 'unavailable',
        }),
      );
      checks.push(
        makeCheck(
          'public-address-ipip',
          '公网地址观察（myip.ipip.net）',
          'unknown',
          `${detail}${PUBLIC_ADDRESS_SCOPE_STATEMENT}`,
          'myip.ipip.net',
          ipipCheckedAt,
          ipipEndpoint,
          'curl-cli',
          'unknown',
        ),
      );
    } else {
      const ipipPrefix = redactedPrefix(ipipAddress);
      const ipqueryObservation = publicAddressObservations.find(
        (observation) => observation.observationProvider === 'IPQuery',
      );
      const comparable =
        ipqueryObservation?.state === 'complete' && isIP(observedAddress ?? '') === 4;
      const agrees = comparable && ipqueryObservation.addressPrefix === ipipPrefix;
      const sourceAgreement = comparable
        ? agrees
          ? ('corroborated' as const)
          : ('mixed' as const)
        : ('not-comparable' as const);
      if (ipqueryObservation) {
        const index = publicAddressObservations.indexOf(ipqueryObservation);
        publicAddressObservations[index] = { ...ipqueryObservation, sourceAgreement };
      }
      const detail = !comparable
        ? observedAddress && isIP(observedAddress) === 6
          ? `myip.ipip.net 观察到 ${ipipPrefix ?? '一个 IPv4 网段'}；api.ipquery.io 返回的是 IPv6，地址族不同，不能比较脱敏网段。两者都不代表提供商端点的公网地址。`
          : `myip.ipip.net 观察到 ${ipipPrefix ?? '一个 IPv4 网段'}；api.ipquery.io 的 IPv4 证据不可用，不能比较脱敏网段。该结果不代表提供商端点的公网地址。`
        : agrees
          ? `myip.ipip.net 观察到 ${ipipPrefix ?? '一个 IPv4 网段'}，与 api.ipquery.io 的脱敏 /24 网段相同。`
          : `myip.ipip.net 观察到 ${ipipPrefix ?? '一个 IPv4 网段'}，与 api.ipquery.io 的脱敏 /24 网段不同。目标分流可导致这种差异；两者都不代表提供商端点的公网地址。`;
      publicAddressObservations.push(
        publicAddressObservation({
          addressFamily: 'ipv4',
          addressPrefix: ipipPrefix,
          checkedAt: ipipCheckedAt,
          confidence: 'medium',
          detail,
          endpoint: ipipEndpoint,
          freshness: 'live',
          observationProvider: 'IPIP',
          sourceAgreement,
          state: 'complete',
        }),
      );
      checks.push(
        makeCheck(
          'public-address-ipip',
          '公网地址观察（myip.ipip.net）',
          'passed',
          `${detail}${PUBLIC_ADDRESS_SCOPE_STATEMENT}`,
          'myip.ipip.net',
          ipipCheckedAt,
          ipipEndpoint,
          'curl-cli',
        ),
      );
    }

    let dnsObservation: DnsObservation;
    let dnsCollected = true;
    try {
      dnsObservation = parseAuthoritativeDns(
        await this.resolveAuthoritativeDns(signal),
        countryCode,
        observedNetworkProvider,
      );
    } catch (error) {
      signal?.throwIfAborted();
      dnsCollected = false;
      dnsObservation = {
        detail: `权威 DNS 出口测试未完成：${thirdPartyError(error, 140)}`,
        status: 'unknown',
      };
    }
    const dnsCheckedAt = this.now();
    checks.push(
      makeCheck(
        'dns-authoritative',
        '权威 DNS 观察',
        dnsObservation.status,
        dnsObservation.detail,
        'dnscheck.tools',
        dnsCheckedAt,
        '*.test.dnscheck.tools TXT',
        'system-dns',
        dnsCollected ? 'live' : 'unknown',
        dnsObservation.status === 'passed' || dnsObservation.status === 'risk'
          ? 'medium'
          : 'unknown',
      ),
    );
    if (dnsObservation.status === 'risk') {
      issues.push({
        detail: dnsObservation.detail,
        kind: 'dns-egress',
        severity: 'high',
        title: 'DNS 观察国家不一致',
      });
    }
    const publicDns = dnsServers.filter((address) => !privateAddress(address));
    if (publicDns.length > 0) {
      issues.push({
        detail: `本机还配置了 ${publicDns.length} 个公网 DNS 地址；请结合 dnscheck.tools 的目标限定观察复核。该配置不证明提供商端点使用或绕过某条路由。`,
        kind: 'dns-egress',
        severity: 'warning',
        title: '存在本机公网 DNS 配置',
      });
    }

    const ipv6Endpoint = 'https://api6.ipify.org?format=json';
    if (!this.globalIpv6Available()) {
      checks.push(
        makeCheck(
          'ipv6-public-address',
          'IPv6 公网地址观察',
          'passed',
          '本机接口快照没有可路由的全局 IPv6 地址，因此本次未向 api6.ipify.org 发起 IPv6 观察。',
          'Windows 网络接口',
          this.now(),
          'Windows network interfaces',
          'local-system',
          'live',
          'high',
        ),
      );
    } else {
      try {
        const ipv6Value = await this.requestJson(ipv6Endpoint, signal);
        const ipv6Address = isObject(ipv6Value) ? text(ipv6Value.ip, 64) : undefined;
        if (!ipv6Address || isIP(ipv6Address) !== 6) {
          throw new Error('api6.ipify.org 未返回有效 IPv6 地址。');
        }
        if (isIpv4MappedIpv6Address(ipv6Address)) {
          throw new Error('api6.ipify.org 返回了 IPv4 映射 IPv6 地址，不能作为独立 IPv6 证据。');
        }
        const ipv6Prefix = redactedPrefix(ipv6Address);
        const ipqueryIpv6 = publicAddressObservations.find(
          (observation) =>
            observation.observationProvider === 'IPQuery' &&
            observation.state === 'complete' &&
            observation.addressFamily === 'ipv6' &&
            Boolean(observation.addressPrefix),
        );
        const comparable = Boolean(ipqueryIpv6 && ipv6Prefix);
        const agrees = comparable && ipqueryIpv6?.addressPrefix === ipv6Prefix;
        const sourceAgreement = comparable
          ? agrees
            ? ('corroborated' as const)
            : ('mixed' as const)
          : ('not-comparable' as const);
        if (ipqueryIpv6) {
          const index = publicAddressObservations.indexOf(ipqueryIpv6);
          publicAddressObservations[index] = { ...ipqueryIpv6, sourceAgreement };
        }
        const detail = comparable
          ? agrees
            ? `api6.ipify.org 观察到 ${ipv6Prefix ?? '一个 IPv6 网段'}，与 api.ipquery.io 的脱敏 /64 网段相同。`
            : `api6.ipify.org 观察到 ${ipv6Prefix ?? '一个 IPv6 网段'}，与 api.ipquery.io 的脱敏 /64 网段不同。目标分流可导致这种差异；两者都不代表提供商端点的公网地址。`
          : `api6.ipify.org 观察到 ${ipv6Prefix ?? '一个 IPv6 网段'}。IPv4 与 IPv6 按地址族分别记录，不能据此推断提供商端点路由。`;
        const ipv6CheckedAt = this.now();
        publicAddressObservations.push(
          publicAddressObservation({
            addressFamily: 'ipv6',
            addressPrefix: ipv6Prefix,
            checkedAt: ipv6CheckedAt,
            confidence: 'medium',
            detail,
            endpoint: ipv6Endpoint,
            freshness: 'live',
            observationProvider: 'ipify',
            sourceAgreement,
            state: 'complete',
          }),
        );
        checks.push(
          makeCheck(
            'ipv6-public-address',
            'IPv6 公网地址观察（api6.ipify.org）',
            'passed',
            `${detail}${PUBLIC_ADDRESS_SCOPE_STATEMENT}`,
            'api6.ipify.org',
            ipv6CheckedAt,
            ipv6Endpoint,
            'curl-cli',
          ),
        );
        issues.push({
          detail:
            '本次收集到了单独的 IPv6 公网地址观察；请按地址族查看，不能将它归因于提供商端点。',
          kind: 'ipv6-egress',
          severity: 'info',
          title: 'IPv6 地址族证据已单独记录',
        });
      } catch (error) {
        signal?.throwIfAborted();
        const detail = `api6.ipify.org 的 IPv6 公网地址观察未完成：${thirdPartyError(error, 120)}`;
        const ipv6CheckedAt = this.now();
        publicAddressObservations.push(
          publicAddressObservation({
            checkedAt: ipv6CheckedAt,
            confidence: 'unknown',
            detail,
            endpoint: ipv6Endpoint,
            freshness: 'unknown',
            observationProvider: 'ipify',
            sourceAgreement: 'not-comparable',
            state: 'unavailable',
          }),
        );
        checks.push(
          makeCheck(
            'ipv6-public-address',
            'IPv6 公网地址观察（api6.ipify.org）',
            'unknown',
            `${detail}${PUBLIC_ADDRESS_SCOPE_STATEMENT}`,
            'api6.ipify.org',
            ipv6CheckedAt,
            ipv6Endpoint,
            'curl-cli',
            'unknown',
          ),
        );
      }
    }

    checks.push(
      makeCheck(
        'stun-public-address',
        'STUN/WebRTC 公网地址观察',
        'unavailable',
        '本次主进程预检没有启用独立 WebRTC STUN 收集，因此该证据不可用。STUN 即使可用也只描述 WebRTC 路径，不代表应用、CLI 或提供商 HTTP 端点的公网地址。',
        'WebRTC STUN（本次未收集）',
        this.now(),
        'WebRTC STUN public-address collection',
        'not-collected',
        'unknown',
      ),
    );

    if (observedTimezone) {
      const mismatch =
        localTimezone !== observedTimezone && settings.cliTimezone !== observedTimezone;
      checks.push(
        makeCheck(
          'timezone',
          '时区一致性',
          mismatch ? 'risk' : 'passed',
          mismatch
            ? `本机时区 ${localTimezone} 与 api.ipquery.io 观察地区的时区 ${observedTimezone} 不一致。该差异不影响提供商连接结论。`
            : `有效 CLI 时区与 api.ipquery.io 观察地区的时区 ${observedTimezone} 一致。`,
          '本机 Intl + IPQuery',
          this.now(),
          `local Intl timezone + ${ipqueryEndpoint}`,
          'derived',
          'live',
          'medium',
        ),
      );
      if (mismatch) {
        issues.push({
          detail: `本机时区 ${localTimezone} 与 api.ipquery.io 观察地区的时区 ${observedTimezone} 不一致。修改仅注入未来 CLI 进程，且不影响提供商连接结论。`,
          kind: 'timezone-mismatch',
          severity: 'warning',
          suggestedTimezone: observedTimezone,
          title: '时区不一致',
        });
      }
    } else {
      checks.push(
        makeCheck(
          'timezone',
          '时区一致性',
          'unknown',
          'api.ipquery.io 未提供可用时区，无法完成此端点限定的时区对照。',
          '本机 Intl + IPQuery',
          this.now(),
          `local Intl timezone + ${ipqueryEndpoint}`,
          'derived',
          'unknown',
        ),
      );
    }

    const countryLanguages = countryCode ? COUNTRY_LANGUAGES[countryCode] : undefined;
    const displayedSystemLanguages = systemLanguages.join('、') || '未知（Windows 未返回首选语言）';
    if (!countryCode || !countryLanguages) {
      checks.push(
        makeCheck(
          'language',
          '系统语言参考',
          'unknown',
          `仅供参考：Windows 首选语言为 ${displayedSystemLanguages}；api.ipquery.io 观察国家或常用语言映射未知，不影响提供商网络可用性判定。`,
          'Windows 首选语言 + IPQuery',
          this.now(),
          `Windows preferred languages + ${ipqueryEndpoint}`,
          'derived',
          countryCode ? 'live' : 'unknown',
          'low',
        ),
      );
    } else {
      const matches = systemLanguages.some((language) =>
        languageMatchesCountry(language, countryCode),
      );
      checks.push(
        makeCheck(
          'language',
          '系统语言参考',
          matches ? 'passed' : 'unknown',
          matches
            ? `仅供参考：Windows 首选语言 ${displayedSystemLanguages} 中至少一项与 api.ipquery.io 观察国家 ${countryCode} 的常用语言匹配。`
            : `仅供参考：Windows 首选语言 ${displayedSystemLanguages} 与 api.ipquery.io 观察国家 ${countryCode} 的常用语言未匹配；这不代表提供商网络不可用。`,
          'Windows 首选语言 + IPQuery',
          this.now(),
          `Windows preferred languages + ${ipqueryEndpoint}`,
          'derived',
          'live',
          matches ? 'medium' : 'low',
        ),
      );
    }

    const criticalChecks = checks.filter(
      (check) => check.id !== 'language' && check.id !== 'stun-public-address',
    );
    const unknownChecks = criticalChecks.filter((check) => check.status === 'unknown');
    const evidenceStatus =
      unknownChecks.length === 0
        ? 'complete'
        : unknownChecks.length === criticalChecks.length
          ? 'unavailable'
          : 'partial';
    if (unknownChecks.length > 0) {
      issues.push({
        detail: `以下关键证据未完成：${unknownChecks.map((check) => check.label).join('、')}。在补齐前不能判断为低风险。`,
        kind: 'evidence-incomplete',
        severity: 'info',
        title: '风险证据不完整',
      });
    }
    const riskLevel = issues.some((issue) => issue.severity === 'high')
      ? 'high'
      : issues.some((issue) => issue.severity === 'warning') ||
          checks.some((check) => check.status === 'risk')
        ? 'medium'
        : evidenceStatus === 'complete'
          ? 'low'
          : 'unknown';
    const dnsStatus =
      dnsObservation.status === 'passed' && publicDns.length === 0
        ? 'consistent'
        : dnsObservation.status === 'risk' || publicDns.length > 0
          ? 'review'
          : 'unknown';
    return {
      ...base,
      checks,
      dnsDetail: dnsObservation.detail,
      dnsStatus,
      evidenceStatus,
      issues,
      publicAddressObservations,
      riskLevel,
      summary:
        riskLevel === 'high'
          ? '目标限定的公网地址、DNS 或环境辅助证据包含高风险信号；这些信号只供单独审阅，不授予或拒绝提供商访问。'
          : riskLevel === 'medium'
            ? '目标限定的公网地址、DNS 或环境辅助证据需要留意；这些信号只供单独审阅，不授予或拒绝提供商访问。'
            : riskLevel === 'unknown'
              ? '部分目标限定的环境辅助证据不可用；这不代表提供商端点不可达。'
              : '本次目标限定的公网地址、DNS、IPv6 与时区辅助观察未返回已知风险；系统语言对照仅供参考。',
    };
  }
}
