import type {
  ClaudeRouterProviderProtocol,
  ClaudeRouterProviderView,
  SaveClaudeRouterProviderInput,
} from '../../shared/contracts';
import { completeConnectionEndpoint } from '../../shared/router/connection-endpoint';

const PROVIDER_PROTOCOLS = new Set<ClaudeRouterProviderProtocol>([
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
]);
const PROVIDER_PROTOCOL_VALUES = new Set([
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
]);

interface CcrProviderConfig extends Record<string, unknown> {
  id?: unknown;
  models?: unknown;
  name?: unknown;
}

export interface CcrAppConfig extends Record<string, unknown> {
  APIKEY?: unknown;
  APIKEYS?: unknown;
  Providers?: unknown;
  preferredProvider?: unknown;
}

interface NormalizedRouterProviderInput extends Omit<
  SaveClaudeRouterProviderInput,
  'apiKey' | 'baseUrl' | 'id' | 'models' | 'name'
> {
  apiKey?: string;
  baseUrl: string;
  id?: string;
  models: string[];
  name: string;
}

interface UpdatedRouterConfig {
  config: CcrAppConfig;
  providerId: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizeProviderBaseUrl = (value: string, protocol: ClaudeRouterProviderProtocol): string =>
  completeConnectionEndpoint(value, protocol === 'anthropic_messages' ? 'anthropic' : 'openai');

export const normalizeRouterProviderInput = (
  input: SaveClaudeRouterProviderInput,
): NormalizedRouterProviderInput => {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) {
    throw new Error('服务提供方名称只能包含字母、数字、点、下划线和短横线。');
  }
  if (input.id !== undefined && (input.id.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(input.id))) {
    throw new Error('服务提供方标识无效。');
  }
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) {
    throw new Error('服务提供方协议不受支持。');
  }
  const models = [
    ...new Set(input.models.map((model) => model.trim()).filter((model) => Boolean(model))),
  ];
  if (
    models.length === 0 ||
    models.length > 50 ||
    models.some((model) => !/^[-A-Za-z0-9._:/@[\]]{1,200}$/.test(model))
  ) {
    throw new Error('模型标识只能包含字母、数字以及 . _ : / @ [ ] -。');
  }
  const apiKey = input.apiKey?.trim();
  if (input.credentialAction === 'replace' && !apiKey) {
    throw new Error('新增或替换服务提供方时必须填写上游接口密钥。');
  }
  if (apiKey && (apiKey.length > 20_000 || /[\r\n]/.test(apiKey))) {
    throw new Error('上游接口密钥格式无效。');
  }
  return {
    apiKey,
    baseUrl: normalizeProviderBaseUrl(input.baseUrl, input.protocol),
    credentialAction: input.credentialAction,
    id: input.id,
    makePreferred: Boolean(input.makePreferred),
    models,
    name,
    protocol: input.protocol,
    useForCurrentProject: Boolean(input.useForCurrentProject),
  };
};

const providerBaseUrl = (provider: Record<string, unknown>): string =>
  optionalString(provider.api_base_url) ??
  optionalString(provider.baseUrl) ??
  optionalString(provider.baseurl) ??
  '';

const providerProtocol = (provider: Record<string, unknown>): ClaudeRouterProviderProtocol => {
  const type = optionalString(provider.type);
  return type && PROVIDER_PROTOCOL_VALUES.has(type)
    ? (type as ClaudeRouterProviderProtocol)
    : 'openai_chat_completions';
};

const providerHasCredential = (provider: Record<string, unknown>): boolean => {
  if (
    optionalString(provider.api_key) ||
    optionalString(provider.apiKey) ||
    optionalString(provider.apikey)
  ) {
    return true;
  }
  return (
    Array.isArray(provider.credentials) &&
    provider.credentials.some(
      (credential) =>
        isRecord(credential) &&
        Boolean(
          optionalString(credential.api_key) ??
          optionalString(credential.apiKey) ??
          optionalString(credential.apikey),
        ),
    )
  );
};

const providerModels = (provider: Record<string, unknown>): string[] =>
  Array.isArray(provider.models)
    ? provider.models
        .filter((model): model is string => typeof model === 'string')
        .map((model) => model.trim())
        .filter(Boolean)
        .slice(0, 50)
    : [];

const providerView = (
  provider: Record<string, unknown>,
  index: number,
  preferredProvider: string,
): ClaudeRouterProviderView => {
  const name = optionalString(provider.name) ?? `服务提供方 ${index + 1}`;
  const id =
    optionalString(provider.id) ??
    name
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '') ??
    `provider-${index + 1}`;
  return {
    baseUrl: providerBaseUrl(provider),
    credentialConfigured: providerHasCredential(provider),
    id: id || `provider-${index + 1}`,
    models: providerModels(provider),
    name,
    preferred: preferredProvider === name || preferredProvider === id,
    protocol: providerProtocol(provider),
  };
};

const providerRecords = (config: CcrAppConfig): CcrProviderConfig[] =>
  Array.isArray(config.Providers)
    ? config.Providers.filter((provider): provider is CcrProviderConfig => isRecord(provider))
    : [];

export const sanitizeRouterConfig = (config: CcrAppConfig): ClaudeRouterProviderView[] => {
  const preferredProvider = optionalString(config.preferredProvider) ?? '';
  return providerRecords(config).map((provider, index) =>
    providerView(provider, index, preferredProvider),
  );
};

const providerSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'provider';

const uniqueProviderId = (providers: CcrProviderConfig[], name: string): string => {
  const base = providerSlug(name);
  const existing = new Set(
    providers.map((provider) => optionalString(provider.id)).filter(Boolean),
  );
  if (!existing.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
};

export const buildUpdatedRouterConfig = (
  source: CcrAppConfig,
  rawInput: SaveClaudeRouterProviderInput,
): UpdatedRouterConfig => {
  const input = normalizeRouterProviderInput(rawInput);
  const config = structuredClone(source);
  const providers = providerRecords(config);
  const existingIndex = input.id
    ? providers.findIndex((provider) => optionalString(provider.id) === input.id)
    : -1;
  if (input.id && existingIndex < 0) {
    throw new Error('要编辑的服务提供方已不存在，请重新检测。');
  }
  const duplicateIndex = providers.findIndex(
    (provider, index) => index !== existingIndex && optionalString(provider.name) === input.name,
  );
  if (duplicateIndex >= 0) {
    throw new Error('服务提供方名称已存在，请换一个名称。');
  }

  const previous = existingIndex >= 0 ? providers[existingIndex] : undefined;
  const providerId = optionalString(previous?.id) ?? uniqueProviderId(providers, input.name);
  const capabilities = Array.isArray(previous?.capabilities)
    ? previous.capabilities.filter(
        (capability) =>
          isRecord(capability) &&
          !PROVIDER_PROTOCOL_VALUES.has(optionalString(capability.type) ?? ''),
      )
    : [];
  const next: CcrProviderConfig = {
    ...(previous ?? {}),
    api_base_url: input.baseUrl,
    capabilities: [
      ...capabilities,
      {
        baseUrl: input.baseUrl,
        source: 'detected',
        type: input.protocol,
      },
    ],
    id: providerId,
    models: input.models,
    name: input.name,
    type: input.protocol,
  };
  delete next.baseUrl;
  delete next.baseurl;
  if (input.credentialAction === 'replace') {
    next.api_key = input.apiKey ?? '';
    delete next.apiKey;
    delete next.apikey;
  } else if (input.credentialAction === 'clear') {
    delete next.api_key;
    delete next.apiKey;
    delete next.apikey;
    delete next.credentials;
  }

  if (existingIndex >= 0) {
    providers[existingIndex] = next;
  } else {
    providers.push(next);
  }
  config.Providers = providers;
  if (
    input.makePreferred ||
    !optionalString(config.preferredProvider) ||
    (previous &&
      [optionalString(previous.name), optionalString(previous.id)].includes(
        optionalString(config.preferredProvider),
      ))
  ) {
    config.preferredProvider = input.name;
  }
  return { config, providerId };
};

export const buildDeletedRouterConfig = (
  source: CcrAppConfig,
  providerId: string,
): CcrAppConfig => {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(providerId)) {
    throw new Error('服务提供方标识无效。');
  }
  const config = structuredClone(source);
  const providers = providerRecords(config);
  const removed = providers.find((provider) => optionalString(provider.id) === providerId);
  if (!removed) {
    throw new Error('要删除的服务提供方已不存在。');
  }
  config.Providers = providers.filter((provider) => optionalString(provider.id) !== providerId);
  if (
    [optionalString(removed.name), optionalString(removed.id)].includes(
      optionalString(config.preferredProvider),
    )
  ) {
    config.preferredProvider = optionalString(providerRecords(config)[0]?.name) ?? '';
  }
  return config;
};

export const readGatewayApiKey = (config: CcrAppConfig): string => {
  const direct = optionalString(config.APIKEY);
  if (direct) {
    return direct;
  }
  if (Array.isArray(config.APIKEYS)) {
    for (const candidate of config.APIKEYS) {
      if (isRecord(candidate)) {
        const key = optionalString(candidate.key);
        if (key) {
          return key;
        }
      }
    }
  }
  throw new Error('CCR 没有可用于本机网关的访问密钥。');
};
