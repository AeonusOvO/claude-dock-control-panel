import type { NetworkPreflightAction, NetworkProviderId } from '../contracts';

export interface ProviderEndpointProfile {
  allowedRedirectDomains?: string[];
  id: string;
  kind: 'api' | 'https' | 'oauth' | 'websocket';
  label: string;
  process: 'application' | 'cli';
  requiredFor: NetworkPreflightAction[];
  url: string;
}

export interface ProviderVersionRule {
  id: string;
  maximum?: string;
  minimum?: string;
  reason: string;
  severity: 'block' | 'warn';
  source: string;
}

export interface ProviderProfile {
  authDomains: string[];
  cacheTtlMs: number;
  displayName: string;
  endpoints: ProviderEndpointProfile[];
  hardBlockRules: string[];
  id: NetworkProviderId;
  minimumSecureClientVersion?: string;
  optionalDomains: string[];
  privacyModeEnvironment: Record<string, string>;
  profileVersion: number;
  requiredDomains: string[];
  riskThresholds: {
    blocked: number;
    warning: number;
  };
  sources: Array<{ label: string; retrievedAt: string; url: string }>;
  updatedAt: string;
  versionRules: ProviderVersionRule[];
}

const OFFICIAL_ACTIONS: NetworkPreflightAction[] = [
  'background',
  'provider-switch',
  'login',
  'cli-launch',
  'first-request',
];

export const PROVIDER_PROFILES: Record<NetworkProviderId, ProviderProfile> = {
  'ai-services': {
    authDomains: ['auth.openai.com', 'auth.x.ai', 'claude.ai', 'grok.com'],
    cacheTtlMs: 2 * 60_000,
    displayName: 'AI 服务综合预检',
    endpoints: [
      {
        allowedRedirectDomains: [
          'auth.openai.com',
          'auth0.openai.com',
          'challenges.cloudflare.com',
          'openai.com',
        ],
        id: 'suite-chatgpt',
        kind: 'https',
        label: 'ChatGPT',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://chatgpt.com/',
      },
      {
        id: 'suite-codex',
        kind: 'api',
        label: 'OpenAI Codex',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://chatgpt.com/backend-api/codex',
      },
      {
        allowedRedirectDomains: ['anthropic.com', 'claude.com'],
        id: 'suite-claude-web',
        kind: 'https',
        label: 'Claude',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://claude.ai/',
      },
      {
        id: 'suite-claude-api',
        kind: 'api',
        label: 'Claude API',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://api.anthropic.com/v1/messages',
      },
      {
        allowedRedirectDomains: ['x.com', 'x.ai'],
        id: 'suite-grok-web',
        kind: 'https',
        label: 'Grok',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://grok.com/',
      },
      {
        id: 'suite-grok-api',
        kind: 'api',
        label: 'xAI API',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://api.x.ai/v1/models',
      },
      {
        id: 'suite-grok-build',
        kind: 'https',
        label: 'Grok Build',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://cli-chat-proxy.grok.com/',
      },
    ],
    hardBlockRules: [
      'required-api-unreachable',
      'tls-invalid',
      'unexpected-redirect',
      'captive-portal',
    ],
    id: 'ai-services',
    optionalDomains: ['auth.openai.com', 'auth.x.ai', 'code.grok.com'],
    privacyModeEnvironment: {},
    profileVersion: 1,
    requiredDomains: [
      'api.anthropic.com',
      'api.x.ai',
      'chatgpt.com',
      'claude.ai',
      'cli-chat-proxy.grok.com',
      'grok.com',
    ],
    riskThresholds: { blocked: 80, warning: 35 },
    sources: [
      {
        label: 'OpenAI ChatGPT/Codex 网络建议',
        retrievedAt: '2026-08-22',
        url: 'https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps',
      },
      {
        label: 'Claude Code 企业网络配置',
        retrievedAt: '2026-08-22',
        url: 'https://code.claude.com/docs/en/network-config',
      },
      {
        label: 'Grok Build 企业网络要求',
        retrievedAt: '2026-08-22',
        url: 'https://docs.x.ai/build/enterprise',
      },
    ],
    updatedAt: '2026-08-22',
    versionRules: [],
  },
  'openai-api': {
    authDomains: ['platform.openai.com'],
    cacheTtlMs: 2 * 60_000,
    displayName: 'OpenAI API',
    endpoints: [
      {
        id: 'openai-public-api',
        kind: 'api',
        label: 'OpenAI API',
        process: 'application',
        requiredFor: ['background', 'first-request'],
        url: 'https://api.openai.com/v1/models',
      },
    ],
    hardBlockRules: [
      'required-api-unreachable',
      'tls-invalid',
      'unexpected-redirect',
      'captive-portal',
    ],
    id: 'openai-api',
    optionalDomains: ['platform.openai.com', 'status.openai.com'],
    privacyModeEnvironment: {},
    profileVersion: 1,
    requiredDomains: ['api.openai.com'],
    riskThresholds: { blocked: 80, warning: 35 },
    sources: [
      {
        label: 'OpenAI API 支持地区',
        retrievedAt: '2026-07-29',
        url: 'https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories',
      },
    ],
    updatedAt: '2026-07-29',
    versionRules: [],
  },
  'openai-codex': {
    authDomains: ['auth.openai.com', 'chatgpt.com'],
    cacheTtlMs: 2 * 60_000,
    displayName: 'OpenAI Codex',
    endpoints: [
      {
        allowedRedirectDomains: ['auth0.openai.com', 'challenges.cloudflare.com', 'chatgpt.com'],
        id: 'openai-auth',
        kind: 'oauth',
        label: 'ChatGPT 官方认证',
        process: 'application',
        requiredFor: [],
        url: 'https://auth.openai.com/',
      },
      {
        allowedRedirectDomains: [
          'auth.openai.com',
          'auth0.openai.com',
          'challenges.cloudflare.com',
          'openai.com',
        ],
        id: 'openai-chatgpt',
        kind: 'https',
        label: 'ChatGPT 服务',
        process: 'application',
        requiredFor: [],
        url: 'https://chatgpt.com/',
      },
      {
        id: 'openai-codex-api',
        kind: 'api',
        label: 'Codex 服务',
        process: 'cli',
        requiredFor: ['background', 'provider-switch', 'login', 'cli-launch', 'first-request'],
        url: 'https://chatgpt.com/backend-api/codex',
      },
      {
        id: 'openai-codex-websocket',
        kind: 'websocket',
        label: 'Codex WebSocket',
        process: 'cli',
        requiredFor: ['cloud-task'],
        url: 'wss://chatgpt.com/',
      },
    ],
    hardBlockRules: [
      'official-auth-unreachable',
      'required-api-unreachable',
      'tls-invalid',
      'unexpected-redirect',
      'captive-portal',
      'cli-path-failed',
    ],
    id: 'openai-codex',
    optionalDomains: [
      'auth0.openai.com',
      'challenges.cloudflare.com',
      'cdn.openaimerge.com',
      'cdn.workos.com',
      'desktop.chat.openai.com',
      'forwarder.workos.com',
      'images.workoscdn.com',
      'oaistatsig.com',
      'oaistatic.com',
      'oaiusercontent.com',
      'intercom.io',
      'intercomcdn.com',
      'sentry.io',
      'workos.imgix.net',
    ],
    privacyModeEnvironment: {},
    profileVersion: 1,
    requiredDomains: ['auth.openai.com', 'chatgpt.com', 'openai.com'],
    riskThresholds: { blocked: 80, warning: 35 },
    sources: [
      {
        label: 'OpenAI ChatGPT 支持地区',
        retrievedAt: '2026-07-29',
        url: 'https://help.openai.com/en/articles/7947663-chatgpt-supported-countries',
      },
      {
        label: 'OpenAI ChatGPT/Codex 网络建议',
        retrievedAt: '2026-07-29',
        url: 'https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps',
      },
    ],
    updatedAt: '2026-07-29',
    versionRules: [],
  },
  'anthropic-claude': {
    authDomains: ['claude.ai', 'claude.com', 'platform.claude.com'],
    cacheTtlMs: 2 * 60_000,
    displayName: 'Anthropic Claude Code',
    endpoints: [
      {
        id: 'anthropic-claude-auth',
        kind: 'oauth',
        label: 'Claude.ai 官方认证',
        process: 'application',
        requiredFor: [],
        url: 'https://claude.ai/',
      },
      {
        id: 'anthropic-console-auth',
        kind: 'oauth',
        label: 'Anthropic Console 认证',
        process: 'application',
        requiredFor: [],
        url: 'https://platform.claude.com/',
      },
      {
        id: 'anthropic-api',
        kind: 'api',
        label: 'Anthropic API',
        process: 'cli',
        requiredFor: OFFICIAL_ACTIONS,
        url: 'https://api.anthropic.com/v1/messages',
      },
    ],
    hardBlockRules: [
      'official-auth-unreachable',
      'required-api-unreachable',
      'tls-invalid',
      'unexpected-redirect',
      'captive-portal',
      'high-risk-client-version',
      'cli-path-failed',
    ],
    id: 'anthropic-claude',
    minimumSecureClientVersion: '2.1.197',
    optionalDomains: [
      'downloads.claude.ai',
      'mcp-proxy.anthropic.com',
      'storage.googleapis.com',
      'raw.githubusercontent.com',
      'http-intake.logs.us5.datadoghq.com',
      'browser-intake-us5-datadoghq.com',
      'bridge.claudeusercontent.com',
      'code.claude.com',
      'formulae.brew.sh',
      'registry.npmjs.org',
    ],
    privacyModeEnvironment: {
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1',
      DO_NOT_TRACK: '1',
    },
    profileVersion: 1,
    requiredDomains: ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com'],
    riskThresholds: { blocked: 80, warning: 35 },
    sources: [
      {
        label: 'Anthropic 支持地区',
        retrievedAt: '2026-07-29',
        url: 'https://www.anthropic.com/supported-countries',
      },
      {
        label: 'Claude Code 企业网络配置',
        retrievedAt: '2026-07-29',
        url: 'https://code.claude.com/docs/en/network-config',
      },
      {
        label: 'Claude Code 官方安全公告',
        retrievedAt: '2026-07-29',
        url: 'https://github.com/anthropics/claude-code/security/advisories',
      },
    ],
    updatedAt: '2026-07-29',
    versionRules: [
      {
        id: 'official-security-advisories-through-2.1.162',
        maximum: '2.1.162',
        reason: '命中 Claude Code 官方仓库已公开修复的高风险安全公告范围。',
        severity: 'block',
        source: 'https://github.com/anthropics/claude-code/security/advisories',
      },
    ],
  },
  'xai-grok': {
    authDomains: ['auth.x.ai', 'grok.com'],
    cacheTtlMs: 2 * 60_000,
    displayName: 'xAI Grok',
    endpoints: [
      {
        allowedRedirectDomains: ['x.com', 'x.ai'],
        id: 'xai-grok-web',
        kind: 'https',
        label: 'Grok',
        process: 'application',
        requiredFor: ['background'],
        url: 'https://grok.com/',
      },
      {
        allowedRedirectDomains: ['accounts.x.ai', 'x.ai'],
        id: 'xai-auth',
        kind: 'oauth',
        label: 'xAI 官方认证',
        process: 'application',
        requiredFor: [],
        url: 'https://auth.x.ai/',
      },
      {
        id: 'xai-api',
        kind: 'api',
        label: 'xAI API',
        process: 'application',
        requiredFor: ['background', 'provider-switch', 'login', 'first-request'],
        url: 'https://api.x.ai/v1/models',
      },
      {
        id: 'xai-grok-build',
        kind: 'https',
        label: 'Grok Build',
        process: 'application',
        requiredFor: ['background', 'cli-launch', 'first-request'],
        url: 'https://cli-chat-proxy.grok.com/',
      },
    ],
    hardBlockRules: [
      'official-auth-unreachable',
      'required-api-unreachable',
      'tls-invalid',
      'unexpected-redirect',
      'captive-portal',
    ],
    id: 'xai-grok',
    optionalDomains: ['assets.grok.com', 'code.grok.com', 'storage.googleapis.com', 'x.ai'],
    privacyModeEnvironment: {},
    profileVersion: 1,
    requiredDomains: ['api.x.ai', 'auth.x.ai', 'cli-chat-proxy.grok.com', 'grok.com'],
    riskThresholds: { blocked: 80, warning: 35 },
    sources: [
      {
        label: 'xAI API 快速开始',
        retrievedAt: '2026-08-22',
        url: 'https://docs.x.ai/developers/quickstart',
      },
      {
        label: 'Grok Build 企业网络要求',
        retrievedAt: '2026-08-22',
        url: 'https://docs.x.ai/build/enterprise',
      },
    ],
    updatedAt: '2026-08-22',
    versionRules: [],
  },
};

const isHttpsOrWss = (value: string): boolean => {
  try {
    return ['https:', 'wss:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export const validateProviderProfile = (profile: ProviderProfile): void => {
  if (
    profile.profileVersion < 1 ||
    !profile.displayName ||
    profile.cacheTtlMs < 10_000 ||
    profile.updatedAt.length !== 10 ||
    profile.endpoints.length === 0 ||
    profile.sources.length === 0
  ) {
    throw new Error(`服务商配置 ${profile.id} 的 Schema 校验失败。`);
  }
  const endpointIds = new Set<string>();
  for (const endpoint of profile.endpoints) {
    if (
      !endpoint.id ||
      endpointIds.has(endpoint.id) ||
      !isHttpsOrWss(endpoint.url) ||
      endpoint.allowedRedirectDomains?.some(
        (domain) => !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(domain),
      )
    ) {
      throw new Error(`服务商配置 ${profile.id} 的端点无效。`);
    }
    endpointIds.add(endpoint.id);
  }
};

for (const profile of Object.values(PROVIDER_PROFILES)) {
  validateProviderProfile(profile);
}

export const getProviderProfile = (provider: NetworkProviderId): ProviderProfile =>
  PROVIDER_PROFILES[provider];

export const compareSemanticVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const blockingVersionRuleFor = (
  profile: ProviderProfile,
  version: string,
): ProviderVersionRule | undefined =>
  profile.versionRules.find(
    (rule) =>
      rule.severity === 'block' &&
      (!rule.minimum || compareSemanticVersions(version, rule.minimum) >= 0) &&
      (!rule.maximum || compareSemanticVersions(version, rule.maximum) <= 0),
  );
