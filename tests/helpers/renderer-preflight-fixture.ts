import type {
  ApplicationProxyState,
  ClaudeLaunchPauseDiagnostics,
  ClaudeProjectState,
  CodexProjectState,
  NetworkEnvironmentAssessment,
  NetworkEnvironmentCheck,
  NetworkPreflightResult,
  NetworkProviderConnectivityStatus,
  NetworkProviderId,
} from '../../src/shared/contracts';
import { claudeProjectState } from './renderer-terminal-fixture';

let nextMainRunId = 1;

interface PreflightResultOverrides {
  action?: NetworkPreflightResult['action'];
  advisoryEvidence?: Partial<NetworkPreflightResult['advisoryEvidence']>;
  canonicalCwd?: string;
  environment?: NetworkPreflightResult['environment'];
  featureAccess?: NetworkPreflightResult['featureAccess'];
  generation?: number;
  mainRunId?: number;
  networkScope?: NetworkPreflightResult['networkScope'];
  paths?: NetworkPreflightResult['paths'];
  probes?: NetworkPreflightResult['probes'];
  providerConnectivity?: Partial<NetworkPreflightResult['providerConnectivity']>;
  reasons?: string[];
  riskLevel?: NetworkPreflightResult['advisoryEvidence']['riskLevel'];
  riskScore?: number;
  signals?: NetworkPreflightResult['signals'];
  summary?: string;
}

export const preflightResult = (
  provider: NetworkProviderId,
  status: NetworkProviderConnectivityStatus,
  overrides: PreflightResultOverrides = {},
): NetworkPreflightResult => {
  const providerConnectivity = {
    featureAccess: overrides.providerConnectivity?.featureAccess ?? overrides.featureAccess ?? [],
    probes: overrides.providerConnectivity?.probes ?? overrides.probes ?? [],
    reasons: overrides.providerConnectivity?.reasons ?? overrides.reasons ?? [],
    signals: overrides.providerConnectivity?.signals ?? [],
    status: overrides.providerConnectivity?.status ?? status,
    summary: overrides.providerConnectivity?.summary ?? overrides.summary ?? `synthetic ${status}`,
  };
  const environment = overrides.advisoryEvidence?.environment ?? overrides.environment;
  const advisoryEvidence = {
    ...(environment ? { environment } : {}),
    paths: overrides.advisoryEvidence?.paths ?? overrides.paths ?? [],
    reasons: overrides.advisoryEvidence?.reasons ?? [],
    riskLevel: overrides.advisoryEvidence?.riskLevel ?? overrides.riskLevel ?? ('low' as const),
    riskScore: overrides.advisoryEvidence?.riskScore ?? overrides.riskScore ?? 10,
    signals: overrides.advisoryEvidence?.signals ?? overrides.signals ?? [],
    summary: overrides.advisoryEvidence?.summary ?? 'synthetic advisory evidence',
  };
  const compatibilityStatus =
    providerConnectivity.status === 'allowed' &&
    (advisoryEvidence.signals.length > 0 || advisoryEvidence.environment !== undefined)
      ? 'allowed_with_notice'
      : providerConnectivity.status;
  return {
    action: overrides.action ?? 'background',
    advisoryEvidence,
    ...(overrides.canonicalCwd ? { canonicalCwd: overrides.canonicalCwd } : {}),
    checkedAt: 1,
    configurationRevision: 'test:1',
    featureAccess: providerConnectivity.featureAccess,
    generation: overrides.generation ?? 0,
    mainRunId: overrides.mainRunId ?? nextMainRunId++,
    networkScope: overrides.networkScope ?? 'application',
    paths: advisoryEvidence.paths,
    probes: providerConnectivity.probes,
    provider,
    providerConnectivity,
    providerLabel:
      provider === 'openai-codex'
        ? 'OpenAI Codex'
        : provider === 'openai-api'
          ? 'OpenAI API'
          : provider === 'ai-services'
            ? 'AI 服务综合预检'
            : provider === 'xai-grok'
              ? 'xAI Grok'
              : 'Anthropic Claude Code',
    reasons: providerConnectivity.reasons,
    riskLevel: advisoryEvidence.riskLevel,
    riskScore: advisoryEvidence.riskScore,
    schemaVersion: 2,
    signals: [...providerConnectivity.signals, ...advisoryEvidence.signals],
    startedAt: 1,
    status: compatibilityStatus,
    summary: providerConnectivity.summary,
  };
};

export const launchPauseDiagnostics = (
  summary = '网络检查未通过，Claude 启动已暂停。',
): ClaudeLaunchPauseDiagnostics => ({
  action: 'cli-launch',
  checkedAt: 100,
  failedItems: [
    {
      checkedAt: 101,
      detail: 'TLS 证书校验失败。',
      kind: 'tls',
      label: 'TLS handshake',
      process: 'claude-cli',
      required: true,
      status: 'failed',
      target: 'https://api.anthropic.com/v1/messages',
    },
  ],
  freshness: 'fresh',
  provider: 'anthropic-claude',
  providerLabel: 'Anthropic Claude Code',
  reasons: ['连接被阻止'],
  scope: 'application',
  status: 'blocked',
  summary,
});

export const stalePreflightEnvironment = (): NetworkEnvironmentAssessment => ({
  checkedAt: 1,
  dnsDetail: 'stale DNS evidence',
  dnsStatus: 'review',
  evidenceStatus: 'complete',
  issues: [
    {
      detail: 'stale repair detail',
      kind: 'timezone-mismatch',
      severity: 'warning',
      suggestedTimezone: 'Asia/Shanghai',
      title: 'stale repair action',
    },
  ],
  localLanguage: 'zh-CN',
  localTimezone: 'UTC',
  publicAddressObservations: [],
  riskLevel: 'medium',
  summary: 'stale environment summary',
});

const environmentCheck = (
  input: Pick<NetworkEnvironmentCheck, 'detail' | 'id' | 'label' | 'source' | 'status'> &
    Partial<Pick<NetworkEnvironmentCheck, 'confidence' | 'freshness' | 'target' | 'transport'>>,
): NetworkEnvironmentCheck => ({
  authority: 'advisory-only',
  checkedAt: 1,
  confidence: 'medium',
  freshness: 'live',
  networkScope: 'application',
  process: 'network-diagnostics',
  target: input.source,
  transport: 'derived',
  ...input,
});

export const provenancePreflightEnvironment = (): NetworkEnvironmentAssessment => ({
  checkedAt: 1,
  checks: [
    environmentCheck({
      detail: '信誉来源均已完成。',
      id: 'ip-reputation',
      label: '地址信誉',
      source: 'IPQuery + ProxyCheck',
      status: 'passed',
      target: 'https://proxycheck.io/v2/{redacted-address}',
      transport: 'curl-cli',
    }),
    environmentCheck({
      detail: '重复 IPIP 行不应在富地址观察后再次渲染。',
      id: 'public-address-ipip',
      label: '公网地址观察（myip.ipip.net）',
      source: 'myip.ipip.net',
      status: 'passed',
      target: 'https://myip.ipip.net',
      transport: 'curl-cli',
    }),
    environmentCheck({
      detail: 'IPv6 地址族观察已完成。',
      id: 'ipv6-public-address',
      label: 'IPv6 公网地址观察',
      source: 'api6.ipify.org',
      status: 'passed',
      target: 'https://api6.ipify.org?format=json',
      transport: 'curl-cli',
    }),
    environmentCheck({
      detail:
        '仅供参考：Windows 首选语言 zh-CN、en-US 中至少一项与 api.ipquery.io 观察国家 US 的常用语言匹配。',
      id: 'language',
      label: '系统语言参考',
      source: 'Windows 首选语言 + IPQuery',
      status: 'passed',
      target: 'Windows preferred languages + https://api.ipquery.io/?format=json',
    }),
    environmentCheck({
      detail: 'DNS 目标限定观察已完成。',
      id: 'dns-authoritative',
      label: '权威 DNS 观察',
      source: 'dnscheck.tools',
      status: 'passed',
      target: '*.test.dnscheck.tools TXT',
      transport: 'system-dns',
    }),
    environmentCheck({
      detail: '重复 IPQuery 行不应在富地址观察后再次渲染。',
      id: 'public-address-ipquery',
      label: '公网地址观察（api.ipquery.io）',
      source: 'api.ipquery.io',
      status: 'passed',
      target: 'https://api.ipquery.io/?format=json',
      transport: 'curl-cli',
    }),
    environmentCheck({
      confidence: 'unknown',
      detail: '本次未收集 WebRTC STUN；该证据不可用且不参与提供商判定。',
      freshness: 'unknown',
      id: 'stun-public-address',
      label: 'STUN/WebRTC 公网地址观察',
      source: 'WebRTC STUN（本次未收集）',
      status: 'unavailable',
      target: 'WebRTC STUN public-address collection',
      transport: 'not-collected',
    }),
    environmentCheck({
      detail: '本机时区与观察时区一致。',
      id: 'timezone',
      label: '时区一致性',
      source: '本机 Intl + IPQuery',
      status: 'passed',
      target: 'local Intl timezone + https://api.ipquery.io/?format=json',
    }),
  ],
  cliLanguages: ['en-US'],
  dnsDetail:
    'dnscheck.tools 观察到的递归解析器与 api.ipquery.io 观察国家一致；该结果不证明提供商端点使用相同路径。',
  dnsStatus: 'consistent',
  evidenceStatus: 'complete',
  issues: [],
  localLanguage: 'zh-CN',
  localTimezone: 'America/Los_Angeles',
  publicAddressObservations: [
    {
      addressFamily: 'ipv4',
      addressPrefix: '203.0.113.0/24',
      checkedAt: 1,
      confidence: 'medium',
      countryCode: 'US',
      detail: 'api.ipquery.io 观察到一个 IPv4 地址。',
      endpoint: 'https://api.ipquery.io/?format=json',
      freshness: 'live',
      networkScope: 'application',
      observationProvider: 'IPQuery',
      process: 'network-diagnostics',
      sourceAgreement: 'corroborated',
      state: 'complete',
      statement:
        '该结果只描述此收集进程访问该观察端点时的公网地址，不证明提供商端点使用相同公网地址。',
      transport: 'curl-cli',
    },
    {
      addressFamily: 'ipv4',
      addressPrefix: '203.0.113.0/24',
      checkedAt: 2,
      confidence: 'medium',
      detail: 'myip.ipip.net 观察到相同的脱敏前缀。',
      endpoint: 'https://myip.ipip.net',
      freshness: 'live',
      networkScope: 'application',
      observationProvider: 'IPIP',
      process: 'network-diagnostics',
      sourceAgreement: 'corroborated',
      state: 'complete',
      statement:
        '该结果只描述此收集进程访问该观察端点时的公网地址，不证明提供商端点使用相同公网地址。',
      transport: 'curl-cli',
    },
    {
      addressFamily: 'ipv6',
      addressPrefix: '2001:db8:1234:5678::/64',
      checkedAt: 3,
      confidence: 'medium',
      detail: 'api6.ipify.org 观察到单独的 IPv6 地址族。',
      endpoint: 'https://api6.ipify.org?format=json',
      freshness: 'live',
      networkScope: 'application',
      observationProvider: 'ipify',
      process: 'network-diagnostics',
      sourceAgreement: 'not-comparable',
      state: 'complete',
      statement:
        '该结果只描述此收集进程访问该观察端点时的公网地址，不证明提供商端点使用相同公网地址。',
      transport: 'curl-cli',
    },
  ],
  riskLevel: 'low',
  summary: '本次目标限定的公网地址、DNS、IPv6 与时区辅助观察未返回已知风险；系统语言对照仅供参考。',
});

export const gatewayClaudeState = (): ClaudeProjectState => {
  const state = claudeProjectState();
  return {
    ...state,
    config: {
      ...state.config,
      baseUrl: 'https://gateway.example.test',
      provider: 'gateway',
    },
  };
};

export const readyCodexState = (): CodexProjectState => ({
  account: {
    email: 'synthetic@example.test',
    planType: 'test',
    type: 'chatgpt',
  },
  active: false,
  cwd: 'D:\\Project',
  installation: {
    installed: true,
    message: 'Codex CLI 已就绪。',
    updateAvailable: false,
    version: 'test',
  },
  login: { phase: 'idle' },
  revision: 1,
  requiresOpenaiAuth: true,
  sessionId: 'session-1',
});

export const proxyState = (): ApplicationProxyState => ({
  config: {
    enabled: true,
    host: 'saved.example.test',
    passwordConfigured: false,
    port: 8_080,
    protocol: 'http',
    scope: {
      application: true,
      cli: true,
      conversation: true,
    },
    username: '',
  },
});
