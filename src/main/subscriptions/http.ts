import { setTimeout as sleep } from 'node:timers/promises';

export class SubscriptionError extends Error {
  public constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const requiredText = (value: unknown, max = 16384): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    hasControlCharacters(value)
  ) {
    throw new SubscriptionError('授权服务返回了无效数据，请重试。');
  }
  return value;
};

export const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

export const safeSubscriptionMessage = (error: unknown): string =>
  error instanceof SubscriptionError ? error.message : '订阅连接失败，请重试。';

export const readBoundedJson = async (
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  if (!response.body) throw new SubscriptionError('授权服务没有返回数据。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new SubscriptionError('授权服务响应过大。');
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export interface AuthContext {
  fetch: typeof fetch;
  signal: AbortSignal;
  open: (url: string) => Promise<void>;
  userCode: (code: string) => void;
  network?: <T>(url: string, operation: () => Promise<T>, signal: AbortSignal) => Promise<T>;
}

export const authJson = async (
  ctx: Pick<AuthContext, 'fetch' | 'signal' | 'network'>,
  url: string,
  init: RequestInit = {},
): Promise<{ body: Record<string, unknown>; status: number }> => {
  ctx.signal.throwIfAborted();
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]);
  try {
    const operation = async () => {
      const response = await ctx.fetch(url, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal,
      });
      const body = await readBoundedJson(response, signal);
      signal.throwIfAborted();
      return { body, status: response.status };
    };
    return await (ctx.network ? ctx.network(url, operation, signal) : operation());
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError('无法连接授权服务，请检查网络后重试。', 502);
  }
};

export const formBody = (
  values: Record<string, string>,
  headers: Record<string, string> = {},
): RequestInit => ({
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    ...headers,
  },
  body: new URLSearchParams(values).toString(),
});

export const openAuthorization = async (
  ctx: AuthContext,
  value: unknown,
  origins: readonly string[],
): Promise<void> => {
  const url = new URL(requiredText(value, 8192));
  if (url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin)) {
    throw new SubscriptionError('授权服务返回了非官方登录地址，已停止连接。');
  }
  ctx.signal.throwIfAborted();
  await ctx.open(url.toString());
  ctx.signal.throwIfAborted();
};

export const waitForPoll = async (
  interval: number,
  deadline: number,
  signal: AbortSignal,
): Promise<void> => {
  signal.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SubscriptionError('登录已超时，请重新连接。');
  await sleep(Math.min(interval, remaining), undefined, { signal });
  if (Date.now() >= deadline) throw new SubscriptionError('登录已超时，请重新连接。');
};

export const expiresAt = (value: unknown, relative = false): number => {
  const n = Number(value);
  const expiry = relative || n < 1e9 ? Date.now() + n * 1000 : n < 1e12 ? n * 1000 : n;
  if (!Number.isFinite(n) || !Number.isFinite(expiry) || n <= 0 || expiry <= Date.now()) {
    throw new SubscriptionError('授权已过期，请重新登录。', 401);
  }
  return expiry;
};
