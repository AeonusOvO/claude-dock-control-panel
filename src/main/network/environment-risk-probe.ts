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
} from '../../shared/contracts';
import { runWindowsCommand } from '../infra/windows-command';

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

const bool = (record: JsonObject | undefined, ...keys: string[]): boolean =>
  keys.some((key) => record?.[key] === true || record?.[key] === 'yes');

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
  if (!address) return undefined;
  if (isIP(address) === 4) {
    const parts = address.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : undefined;
  }
  if (isIP(address) === 6) return `${address.split(':').slice(0, 3).join(':')}::/48`;
  return undefined;
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
): NetworkEnvironmentCheck => ({ detail, id, label, source, status });

const securityIssues = (security: JsonObject | undefined): NetworkEnvironmentIssue[] => {
  const signals = [
    [['tor', 'is_tor'], 'Tor 出口', '当前出口被第三方情报标记为 Tor。'],
    [['proxy', 'is_proxy'], '代理出口', '当前出口被第三方情报标记为公开代理。'],
    [['vpn', 'is_vpn'], 'VPN 出口', '当前出口被第三方情报标记为 VPN。'],
    [['hosting', 'is_datacenter'], '机房出口', '当前出口被第三方情报标记为托管或机房网络。'],
    [['abuser', 'is_abuser'], '滥用记录', '当前出口被第三方情报标记为近期存在滥用信号。'],
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

const sameNetworkOperator = (resolverProvider: string, exitProvider?: string): boolean => {
  if (!exitProvider) return false;
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/\b(?:corp(?:oration)?|enterprises?|group|inc|llc|ltd|limited)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const resolver = normalize(resolverProvider);
  const exit = normalize(exitProvider);
  return (
    resolver.length >= 4 && exit.length >= 4 && (resolver.includes(exit) || exit.includes(resolver))
  );
};

const parseAuthoritativeDns = (
  records: string[][],
  exitCountryCode?: string,
  exitProvider?: string,
): DnsObservation => {
  const from = records.flat().find((value) => value.trim().startsWith('FROM:'));
  const match = from
    ? /^FROM:\s+([^\s#]+)#\d+\s+(.+?)\s+\(([A-Z]{2})\)$/i.exec(from.trim())
    : undefined;
  if (!match) {
    return {
      detail: '权威 DNS 测试没有返回可识别的递归解析器身份，无法判断 DNS 是否泄露。',
      status: 'unknown',
    };
  }
  const [, address = '', provider = '未知服务商', rawCountry = ''] = match;
  const countryCode = rawCountry.toUpperCase();
  const resolver = `${redactedPrefix(address) ?? '地址已隐藏'} · ${provider.slice(0, 100)} · ${countryCode}`;
  if (!exitCountryCode) {
    return {
      detail: `权威服务器观察到 DNS 解析出口 ${resolver}，但模型出口地区未知，无法完成对照。`,
      status: 'unknown',
    };
  }
  if (countryCode !== exitCountryCode) {
    return {
      detail: `权威服务器观察到 DNS 解析出口 ${resolver}；与模型出口国家 ${exitCountryCode} 不一致。`,
      status: 'risk',
    };
  }
  if (KNOWN_PRIVACY_DNS.test(provider) || sameNetworkOperator(provider, exitProvider)) {
    return {
      detail: `权威服务器观察到 DNS 解析出口 ${resolver}；国家一致，且解析服务商属于已知公共解析服务或与出口运营商一致。`,
      status: 'passed',
    };
  }
  return {
    detail: `权威服务器观察到 DNS 解析出口 ${resolver}；国家一致，但解析服务商与模型出口的归属关系无法确认，不能判断为无泄露。`,
    status: 'unknown',
  };
};

const parseAddress = (value: string): string | undefined =>
  value.match(/(?<![\d.:])(?:\d{1,3}\.){3}\d{1,3}(?![\d.:])/)?.[0];

export class NetworkEnvironmentRiskProbe {
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

    try {
      const value = await this.requestJson('https://api.ipquery.io/?format=json', signal);
      signal?.throwIfAborted();
      if (!isObject(value) || value.success === false) throw new Error('出口情报响应无效。');
      const exitAddress = text(value.ip, 64);
      if (!exitAddress || isIP(exitAddress) === 0) throw new Error('出口情报没有返回有效 IP。');
      const location = isObject(value.location) ? value.location : value;
      const timezoneRecord = isObject(location.timezone) ? location.timezone : undefined;
      const connection = isObject(value.isp)
        ? value.isp
        : isObject(value.connection)
          ? value.connection
          : undefined;
      const security = isObject(value.risk)
        ? value.risk
        : isObject(value.security)
          ? value.security
          : undefined;
      const countryCode = text(location.country_code, 2)?.toUpperCase();
      const exitTimezone = text(timezoneRecord?.id ?? location.timezone, 128);
      const exitProvider = text(connection?.isp ?? connection?.org, 160);
      const issues = securityIssues(security);
      const checks: NetworkEnvironmentCheck[] = [
        makeCheck(
          'exit-ip',
          '模型出口与地区',
          countryCode && exitTimezone ? 'passed' : 'unknown',
          countryCode && exitTimezone
            ? `已识别模型出口国家 ${countryCode} 和出口时区 ${exitTimezone}。`
            : '已识别模型出口地址，但地区或时区证据不完整。',
          'api.ipquery.io',
        ),
      ];

      const reputationResults = await Promise.allSettled([
        this.requestJson(
          `https://proxycheck.io/v2/${encodeURIComponent(exitAddress)}?risk=1&vpn=1&asn=1`,
          signal,
        ),
        this.requestJson(
          `https://api.stopforumspam.org/api?json=1&ip=${encodeURIComponent(exitAddress)}`,
          signal,
        ),
      ]);
      signal?.throwIfAborted();
      let reputationSources = security ? 1 : 0;
      const proxycheckValue = reputationResults[0];
      if (proxycheckValue?.status === 'fulfilled' && isObject(proxycheckValue.value)) {
        const record = isObject(proxycheckValue.value[exitAddress])
          ? (proxycheckValue.value[exitAddress] as JsonObject)
          : undefined;
        if (record) {
          reputationSources += 1;
          const proxyRisk = typeof record.risk === 'number' ? record.risk : Number(record.risk);
          if (record.proxy === 'yes' || (Number.isFinite(proxyRisk) && proxyRisk >= 60)) {
            issues.push({
              detail: `ProxyCheck 将当前出口标记为代理或较高风险（风险分 ${Number.isFinite(proxyRisk) ? Math.round(proxyRisk) : '未知'}/100）。`,
              kind: 'ip-hygiene',
              severity: Number.isFinite(proxyRisk) && proxyRisk < 75 ? 'warning' : 'high',
              title: '出口代理情报风险',
            });
          }
        }
      }
      const spamValue = reputationResults[1];
      if (spamValue?.status === 'fulfilled' && isObject(spamValue.value)) {
        const record = isObject(spamValue.value.ip) ? spamValue.value.ip : undefined;
        if (typeof record?.appears === 'number') {
          reputationSources += 1;
          if (record.appears > 0) {
            issues.push({
              detail: `Stop Forum Spam 记录到该出口出现过滥用报告（频次 ${typeof record.frequency === 'number' ? record.frequency : '未知'}）。`,
              kind: 'ip-hygiene',
              severity: 'high',
              title: '出口存在公开滥用记录',
            });
          }
        }
      }
      const reputationRisk = issues.some((issue) => issue.kind === 'ip-hygiene');
      checks.push(
        makeCheck(
          'ip-reputation',
          'IP 纯净度',
          reputationRisk ? 'risk' : reputationSources >= 2 ? 'passed' : 'unknown',
          reputationRisk
            ? '至少一个独立 IP 情报源返回风险信号。'
            : reputationSources >= 2
              ? `已有 ${reputationSources} 个独立情报源完成检查，未返回已知风险标记。`
              : '独立 IP 情报源返回不足，不能判断出口纯净。',
          'IPQuery + ProxyCheck + Stop Forum Spam',
        ),
      );

      let directAddress: string | undefined;
      try {
        directAddress = parseAddress(await this.requestText('https://myip.ipip.net', signal));
      } catch {
        // A failed third-party source is represented as unknown below, never as safe.
      }
      if (!directAddress || isIP(directAddress) !== 4) {
        checks.push(
          makeCheck(
            'direct-route',
            '分流直连出口',
            'unknown',
            '分流直连出口未能读取，无法排除浏览器或其他进程绕过模型代理。',
            'myip.ipip.net',
          ),
        );
      } else if (directAddress !== exitAddress) {
        const detail = `分流测试观察到 ${redactedPrefix(directAddress) ?? '另一地址'}，与模型出口 ${redactedPrefix(exitAddress) ?? '当前地址'} 不同；浏览器、OAuth 或未继承代理的进程可能暴露另一地区。`;
        checks.push(makeCheck('direct-route', '分流直连出口', 'risk', detail, 'myip.ipip.net'));
        issues.push({
          detail,
          kind: 'direct-route-mismatch',
          severity: 'high',
          title: '检测到不同的分流出口',
        });
      } else {
        checks.push(
          makeCheck(
            'direct-route',
            '分流直连出口',
            'passed',
            '分流测试与模型请求观察到同一个公网出口。',
            'myip.ipip.net',
          ),
        );
      }

      let dnsObservation: DnsObservation;
      try {
        const token = randomBytes(4).toString('hex');
        dnsObservation = parseAuthoritativeDns(
          await this.resolveTxt(`${token}.test.dnscheck.tools`, signal),
          countryCode,
          exitProvider,
        );
      } catch (error) {
        signal?.throwIfAborted();
        dnsObservation = {
          detail: `权威 DNS 出口测试未完成：${
            error instanceof Error ? error.message.slice(0, 140) : String(error).slice(0, 140)
          }`,
          status: 'unknown',
        };
      }
      checks.push(
        makeCheck(
          'dns-authoritative',
          '权威 DNS 出口',
          dnsObservation.status,
          dnsObservation.detail,
          'dnscheck.tools',
        ),
      );
      if (dnsObservation.status === 'risk') {
        issues.push({
          detail: dnsObservation.detail,
          kind: 'dns-egress',
          severity: 'high',
          title: 'DNS 出口国家不一致',
        });
      }
      const publicDns = dnsServers.filter((address) => !privateAddress(address));
      if (publicDns.length > 0) {
        issues.push({
          detail: `本机还配置了 ${publicDns.length} 个直连公网 DNS 地址；请结合权威 DNS 出口结果复核。`,
          kind: 'dns-egress',
          severity: 'warning',
          title: '存在本机公网 DNS 配置',
        });
      }

      if (!this.globalIpv6Available()) {
        checks.push(
          makeCheck(
            'ipv6-route',
            'IPv6 旁路',
            'passed',
            '本机没有可路由的全局 IPv6 地址，当前未形成 IPv6 旁路条件。',
            'Windows 网络接口',
          ),
        );
      } else {
        try {
          const ipv6Value = await this.requestJson('https://api6.ipify.org?format=json', signal);
          const ipv6Address = isObject(ipv6Value) ? text(ipv6Value.ip, 64) : undefined;
          if (!ipv6Address || isIP(ipv6Address) !== 6) throw new Error('未返回有效 IPv6 出口。');
          const detail = `本机存在全局 IPv6，外部可观察到 ${redactedPrefix(ipv6Address) ?? 'IPv6 出口'}；当前无法证明它与 IPv4 模型出口属于同一路径。`;
          checks.push(makeCheck('ipv6-route', 'IPv6 旁路', 'risk', detail, 'api6.ipify.org'));
          issues.push({
            detail,
            kind: 'ipv6-egress',
            severity: 'warning',
            title: 'IPv6 出口需要复核',
          });
        } catch {
          signal?.throwIfAborted();
          checks.push(
            makeCheck(
              'ipv6-route',
              'IPv6 旁路',
              'unknown',
              '本机存在全局 IPv6，但外部 IPv6 出口检查失败，不能排除 IPv6 旁路。',
              'api6.ipify.org',
            ),
          );
        }
      }

      if (exitTimezone) {
        const mismatch = localTimezone !== exitTimezone && settings.cliTimezone !== exitTimezone;
        checks.push(
          makeCheck(
            'timezone',
            '时区一致性',
            mismatch ? 'risk' : 'passed',
            mismatch
              ? `本机时区 ${localTimezone} 与出口时区 ${exitTimezone} 不一致。`
              : `有效 CLI 时区与出口时区 ${exitTimezone} 一致。`,
            '本机 Intl + IPQuery',
          ),
        );
        if (mismatch) {
          issues.push({
            detail: `检测到本机时区 ${localTimezone} 与出口地区时区 ${exitTimezone} 不一致。修改仅注入未来 CLI 进程。`,
            kind: 'timezone-mismatch',
            severity: 'warning',
            suggestedTimezone: exitTimezone,
            title: '时区不一致',
          });
        }
      } else {
        checks.push(
          makeCheck(
            'timezone',
            '时区一致性',
            'unknown',
            '出口时区未知，无法完成时区一致性检查。',
            '本机 Intl + IPQuery',
          ),
        );
      }

      const countryLanguages = countryCode ? COUNTRY_LANGUAGES[countryCode] : undefined;
      const displayedSystemLanguages =
        systemLanguages.join('、') || '未知（Windows 未返回首选语言）';
      if (!countryCode || !countryLanguages) {
        checks.push(
          makeCheck(
            'language',
            '系统语言参考',
            'unknown',
            `仅供参考：Windows 首选语言为 ${displayedSystemLanguages}；出口国家或常用语言映射未知，不影响网络可用性判定。`,
            'Windows 首选语言 + IPQuery',
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
              ? `仅供参考：Windows 首选语言 ${displayedSystemLanguages} 中至少一项与出口国家 ${countryCode} 的常用语言匹配。`
              : `仅供参考：Windows 首选语言 ${displayedSystemLanguages} 与出口国家 ${countryCode} 的常用语言未匹配；这不代表网络不可用。`,
            'Windows 首选语言 + IPQuery',
          ),
        );
      }

      const unknownChecks = checks.filter(
        (check) => check.status === 'unknown' && check.id !== 'language',
      );
      const evidenceStatus = unknownChecks.length === 0 ? 'complete' : 'partial';
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
        exitAddressPrefix: redactedPrefix(exitAddress),
        ...(countryCode ? { exitCountryCode: countryCode } : {}),
        ...(text(location.country, 120) ? { exitCountryName: text(location.country, 120) } : {}),
        ...(exitProvider ? { exitProvider } : {}),
        ...(exitTimezone ? { exitTimezone } : {}),
        issues,
        riskLevel,
        summary:
          riskLevel === 'high'
            ? '检测到高风险出口、DNS 或分流信号；处理前不能判断为低风险。'
            : riskLevel === 'medium'
              ? '检测到需要处理的出口或环境风险；当前不能判断为低风险。'
              : riskLevel === 'unknown'
                ? '关键风险证据不完整；本次不能判断为低风险。'
                : '本次检查未发现已知的 IP、DNS、分流、IPv6 或时区风险；系统语言对照仅供参考。',
      };
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      const checks: NetworkEnvironmentCheck[] = [
        makeCheck(
          'exit-ip',
          '模型出口与地区',
          'unknown',
          `出口情报不可用：${message.slice(0, 160)}`,
          'api.ipquery.io',
        ),
        makeCheck(
          'ip-reputation',
          'IP 纯净度',
          'unknown',
          '没有出口地址，无法查询 IP 情报。',
          '多源情报',
        ),
        makeCheck(
          'direct-route',
          '分流直连出口',
          'unknown',
          '没有模型出口，无法完成分流对照。',
          'myip.ipip.net',
        ),
        makeCheck(
          'dns-authoritative',
          '权威 DNS 出口',
          'unknown',
          '没有模型出口地区，无法完成 DNS 对照。',
          'dnscheck.tools',
        ),
        makeCheck('ipv6-route', 'IPv6 旁路', 'unknown', '本次没有完成 IPv6 出口评估。', '网络接口'),
        makeCheck('timezone', '时区一致性', 'unknown', '没有出口时区，无法完成对照。', '本机 Intl'),
        makeCheck(
          'language',
          '系统语言参考',
          'unknown',
          `仅供参考：Windows 首选语言为 ${systemLanguages.join('、') || '未知（系统未返回）'}；没有出口国家可供对照。`,
          'Windows 首选语言',
        ),
      ];
      return {
        ...base,
        checks,
        dnsDetail: '出口情报不可用，因此无法完成权威 DNS 出口关联。',
        dnsStatus: 'unknown',
        evidenceStatus: 'unavailable',
        issues: [
          {
            detail: `关键出口情报不可用：${message.slice(0, 180)}`,
            kind: 'evidence-incomplete',
            severity: 'info',
            title: '风险证据不可用',
          },
        ],
        riskLevel: 'unknown',
        summary: '关键风险证据不可用；本次不能判断为低风险。',
      };
    }
  }
}
