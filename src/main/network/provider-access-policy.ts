import {
  completeConnectionEndpoint,
  normalizeConnectionBaseUrl,
} from '../../shared/router/connection-endpoint';
import { findClaudeProvider, type ClaudeProviderDefinition } from '../../shared/claude/providers';
import { isSubscriptionProvider } from '../../shared/claude/subscriptions';

export type ProviderConnectionProtocol = 'anthropic' | 'openai' | 'openai-responses';
export type ProviderAccessSurface = 'chat' | 'claude';

export interface ProviderAccessPolicyInput {
  /** Either spelling is accepted so this boundary can validate Claude and chat save inputs. */
  address?: string;
  baseUrl?: string;
  credential?: string;
  preset?: string;
  protocol?: ProviderConnectionProtocol;
}

export interface ProviderAccessPolicyOptions {
  /** The effective local Claude route created after an OpenAI upstream was saved in the Router. */
  allowRoutedEffectiveRoute?: boolean;
  surface?: ProviderAccessSurface;
}

const qwenCodingPlanCredential = /^sk-sp-/;

const providerFor = (preset: string | undefined): ClaudeProviderDefinition | undefined =>
  findClaudeProvider(preset);

/** The protocol a fixed catalog preset owns; flexible presets deliberately return undefined. */
export type FixedProviderProtocol = 'anthropic' | 'openai';

export const fixedProviderProtocol = (
  preset: string | undefined,
): FixedProviderProtocol | undefined => {
  const provider = providerFor(preset);
  if (!provider || !provider.fixedProtocol || provider.editableBaseUrl || !provider.baseUrl) {
    return undefined;
  }
  return provider.protocol ?? 'anthropic';
};

export const allowedProtocolsForProvider = (
  preset: string | undefined,
): readonly ProviderConnectionProtocol[] | undefined => {
  const protocol = fixedProviderProtocol(preset);
  return protocol ? [protocol] : undefined;
};

const fixedProviderEndpointMatches = (
  provider: ClaudeProviderDefinition,
  address: string,
  protocol: ProviderConnectionProtocol,
): boolean => {
  try {
    if (protocol === 'anthropic') {
      return normalizeConnectionBaseUrl(address) === normalizeConnectionBaseUrl(provider.baseUrl);
    }
    return (
      completeConnectionEndpoint(address, 'openai') ===
      completeConnectionEndpoint(provider.baseUrl, 'openai')
    );
  } catch {
    return false;
  }
};

const assertCredentialPolicy = (
  provider: ClaudeProviderDefinition,
  credential: string | undefined,
  surface: ProviderAccessSurface,
): void => {
  // The Chat catalog hides coding plans and managed subscriptions, but the main process must
  // enforce that boundary even when a renderer submits a forged preset or an old profile is loaded.
  if (surface === 'chat' && provider.id === 'chatgpt-subscription') {
    throw new Error('ChatGPT 订阅用于编程工具，请在“模型”页使用。');
  }
  if (provider.codingPlan && surface === 'chat') {
    throw new Error('此 Coding Plan 订阅用于编程工具，请在“模型”页使用。');
  }
  if (!credential) return;
  if (
    provider.credentialKind === 'coding-plan' &&
    provider.product === 'qwen-coding-plan' &&
    !qwenCodingPlanCredential.test(credential)
  ) {
    throw new Error('请填写 Coding Plan 密钥，普通 API 密钥请使用“千问 API”。');
  }
  if (
    provider.credentialKind === 'dashscope-api-key' &&
    provider.product === 'bailian-model-studio' &&
    qwenCodingPlanCredential.test(credential)
  ) {
    throw new Error('这是 Coding Plan 密钥，请选择“千问 Coding Plan”。');
  }
};

/**
 * The main-process provider boundary shared by save, test, automatic detection and replay paths.
 * Fixed presets own both their documented endpoint and protocol; custom and Router presets remain
 * free to use the generic protocol probing path.
 */
export const assertProviderAccessPolicy = (
  input: ProviderAccessPolicyInput,
  options: ProviderAccessPolicyOptions = {},
): ProviderConnectionProtocol | undefined => {
  const provider = providerFor(input.preset);
  if (!provider) return input.protocol;
  const surface = options.surface ?? 'claude';
  const address = input.address ?? input.baseUrl ?? '';

  assertCredentialPolicy(provider, input.credential?.trim(), surface);

  const expected = fixedProviderProtocol(input.preset);
  if (!expected) return input.protocol;
  if (input.protocol && input.protocol !== expected) {
    throw new Error(
      `“${provider.label}”固定使用 ${expected === 'openai' ? 'OpenAI' : 'Anthropic'} 协议。`,
    );
  }
  if (
    provider.baseUrl &&
    !options.allowRoutedEffectiveRoute &&
    !fixedProviderEndpointMatches(provider, address, expected)
  ) {
    throw new Error(`“${provider.label}”必须使用目录中的固定接口地址。`);
  }
  return expected;
};

/** Applies the catalog protocol to a fixed preset without changing its endpoint or other fields. */
export const withProviderProtocol = <T extends ProviderAccessPolicyInput>(input: T): T => {
  const protocol = assertProviderAccessPolicy(input);
  return protocol && !input.protocol ? ({ ...input, protocol } as T) : input;
};

export const assertClaudeProviderAccess = (
  input: ProviderAccessPolicyInput,
  options: Omit<ProviderAccessPolicyOptions, 'surface'> = {},
): ProviderConnectionProtocol | undefined =>
  assertProviderAccessPolicy(input, { ...options, surface: 'claude' });

export const assertChatProviderAccess = (
  input: ProviderAccessPolicyInput,
): ProviderConnectionProtocol | undefined => assertProviderAccessPolicy(input, { surface: 'chat' });

export const isQwenCodingPlanCredential = (credential: string | undefined): boolean =>
  Boolean(credential && qwenCodingPlanCredential.test(credential.trim()));

export const isFixedProvider = (preset: string | undefined): boolean =>
  fixedProviderProtocol(preset) !== undefined;

export const isProviderManagedSubscription = (preset: string | undefined): boolean =>
  Boolean(preset && (isSubscriptionProvider(preset) || preset === 'chatgpt-subscription'));
