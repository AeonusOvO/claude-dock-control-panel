import type {
  ClaudeConfigView,
  ClaudeConversationModelDifference,
  ClaudeConversationModelIdentity,
  ClaudeEndpointProtocol,
  ClaudeOfficialAuthState,
  SaveClaudeConfigInput,
} from '../../shared/contracts';
import { findClaudeProvider } from '../../shared/claude/providers';
import type { ConversationConnectionBinding } from '../conversation/preferences-store';
import { credentialFingerprint } from '../conversation/preferences-store';
import type { ConnectionHistoryReplay } from './connection-history';

export interface ConversationBindingAccount {
  accountIdentity?: string;
  authMethod?: string;
}

const normalizedModelFast = (config: Pick<SaveClaudeConfigInput, 'model' | 'modelFast'>): string =>
  config.modelFast?.trim() || config.model.trim();

const isSubscriptionPreset = (preset: SaveClaudeConfigInput['preset']): boolean =>
  preset === 'anthropic' || preset === 'chatgpt-subscription';

const currentSourceConfig = (
  view: ClaudeConfigView,
  credential: string | undefined,
): SaveClaudeConfigInput => {
  if (view.protocol === 'openai' && view.sourceBaseUrl && view.sourceModel) {
    return {
      apiKeyHelperPolicy: view.apiKeyHelperPolicy,
      authMode: view.sourceAuthMode ?? 'authToken',
      baseUrl: view.sourceBaseUrl,
      credential,
      credentialAction: credential ? 'replace' : 'keep',
      model: view.sourceModel,
      modelFast: view.sourceModelFast || view.sourceModel,
      preset: 'custom',
      protocol: 'openai',
      provider: 'gateway',
      routerProviderId: view.routerProviderId,
    };
  }
  return {
    apiKeyHelperPolicy: view.apiKeyHelperPolicy,
    authMode: view.authMode,
    baseUrl: view.baseUrl,
    credential,
    credentialAction: credential ? 'replace' : 'keep',
    model: view.model,
    modelFast: view.modelFast || view.model,
    preset: view.preset,
    ...(view.protocol === 'anthropic' || view.protocol === 'openai'
      ? { protocol: view.protocol }
      : {}),
    provider: view.provider,
    routerProviderId: view.routerProviderId,
  };
};

export const createConversationConnectionBinding = (input: {
  account?: ConversationBindingAccount;
  credential: string | undefined;
  preferReplayConfig?: boolean;
  replay?: ConnectionHistoryReplay;
  view: ClaudeConfigView;
}): ConversationConnectionBinding => {
  const config =
    input.preferReplayConfig === false
      ? currentSourceConfig(input.view, input.credential)
      : (input.replay?.config ?? currentSourceConfig(input.view, input.credential));
  const replayCredential = config.credential?.trim() || undefined;
  const credentialConfigured =
    isSubscriptionPreset(config.preset) ||
    config.authMode === 'existing' ||
    config.authMode === 'none'
      ? false
      : Boolean(replayCredential) ||
        (input.view.protocol === 'openai'
          ? Boolean(input.view.sourceCredentialConfigured)
          : input.view.credentialConfigured);
  return {
    accountIdentity: input.account?.accountIdentity,
    authMethod: input.account?.authMethod,
    config: {
      ...config,
      credential: replayCredential,
      credentialAction: replayCredential ? 'replace' : 'keep',
      model: config.model.trim(),
      modelFast: normalizedModelFast(config),
    },
    connectionName: input.replay?.name,
    credentialConfigured,
    credentialFingerprint: isSubscriptionPreset(config.preset)
      ? undefined
      : credentialFingerprint(replayCredential),
    protocol: input.replay?.protocol ?? input.view.protocol,
  };
};

export const accountFromOfficialAuth = (
  state: ClaudeOfficialAuthState | undefined,
): ConversationBindingAccount | undefined =>
  state
    ? {
        accountIdentity: state.accountIdentity,
        authMethod: state.authMethod ?? (state.loggedIn ? 'Claude Code 官方登录' : undefined),
      }
    : undefined;

const redactedEndpoint = (value: string): string | undefined => {
  if (!value.trim()) return undefined;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') return undefined;
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    return undefined;
  }
};

const authModeLabel = (binding: ConversationConnectionBinding): string => {
  if (isSubscriptionPreset(binding.config.preset)) return '官方订阅账户授权';
  switch (binding.config.authMode) {
    case 'apiKey':
      return 'API Key';
    case 'authToken':
      return 'Bearer / Auth Token';
    case 'existing':
      return '订阅账户 / 现有登录';
    case 'none':
      return '无需认证';
  }
};

const protocolLabel = (protocol: ClaudeEndpointProtocol): string => {
  switch (protocol) {
    case 'anthropic':
      return 'Anthropic Messages';
    case 'openai':
      return 'OpenAI 兼容协议';
    case 'unknown':
      return '自动识别';
  }
};

const networkPresentation = (
  preset: SaveClaudeConfigInput['preset'],
): ClaudeConversationModelIdentity['networkPresentation'] => {
  const group = findClaudeProvider(preset)?.group;
  if (group === 'domestic') return 'domestic';
  if (group === 'local') return 'local';
  return 'foreign';
};

const providerLabel = (binding: ConversationConnectionBinding): string =>
  binding.connectionName ??
  findClaudeProvider(binding.config.preset)?.label ??
  binding.config.preset;

const accountDetail = (binding: ConversationConnectionBinding): string => {
  if (isSubscriptionPreset(binding.config.preset) || binding.config.authMode === 'existing') {
    return binding.accountIdentity
      ? `订阅账户：${binding.accountIdentity}`
      : binding.authMethod
        ? `订阅登录：${binding.authMethod}`
        : '订阅账户信息暂不可用';
  }
  if (binding.config.authMode === 'none') return '无需 API 凭据';
  if (!binding.credentialConfigured) return 'API 凭据未配置';
  return binding.credentialFingerprint
    ? `API 凭据已配置 · SHA-256 ${binding.credentialFingerprint.slice(0, 10)}`
    : 'API 凭据已配置 · 指纹暂不可用';
};

export const conversationModelIdentity = (
  binding: ConversationConnectionBinding,
  source: ClaudeConversationModelIdentity['source'],
  mainModelOverride?: string,
): ClaudeConversationModelIdentity => ({
  accountDetail: accountDetail(binding),
  accountIdentity: binding.accountIdentity,
  authModeLabel: authModeLabel(binding),
  connectionName: binding.connectionName,
  credentialConfigured: binding.credentialConfigured,
  credentialFingerprint: binding.credentialFingerprint?.slice(0, 10),
  endpoint: redactedEndpoint(binding.config.baseUrl),
  mainModel: mainModelOverride?.trim() || binding.config.model,
  networkPresentation: networkPresentation(binding.config.preset),
  protocolLabel: protocolLabel(binding.protocol),
  providerLabel: providerLabel(binding),
  smallModel: normalizedModelFast(binding.config),
  source,
});

const canonicalEndpoint = (binding: ConversationConnectionBinding): string =>
  redactedEndpoint(binding.config.baseUrl)?.toLocaleLowerCase('en-US') ??
  binding.config.baseUrl.trim().toLocaleLowerCase('en-US');

export const conversationModelDifferences = (
  conversation: ConversationConnectionBinding,
  current: ConversationConnectionBinding,
  conversationModel?: string,
): ClaudeConversationModelDifference[] => {
  const differences: ClaudeConversationModelDifference[] = [];
  if (conversation.config.preset !== current.config.preset) differences.push('platform');
  if (conversation.protocol !== current.protocol) differences.push('protocol');
  if (canonicalEndpoint(conversation) !== canonicalEndpoint(current)) differences.push('endpoint');
  if (conversation.config.authMode !== current.config.authMode) differences.push('authentication');
  if ((conversation.accountIdentity ?? '') !== (current.accountIdentity ?? '')) {
    differences.push('account');
  }
  if (
    conversation.credentialConfigured !== current.credentialConfigured ||
    (conversation.credentialFingerprint ?? '') !== (current.credentialFingerprint ?? '')
  ) {
    differences.push('credential');
  }
  if ((conversation.config.routerProviderId ?? '') !== (current.config.routerProviderId ?? '')) {
    differences.push('router-provider');
  }
  if ((conversationModel?.trim() || conversation.config.model) !== current.config.model) {
    differences.push('main-model');
  }
  if (normalizedModelFast(conversation.config) !== normalizedModelFast(current.config)) {
    differences.push('small-model');
  }
  return differences;
};

export const conversationBindingIsRestorable = (
  binding: ConversationConnectionBinding,
  current?: ConversationConnectionBinding,
): boolean => {
  if (isSubscriptionPreset(binding.config.preset) || binding.config.authMode === 'existing') {
    return !(
      binding.accountIdentity &&
      current?.accountIdentity &&
      binding.accountIdentity !== current.accountIdentity
    );
  }
  if (binding.config.authMode === 'none') return true;
  if (binding.config.credential) return true;
  return binding.protocol === 'openai' && Boolean(binding.config.routerProviderId);
};
