import type { ResourceWindow } from '../../shared/contracts';
import type { ModelQuotaResult } from '../usage/quota';
import {
  ManagedQuotaAuthError,
  readManagedQuotaCredential,
  type ManagedQuotaAuthFailure,
} from './managed-chatgpt-quota-auth';

// Fixed service endpoint, not a user-configurable relay URL. This is a compatibility adapter:
// OpenAI documents account/rateLimits/read, but does not promise this underlying HTTP path's
// stability. Never fall back to another account, a paid inference call, or an estimated balance.
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type QuotaFailure =
  | ManagedQuotaAuthFailure
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'unsupported'
  | 'invalid-response'
  | 'service-unavailable';

const DETAILS: Record<QuotaFailure, string> = {
  'not-authorized': '尚未找到当前 ChatGPT 托管账户的授权，请先完成接入。',
  'invalid-auth': '当前 ChatGPT 授权缺少有效的账户信息；如持续出现，请重新授权。',
  'unsafe-auth': '无法安全读取当前 ChatGPT 授权文件，未发送额度请求。',
  'account-changing': 'ChatGPT 账户正在切换或授权尚未完成，稍后后台重试。',
  'ambiguous-account': '托管网关存在多个启用账户，无法确定当前账户额度，请重新接入所需账户。',
  timeout: 'ChatGPT 额度查询超时，稍后后台重试。',
  network: 'ChatGPT 额度查询网络异常，请检查应用代理；稍后后台重试。',
  unauthorized: 'ChatGPT 额度查询授权已失效，等待网关刷新；如持续出现，请重新授权。',
  forbidden: 'ChatGPT 额度请求被拒绝，请检查账户权限或应用网络；稍后后台重试。',
  'rate-limited': 'ChatGPT 额度查询过于频繁，稍后后台重试；不代表订阅额度已用尽。',
  unsupported: '当前 ChatGPT 账户或模型暂未返回可读取的订阅额度窗口。',
  'invalid-response': 'ChatGPT 额度响应格式暂不兼容，稍后后台重试。',
  'service-unavailable': 'ChatGPT 额度服务暂不可用，稍后后台重试。',
};

class QuotaError extends Error {
  public constructor(public readonly kind: QuotaFailure) {
    super(kind);
    this.name = 'ManagedChatGptQuotaError';
  }
}

export const unavailableManagedQuota = (
  reason: QuotaFailure,
  accountKey?: string,
): ModelQuotaResult => ({
  accountKey,
  clearPrevious: !accountKey,
  availability: 'unavailable',
  capabilities: { balance: false, context: false, windows: true },
  checkedAt: Date.now(),
  detail: DETAILS[reason],
  source: 'managed-chatgpt-gateway',
});

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const windowLabel = (seconds: number | undefined, index: number): string => {
  if (seconds === undefined) return index === 0 ? '主要窗口' : '次要窗口';
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
};

const parseWindow = (value: unknown, index: number, now: number): ResourceWindow[] => {
  if (!record(value) || !finite(value.used_percent)) return [];
  const duration =
    Number.isSafeInteger(value.limit_window_seconds) && (value.limit_window_seconds as number) > 0
      ? (value.limit_window_seconds as number)
      : undefined;
  const reset =
    Number.isSafeInteger(value.reset_at) && (value.reset_at as number) > 0
      ? (value.reset_at as number)
      : Number.isSafeInteger(value.reset_after_seconds) &&
          (value.reset_after_seconds as number) >= 0
        ? Math.floor(now / 1000) + (value.reset_after_seconds as number)
        : undefined;
  return [
    {
      label: windowLabel(duration, index),
      usedPercent: Math.max(0, Math.min(100, value.used_percent)),
      resetsAt:
        reset !== undefined && Number.isSafeInteger(reset) && reset <= 8_640_000_000_000
          ? reset
          : undefined,
      windowDurationMins: duration === undefined ? undefined : duration / 60,
    },
  ];
};

/** Only numeric subscription-window data is projected; plan names and credits are not percentages. */
export const parseManagedChatGptQuota = (
  value: unknown,
  model: string,
  now = Date.now(),
): ResourceWindow[] => {
  if (!record(value)) return [];
  const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const additional = Array.isArray(value.additional_rate_limits)
    ? value.additional_rate_limits
        .slice(0, 32)
        .find(
          (limit) =>
            record(limit) &&
            typeof limit.limit_name === 'string' &&
            normalize(limit.limit_name) === normalize(model),
        )
    : undefined;
  const limits = record(additional)
    ? additional.rate_limit
    : /spark/i.test(model)
      ? undefined
      : value.rate_limit;
  if (!record(limits)) return [];
  return [limits.primary_window, limits.secondary_window].flatMap((window, index) =>
    parseWindow(window, index, now),
  );
};

const responseJson = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new QuotaError(
      response.status === 401
        ? 'unauthorized'
        : response.status === 403
          ? 'forbidden'
          : response.status === 429
            ? 'rate-limited'
            : response.status === 404 || response.status === 405
              ? 'unsupported'
              : 'service-unavailable',
    );
  }
  if (response.redirected || (response.url && response.url !== USAGE_URL))
    throw new QuotaError('invalid-response');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
    throw new QuotaError('invalid-response');
  if (!response.body) throw new QuotaError('invalid-response');
  const reader = response.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new QuotaError('invalid-response');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown;
    } catch {
      throw new QuotaError('invalid-response');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
};

const untilAborted = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });

export class ManagedChatGptQuotaReader {
  private generation = 0;
  private readonly requests = new Set<AbortController>();

  public constructor(
    private readonly authDirectory: string,
    private readonly fetchImplementation: typeof fetch,
    private readonly canRead: () => boolean,
  ) {}

  public invalidate(): void {
    this.generation += 1;
    for (const request of this.requests) request.abort(new QuotaError('account-changing'));
  }

  public async read(model: string, signal?: AbortSignal): Promise<ModelQuotaResult> {
    if (!this.canRead() || signal?.aborted) return unavailableManagedQuota('account-changing');
    const generation = this.generation;
    const controller = new AbortController();
    this.requests.add(controller);
    const abort = (): void => controller.abort(new QuotaError('account-changing'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new QuotaError('timeout')), TIMEOUT_MS);
    timer.unref();
    let accountKey: string | undefined;
    const current = (): void => {
      controller.signal.throwIfAborted();
      if (generation !== this.generation || !this.canRead())
        throw new QuotaError('account-changing');
    };
    try {
      return await untilAborted(
        (async () => {
          const credential = await readManagedQuotaCredential(
            this.authDirectory,
            controller.signal,
          );
          current();
          accountKey = credential.accountKey;
          let payload: unknown;
          let requestSucceeded = false;
          let requestFailure: unknown;
          try {
            const response = await this.fetchImplementation(USAGE_URL, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${credential.accessToken}`,
                'Chatgpt-Account-Id': credential.accountId,
                Accept: 'application/json',
              },
              credentials: 'omit',
              cache: 'no-store',
              redirect: 'error',
              signal: controller.signal,
            });
            try {
              current();
              payload = await responseJson(response, controller.signal);
              requestSucceeded = true;
            } finally {
              void response.body?.cancel().catch(() => undefined);
            }
          } catch (error) {
            requestFailure = error;
          }
          current();
          const after = await readManagedQuotaCredential(this.authDirectory, controller.signal);
          current();
          if (after.accountKey !== credential.accountKey) throw new QuotaError('account-changing');
          if (!requestSucceeded) throw requestFailure;
          const checkedAt = Date.now();
          const windows = parseManagedChatGptQuota(payload, model, checkedAt);
          return windows.length
            ? {
                accountKey,
                availability: 'available' as const,
                capabilities: { balance: false, context: false, windows: true },
                checkedAt,
                detail: '当前 ChatGPT 账户上报的订阅额度 · 非 API 余额',
                source: 'managed-chatgpt-gateway' as const,
                windows,
              }
            : unavailableManagedQuota('unsupported', accountKey);
        })(),
        controller.signal,
      );
    } catch (error) {
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
      const kind =
        reason instanceof QuotaError || reason instanceof ManagedQuotaAuthError
          ? reason.kind
          : 'network';
      return unavailableManagedQuota(
        kind,
        reason instanceof ManagedQuotaAuthError || kind === 'account-changing'
          ? undefined
          : accountKey,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.requests.delete(controller);
    }
  }
}
