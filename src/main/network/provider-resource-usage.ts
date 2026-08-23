import { createHash } from 'node:crypto';
import type { ResourceBalance, ResourceUsageView } from '../../shared/contracts';
import type { ClaudeProviderId } from '../../shared/claude/providers';
import { AsyncRefreshCache } from '../infra/async-refresh-cache';

const REFRESH_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ERROR_DETAIL_LENGTH = 300;

const RESPONSE_TOO_LARGE = '余额响应超过安全大小上限。';
const RESPONSE_INVALID_JSON = '官方余额接口没有返回有效 JSON。';
const REQUEST_CANCELLED = '官方余额读取已取消。';
const REQUEST_FAILED = '无法读取官方余额。';
const REQUEST_TIMED_OUT = '官方余额接口请求超时。';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

class ProviderResourceUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProviderResourceUsageError';
  }
}

interface ProviderResourceEndpoint {
  readonly parser: (value: unknown) => ResourceBalance | undefined;
  readonly url: string;
}

interface ProviderResourceUsageRun {
  readonly controller: AbortController;
  readonly waiters: Set<symbol>;
  settled: boolean;
}

const abortFailure = (signal: AbortSignal): ProviderResourceUsageError =>
  signal.reason instanceof ProviderResourceUsageError
    ? signal.reason
    : new ProviderResourceUsageError(REQUEST_CANCELLED);

const raceAbort = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw abortFailure(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortFailure(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const declaredResponseBytes = (response: Response): number | undefined => {
  const raw = response.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const sourceForProvider = (provider: ClaudeProviderId): ResourceUsageView['source'] =>
  provider === 'deepseek' ? 'deepseek-balance' : 'openrouter-key';

const safeFailureDetail = (error: unknown): string =>
  (error instanceof ProviderResourceUsageError ? error.message : REQUEST_FAILED).slice(
    0,
    MAX_ERROR_DETAIL_LENGTH,
  );

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

const endpointForProvider = (provider: ClaudeProviderId): ProviderResourceEndpoint | undefined =>
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

const readProviderBalance = async (
  endpoint: ProviderResourceEndpoint,
  credential: string,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<ResourceBalance | undefined> => {
  const controller = new AbortController();
  let completed = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyCancellationStarted = false;

  const cancelBody = (reason: Error): void => {
    if (bodyCancellationStarted) return;
    if (reader) {
      bodyCancellationStarted = true;
      void reader.cancel(reason).catch(() => undefined);
    } else if (response?.body && !response.body.locked) {
      bodyCancellationStarted = true;
      void response.body.cancel(reason).catch(() => undefined);
    }
  };
  const terminate = (reason: ProviderResourceUsageError): void => {
    cancelBody(reason);
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onCallerAbort = (): void => terminate(new ProviderResourceUsageError(REQUEST_CANCELLED));
  const onTimeout = (): void => terminate(new ProviderResourceUsageError(REQUEST_TIMED_OUT));
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    if (controller.signal.aborted) throw abortFailure(controller.signal);
    const responsePromise = Promise.resolve().then(() =>
      fetchImplementation(endpoint.url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${credential}` },
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      }),
    );
    void responsePromise.then(
      (lateResponse) => {
        if (completed || controller.signal.aborted) {
          response = lateResponse;
          cancelBody(abortFailure(controller.signal));
        }
      },
      () => undefined,
    );
    response = await raceAbort(responsePromise, controller.signal);
    if ((declaredResponseBytes(response) ?? 0) > MAX_RESPONSE_BYTES) {
      throw new ProviderResourceUsageError(RESPONSE_TOO_LARGE);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const chunk = await raceAbort(reader.read(), controller.signal);
        if (chunk.done) break;
        if (chunk.value.byteLength > MAX_RESPONSE_BYTES - totalBytes) {
          throw new ProviderResourceUsageError(RESPONSE_TOO_LARGE);
        }
        chunks.push(Buffer.from(chunk.value));
        totalBytes += chunk.value.byteLength;
      }
    }
    if (!response.ok) {
      throw new ProviderResourceUsageError(`官方余额接口返回 HTTP ${response.status}。`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) as unknown;
    } catch {
      throw new ProviderResourceUsageError(RESPONSE_INVALID_JSON);
    }
    const balance = endpoint.parser(parsed);
    if (controller.signal.aborted) throw abortFailure(controller.signal);
    return balance;
  } catch (error) {
    const failure = controller.signal.aborted
      ? abortFailure(controller.signal)
      : error instanceof ProviderResourceUsageError
        ? error
        : new ProviderResourceUsageError(REQUEST_FAILED);
    terminate(failure);
    throw failure;
  } finally {
    completed = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    reader?.releaseLock();
  }
};

export class ProviderResourceUsageService {
  private readonly activeRuns = new Map<string, ProviderResourceUsageRun>();
  private readonly cache = new Map<string, AsyncRefreshCache<ResourceUsageView>>();

  public constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  private attachWaiter(
    cacheKey: string,
    cache: AsyncRefreshCache<ResourceUsageView>,
    run: ProviderResourceUsageRun,
    signal?: AbortSignal,
  ): () => void {
    const waiter = Symbol(cacheKey);
    let released = false;
    run.waiters.add(waiter);
    const release = (): void => {
      if (released) return;
      released = true;
      run.waiters.delete(waiter);
      if (run.waiters.size === 0 && !run.settled && this.activeRuns.get(cacheKey) === run) {
        this.activeRuns.delete(cacheKey);
        cache.clear();
        run.controller.abort(new ProviderResourceUsageError(REQUEST_CANCELLED));
      }
    };
    const onAbort = (): void => release();
    if (signal?.aborted) release();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return () => {
      signal?.removeEventListener('abort', onAbort);
      release();
    };
  }

  public async read(
    projectKey: string,
    provider: ClaudeProviderId,
    credential: string | undefined,
    force = false,
    signal?: AbortSignal,
  ): Promise<ResourceUsageView | undefined> {
    const endpoint = endpointForProvider(provider);
    if (!endpoint || !credential) {
      return undefined;
    }
    const source = sourceForProvider(provider);
    if (signal?.aborted) {
      return {
        availability: 'unavailable',
        capabilities: { balance: true, context: false, windows: false },
        checkedAt: Date.now(),
        detail: REQUEST_CANCELLED,
        source,
      };
    }
    const cacheKey = cacheKeyForCredential(projectKey, provider, credential);
    let cache = this.cache.get(cacheKey);
    if (!cache) {
      cache = new AsyncRefreshCache<ResourceUsageView>(REFRESH_INTERVAL_MS);
      this.cache.set(cacheKey, cache);
    }
    const request = cache.get(async () => {
      const run: ProviderResourceUsageRun = {
        controller: new AbortController(),
        settled: false,
        waiters: new Set(),
      };
      this.activeRuns.set(cacheKey, run);
      try {
        const checkedAt = Date.now();
        const balance = await readProviderBalance(
          endpoint,
          credential,
          this.fetchImplementation,
          this.requestTimeoutMs,
          run.controller.signal,
        );
        return balance
          ? {
              availability: 'available',
              balance,
              capabilities: { balance: true, context: false, windows: false },
              checkedAt,
              source,
              staleAt: checkedAt + STALE_AFTER_MS,
            }
          : {
              availability: 'unavailable',
              capabilities: { balance: true, context: false, windows: false },
              checkedAt,
              detail: '官方接口没有返回可显示的余额。',
              source,
            };
      } finally {
        run.settled = true;
        if (this.activeRuns.get(cacheKey) === run) {
          this.activeRuns.delete(cacheKey);
        }
      }
    }, force);
    const run = this.activeRuns.get(cacheKey);
    const detachWaiter = run ? this.attachWaiter(cacheKey, cache, run, signal) : () => undefined;
    try {
      return await (signal ? raceAbort(request, signal) : request);
    } catch (error) {
      return {
        availability: 'unavailable',
        capabilities: { balance: true, context: false, windows: false },
        checkedAt: Date.now(),
        detail: safeFailureDetail(error),
        source,
      };
    } finally {
      detachWaiter();
    }
  }
}
