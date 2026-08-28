import type { NetworkProviderId } from '../../shared/contracts';
import { openAiModelsEndpoint } from '../../shared/router/connection-endpoint';
import { PROVIDER_PROFILES } from '../../shared/router/provider-profiles';

const MAX_MODEL_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 500;

export class ProviderModelDiscoveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProviderModelDiscoveryError';
  }
}

interface OfficialProviderDomain {
  readonly domain: string;
  readonly provider: NetworkProviderId;
}

const OFFICIAL_PROVIDER_DOMAINS: readonly OfficialProviderDomain[] = Object.values(
  PROVIDER_PROFILES,
)
  // The manual suite duplicates several providers' hosts and is never an authorization identity.
  .filter((profile) => profile.id !== 'ai-services')
  .flatMap((profile) =>
    [...new Set([...profile.requiredDomains, ...profile.authDomains])].map((domain) => ({
      domain: domain.toLowerCase(),
      provider: profile.id,
    })),
  )
  .sort((left, right) => right.domain.length - left.domain.length);

export interface ProviderModelDiscoveryTarget {
  readonly endpoint: string;
  readonly officialProvider?: NetworkProviderId;
}

export const officialProviderForHostname = (hostname: string): NetworkProviderId | undefined => {
  // URL preserves the DNS root marker in a fully qualified hostname (`api.example.com.`).
  // DNS treats that name as the same host, so classification must do the same or a renderer could
  // bypass the official-provider guard while the transport still reaches the official endpoint.
  const dnsHostname = hostname.replace(/\.+$/, '');
  return OFFICIAL_PROVIDER_DOMAINS.find(
    ({ domain }) => dnsHostname === domain || dnsHostname.endsWith(`.${domain}`),
  )?.provider;
};

/** Main-owned classification for the exact URL that the discovery transport will request. */
export const resolveProviderModelDiscoveryTarget = (
  baseUrl: string,
): Readonly<ProviderModelDiscoveryTarget> => {
  const endpoint = openAiModelsEndpoint(baseUrl);
  const parsed = new URL(endpoint);
  const officialProvider =
    parsed.protocol === 'https:'
      ? officialProviderForHostname(parsed.hostname.toLowerCase())
      : undefined;
  return Object.freeze({
    endpoint,
    ...(officialProvider === undefined ? {} : { officialProvider }),
  });
};

interface OpenAiModelEnvelope {
  data?: unknown;
}

const readBoundedResponse = async (response: Response): Promise<Buffer> => {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, size);
    }
    size += value.byteLength;
    if (size > MAX_MODEL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderModelDiscoveryError('模型列表超过安全大小上限。');
    }
    chunks.push(Buffer.from(value));
  }
};

export const parseOpenAiModelIds = (value: unknown): string[] => {
  if (!value || typeof value !== 'object') {
    throw new ProviderModelDiscoveryError('模型接口返回了无效数据。');
  }
  const data = (value as OpenAiModelEnvelope).data;
  if (!Array.isArray(data)) {
    throw new ProviderModelDiscoveryError('模型接口没有返回模型列表。');
  }
  const models = [
    ...new Set(
      data
        .map((entry) =>
          entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
            ? (entry as { id: string }).id.trim()
            : '',
        )
        .filter((model) => /^[-A-Za-z0-9._:/@[\]]{1,200}$/.test(model)),
    ),
  ].slice(0, MAX_MODELS);
  if (models.length === 0) {
    throw new ProviderModelDiscoveryError('模型接口当前没有可用模型。');
  }
  return models;
};

export const discoverOpenAiModelsAtTarget = async (
  target: Readonly<ProviderModelDiscoveryTarget>,
  credential: string | undefined,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string[]> => {
  try {
    const response = await fetchImplementation(target.endpoint, {
      headers: credential?.trim() ? { Authorization: `Bearer ${credential.trim()}` } : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new ProviderModelDiscoveryError(
        response.status === 401 || response.status === 403
          ? '模型接口拒绝了当前密钥，请检查密钥是否属于这个服务商。'
          : `模型接口返回 HTTP ${response.status}。`,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_MODEL_RESPONSE_BYTES) {
      throw new ProviderModelDiscoveryError('模型列表超过安全大小上限。');
    }
    const bytes = await readBoundedResponse(response);
    try {
      const models = parseOpenAiModelIds(JSON.parse(bytes.toString('utf8')) as unknown);
      const normalizedCredential = credential?.trim();
      const safeModels = normalizedCredential
        ? models.filter((model) => !model.includes(normalizedCredential))
        : models;
      if (safeModels.length === 0) {
        throw new ProviderModelDiscoveryError('模型接口当前没有可用模型。');
      }
      return safeModels;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ProviderModelDiscoveryError('模型接口没有返回有效 JSON。');
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ProviderModelDiscoveryError) {
      throw error;
    }
    throw new ProviderModelDiscoveryError('无法读取当前接口的模型列表，请检查地址与网络状态。');
  }
};

export const discoverOpenAiModels = (
  baseUrl: string,
  credential: string | undefined,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string[]> =>
  discoverOpenAiModelsAtTarget(
    resolveProviderModelDiscoveryTarget(baseUrl),
    credential,
    fetchImplementation,
    timeoutMs,
  );
