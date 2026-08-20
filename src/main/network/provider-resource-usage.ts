import { createHash } from 'node:crypto';
import type { ResourceBalance, ResourceUsageView } from '../../shared/contracts';
import type { ClaudeProviderId } from '../../shared/claude/providers';
import { AsyncRefreshCache } from '../infra/async-refresh-cache';

const REFRESH_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const limitedJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('余额响应超过安全大小上限。');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new Error('余额响应超过安全大小上限。');
  }
  if (!response.ok) {
    throw new Error(`官方余额接口返回 HTTP ${response.status}。`);
  }
  return JSON.parse(body.toString('utf8')) as unknown;
};

export const parseDeepSeekBalance = (value: unknown): ResourceBalance | undefined => {
  if (!isRecord(value) || value.is_available !== true || !Array.isArray(value.balance_infos)) {
    return undefined;
  }
  const balances = value.balance_infos.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.currency !== 'string') {
      return [];
    }
    const amount =
      typeof candidate.total_balance === 'string'
        ? Number(candidate.total_balance)
        : finiteNumber(candidate.total_balance);
    return Number.isFinite(amount)
      ? [{ amount: amount as number, currency: candidate.currency }]
      : [];
  });
  return balances.length > 0 ? { balances } : undefined;
};

export const parseOpenRouterBalance = (value: unknown): ResourceBalance | undefined => {
  if (!isRecord(value) || !isRecord(value.data)) {
    return undefined;
  }
  const rawLimit = value.data.limit;
  const limit = finiteNumber(rawLimit);
  const usage = finiteNumber(value.data.usage);
  const remaining =
    finiteNumber(value.data.limit_remaining) ??
    (limit !== undefined && usage !== undefined ? Math.max(0, limit - usage) : undefined);
  if (limit === undefined && usage === undefined && remaining === undefined) {
    return undefined;
  }
  return {
    balances: remaining === undefined ? undefined : [{ amount: remaining, currency: 'USD' }],
    limit,
    unlimited: rawLimit === null || (value.data.is_free_tier === false && limit === undefined),
    used: usage,
  };
};

const endpointForProvider = (
  provider: ClaudeProviderId,
): { parser: (value: unknown) => ResourceBalance | undefined; url: string } | undefined =>
  provider === 'deepseek'
    ? { parser: parseDeepSeekBalance, url: 'https://api.deepseek.com/user/balance' }
    : provider === 'openrouter'
      ? { parser: parseOpenRouterBalance, url: 'https://openrouter.ai/api/v1/key' }
      : undefined;

const cacheKeyForCredential = (
  projectKey: string,
  provider: ClaudeProviderId,
  credential: string,
): string => `${projectKey}\0${provider}\0${createHash('sha256').update(credential).digest('hex')}`;

export class ProviderResourceUsageService {
  private readonly cache = new Map<string, AsyncRefreshCache<ResourceUsageView>>();

  public constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  public async read(
    projectKey: string,
    provider: ClaudeProviderId,
    credential: string | undefined,
    force = false,
  ): Promise<ResourceUsageView | undefined> {
    const endpoint = endpointForProvider(provider);
    if (!endpoint || !credential) {
      return undefined;
    }
    const cacheKey = cacheKeyForCredential(projectKey, provider, credential);
    let cache = this.cache.get(cacheKey);
    if (!cache) {
      cache = new AsyncRefreshCache<ResourceUsageView>(REFRESH_INTERVAL_MS);
      this.cache.set(cacheKey, cache);
    }
    try {
      return await cache.get(async () => {
        const checkedAt = Date.now();
        const response = await this.fetchImplementation(endpoint.url, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${credential}` },
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const balance = endpoint.parser(await limitedJson(response));
        return balance
          ? {
              availability: 'available',
              balance,
              capabilities: { balance: true, context: false, windows: false },
              checkedAt,
              source: provider === 'deepseek' ? 'deepseek-balance' : 'openrouter-key',
              staleAt: checkedAt + STALE_AFTER_MS,
            }
          : {
              availability: 'unavailable',
              capabilities: { balance: true, context: false, windows: false },
              checkedAt,
              detail: '官方接口没有返回可显示的余额。',
              source: provider === 'deepseek' ? 'deepseek-balance' : 'openrouter-key',
            };
      }, force);
    } catch (error) {
      return {
        availability: 'unavailable',
        capabilities: { balance: true, context: false, windows: false },
        checkedAt: Date.now(),
        detail: error instanceof Error ? error.message : '无法读取官方余额。',
        source: provider === 'deepseek' ? 'deepseek-balance' : 'openrouter-key',
      };
    }
  }
}
