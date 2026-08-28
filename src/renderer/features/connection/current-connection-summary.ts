import { findClaudeProvider, type ClaudeProviderId } from '../../../shared/claude/providers';
import { sanitizeAccountIdentity } from '../../../shared/claude/account-identity';
import type {
  ClaudeAuthMode,
  ClaudeConfigView,
  ClaudeOfficialAuthState,
} from '../../../shared/contracts';

export type CurrentConnectionSummaryKind = 'api' | 'domestic' | 'official-subscription';

/**
 * Extra identity that is not part of `ClaudeConfigView` itself.
 *
 * A saved history entry can provide `connectionName`; the managed ChatGPT gateway can provide
 * `accountIdentity`; Claude Code's own auth-status command can provide the allow-listed
 * `officialAuth`. Callers must never infer an identity from the Windows user or project directory.
 */
export interface CurrentConnectionSummaryContext {
  accountIdentity?: string;
  accountStatus?: 'failed' | 'loading';
  connectionName?: string;
  officialAuth?: ClaudeOfficialAuthState;
}

export interface CurrentConnectionSummary {
  connectionType: 'subscription' | 'api';
  /** Account identity is separate so a future UI can style or announce it without parsing copy. */
  accountIdentity?: string;
  /** Renderer-safe endpoint: URL credentials, query parameters and fragments are never included. */
  endpoint?: string;
  kind: CurrentConnectionSummaryKind;
  /** Main value displayed after “当前接入”. */
  name: string;
  /** Secondary facts, already ordered by usefulness. */
  metadata: readonly string[];
}

const GENERIC_API_PRESETS = new Set<ClaudeProviderId>(['curl', 'custom', 'gateway']);

const normalizedOptionalText = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

/**
 * Keeps the useful route while removing URL fields that commonly carry secrets. Invalid or
 * non-HTTP(S) values are not echoed back into the page.
 */
export const redactConnectionEndpoint = (value: string | undefined): string | undefined => {
  const candidate = normalizedOptionalText(value);
  if (!candidate) return undefined;

  try {
    const endpoint = new URL(candidate);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return undefined;
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    return undefined;
  }
};

const sourceEndpoint = (config: ClaudeConfigView): string | undefined =>
  redactConnectionEndpoint(config.sourceBaseUrl) ?? redactConnectionEndpoint(config.baseUrl);

const sourceModel = (config: ClaudeConfigView): string | undefined =>
  normalizedOptionalText(config.sourceModel) ?? normalizedOptionalText(config.model);

const sourceAuthMode = (config: ClaudeConfigView): ClaudeAuthMode =>
  config.sourceAuthMode ?? config.authMode;

const sourceCredentialConfigured = (config: ClaudeConfigView): boolean =>
  config.sourceCredentialConfigured ?? config.credentialConfigured;

const credentialSummary = (config: ClaudeConfigView): string => {
  switch (sourceAuthMode(config)) {
    case 'apiKey':
    case 'authToken':
      // The renderer intentionally receives only this boolean, never even a masked key fragment.
      return sourceCredentialConfigured(config) ? 'API 凭据已配置' : 'API 凭据未配置';
    case 'existing':
      return '使用现有登录';
    case 'none':
      return '无需 API 凭据';
  }
};

const isOfficialSubscription = (preset: ClaudeProviderId): boolean =>
  preset === 'anthropic' || preset === 'chatgpt-subscription';

const officialSubscriptionName = (preset: ClaudeProviderId): string =>
  preset === 'chatgpt-subscription' ? 'ChatGPT 官方订阅' : 'Claude 官方订阅';

const officialAccountSummary = (
  config: ClaudeConfigView,
  context: CurrentConnectionSummaryContext,
): { accountIdentity?: string; metadata: string } => {
  const accountIdentity = sanitizeAccountIdentity(
    config.preset === 'anthropic'
      ? (context.officialAuth?.accountIdentity ?? context.accountIdentity)
      : context.accountIdentity,
  );
  if (accountIdentity) {
    return { accountIdentity, metadata: '账户：' + accountIdentity };
  }
  if (context.accountStatus === 'loading') {
    return { metadata: '正在读取账户…' };
  }
  if (context.accountStatus === 'failed') {
    return { metadata: '账户信息暂不可用' };
  }

  const officialAuth = config.preset === 'anthropic' ? context.officialAuth : undefined;
  if (!officialAuth || !officialAuth.available) return { metadata: '账户信息暂不可用' };
  if (!officialAuth.loggedIn) return { metadata: '未登录' };
  return { metadata: '账户信息暂不可用' };
};

const apiDisplayName = (
  config: ClaudeConfigView,
  connectionName: string | undefined,
  endpoint: string | undefined,
): string => {
  const explicitName = normalizedOptionalText(connectionName);
  if (explicitName) return explicitName;

  const provider = findClaudeProvider(config.preset);
  if (provider && !GENERIC_API_PRESETS.has(provider.id)) return provider.label;
  return endpoint ?? provider?.label ?? 'API / 中转站';
};

/**
 * Builds the semantic “当前接入” content without touching DOM or global state. `ClaudeConfigView`
 * is deliberately used as the boundary: it contains no credential value, so this formatter cannot
 * accidentally reveal an API key.
 */
export const createCurrentConnectionSummary = (
  config: ClaudeConfigView,
  context: CurrentConnectionSummaryContext = {},
): CurrentConnectionSummary => {
  const provider = findClaudeProvider(config.preset);
  const endpoint = sourceEndpoint(config);

  if (isOfficialSubscription(config.preset) || provider?.codingPlan) {
    const account = officialAccountSummary(config, context);
    return {
      ...(account.accountIdentity ? { accountIdentity: account.accountIdentity } : {}),
      connectionType: 'subscription',
      kind: isOfficialSubscription(config.preset) ? 'official-subscription' : 'domestic',
      name: isOfficialSubscription(config.preset)
        ? officialSubscriptionName(config.preset)
        : provider!.label,
      metadata: [
        ...(!isOfficialSubscription(config.preset) && sourceModel(config)
          ? ['模型：' + sourceModel(config)]
          : []),
        account.metadata,
      ],
    };
  }

  if (provider?.group === 'domestic') {
    const model = sourceModel(config);
    return {
      ...(endpoint ? { endpoint } : {}),
      kind: 'domestic',
      connectionType: 'api',
      name: provider.label,
      metadata: [
        ...(model ? [`模型：${model}`] : []),
        credentialSummary(config),
        ...(endpoint ? [`接口：${endpoint}`] : []),
      ],
    };
  }

  const name = apiDisplayName(config, context.connectionName, endpoint);
  return {
    ...(endpoint ? { endpoint } : {}),
    kind: 'api',
    connectionType: 'api',
    name,
    metadata: [
      ...(endpoint && endpoint !== name ? [`接口：${endpoint}`] : []),
      credentialSummary(config),
    ],
  };
};
