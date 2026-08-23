import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseDeepSeekBalance,
  parseOpenRouterBalance,
  ProviderResourceUsageService,
} from '../../src/main/network/provider-resource-usage';

const MAX_RESPONSE_BYTES = 64 * 1024;
const encoder = new TextEncoder();

interface StreamResponseOptions {
  readonly close?: boolean;
  readonly headers?: HeadersInit;
  readonly onCancel?: (reason: unknown) => void;
  readonly status?: number;
}

const streamResponse = (
  chunks: readonly Uint8Array[],
  options: StreamResponseOptions = {},
): Response => {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel: options.onCancel,
      pull(controller) {
        const chunk = chunks[index];
        if (chunk) {
          index += 1;
          controller.enqueue(chunk);
        } else if (options.close !== false) {
          controller.close();
        }
      },
    }),
    { headers: options.headers, status: options.status ?? 200 },
  );
};

const deepSeekPayload = (paddingLength = 0): string =>
  JSON.stringify({
    balance_infos: [{ currency: 'CNY', total_balance: '9.00' }],
    is_available: true,
    padding: 'x'.repeat(paddingLength),
  });

const exactBoundaryPayload = (): Uint8Array => {
  const empty = deepSeekPayload();
  const payload = deepSeekPayload(MAX_RESPONSE_BYTES - Buffer.byteLength(empty));
  const bytes = encoder.encode(payload);
  expect(bytes.byteLength).toBe(MAX_RESPONSE_BYTES);
  return bytes;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('provider resource usage adapters', () => {
  it('maps DeepSeek official balance without inventing missing currencies', () => {
    expect(
      parseDeepSeekBalance({
        balance_infos: [
          {
            currency: 'CNY',
            granted_balance: '1.00',
            topped_up_balance: '4.50',
            total_balance: '5.50',
          },
        ],
        is_available: true,
      }),
    ).toEqual({ balances: [{ amount: 5.5, currency: 'CNY' }] });
    expect(parseDeepSeekBalance({ balance_infos: [], is_available: false })).toBeUndefined();
  });

  it('maps OpenRouter key usage and derives remaining credit only when the inputs exist', () => {
    expect(parseOpenRouterBalance({ data: { limit: 20, usage: 7.25 } })).toEqual({
      balances: [{ amount: 12.75, currency: 'USD' }],
      limit: 20,
      unlimited: false,
      used: 7.25,
    });
    expect(parseOpenRouterBalance({ data: {} })).toBeUndefined();
    expect(parseOpenRouterBalance({ data: { limit: null, usage: 3 } })).toEqual({
      balances: undefined,
      limit: undefined,
      unlimited: true,
      used: 3,
    });
  });

  it('does not reuse cached balance after the provider or credential changes', async () => {
    const requests: Array<{
      authorization: string | null;
      method: string | undefined;
      redirect: RequestRedirect | undefined;
      url: string;
    }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        method: init?.method,
        redirect: init?.redirect,
        url,
      });
      return new Response(
        JSON.stringify(
          url.includes('deepseek')
            ? {
                balance_infos: [{ currency: 'CNY', total_balance: '9.00' }],
                is_available: true,
              }
            : { data: { limit: 20, usage: 5 } },
        ),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    };
    const service = new ProviderResourceUsageService(fetchImplementation);

    const deepSeek = await service.read('project', 'deepseek', 'secret-a');
    const openRouter = await service.read('project', 'openrouter', 'secret-b');
    const changedCredential = await service.read('project', 'openrouter', 'secret-c');

    expect(deepSeek?.balance?.balances).toEqual([{ amount: 9, currency: 'CNY' }]);
    expect(openRouter?.balance?.balances).toEqual([{ amount: 15, currency: 'USD' }]);
    expect(changedCredential?.balance?.balances).toEqual([{ amount: 15, currency: 'USD' }]);
    expect(requests).toEqual([
      {
        authorization: 'Bearer secret-a',
        method: 'GET',
        redirect: 'error',
        url: 'https://api.deepseek.com/user/balance',
      },
      {
        authorization: 'Bearer secret-b',
        method: 'GET',
        redirect: 'error',
        url: 'https://openrouter.ai/api/v1/key',
      },
      {
        authorization: 'Bearer secret-c',
        method: 'GET',
        redirect: 'error',
        url: 'https://openrouter.ai/api/v1/key',
      },
    ]);
  });

  it('rejects and cancels an oversized single response chunk before buffering it', async () => {
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const service = new ProviderResourceUsageService(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return streamResponse([new Uint8Array(MAX_RESPONSE_BYTES + 1)], {
        close: false,
        onCancel: cancelled,
      });
    });

    const result = await service.read('project', 'deepseek', 'secret');

    expect(result).toMatchObject({
      availability: 'unavailable',
      detail: '余额响应超过安全大小上限。',
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('rejects and cancels a response that crosses the limit over many chunks', async () => {
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const chunks = Array.from({ length: 65 }, () => new Uint8Array(1024));
    const service = new ProviderResourceUsageService(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return streamResponse(chunks, { close: false, onCancel: cancelled });
    });

    const result = await service.read('project', 'deepseek', 'secret');

    expect(result?.detail).toBe('余额响应超过安全大小上限。');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('accepts a valid response exactly at the 64 KiB boundary', async () => {
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const bytes = exactBoundaryPayload();
    const chunks = Array.from({ length: 16 }, (_value, index) =>
      bytes.subarray(index * 4096, (index + 1) * 4096),
    );
    const service = new ProviderResourceUsageService(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return streamResponse(chunks, {
        headers: { 'content-length': String(MAX_RESPONSE_BYTES) },
        onCancel: cancelled,
      });
    });

    const result = await service.read('project', 'deepseek', 'secret');

    expect(result).toMatchObject({
      availability: 'available',
      balance: { balances: [{ amount: 9, currency: 'CNY' }] },
    });
    expect(cancelled).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);
  });

  it('times out a slow response stream and cancels both body and request', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const service = new ProviderResourceUsageService(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return streamResponse([], { close: false, onCancel: cancelled });
    }, 25);

    const pending = service.read('project', 'deepseek', 'secret');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result?.detail).toBe('官方余额接口请求超时。');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a coalesced refresh alive when its first caller aborts but another waiter remains', async () => {
    const firstCaller = new AbortController();
    const bodyCancelled = vi.fn();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel: bodyCancelled,
          start(controller) {
            bodyController = controller;
          },
        }),
        { status: 200 },
      );
    });
    const service = new ProviderResourceUsageService(fetchImplementation);

    const first = service.read('project', 'deepseek', 'shared-secret', false, firstCaller.signal);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    const second = service.read('project', 'deepseek', 'shared-secret');
    await Promise.resolve();
    firstCaller.abort();

    const firstResult = await first;
    expect(firstResult?.detail).toBe('官方余额读取已取消。');
    expect(requestSignal?.aborted).toBe(false);
    expect(bodyCancelled).not.toHaveBeenCalled();

    bodyController.enqueue(encoder.encode(deepSeekPayload()));
    bodyController.close();
    const secondResult = await second;

    expect(secondResult).toMatchObject({
      availability: 'available',
      balance: { balances: [{ amount: 9, currency: 'CNY' }] },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(false);
  });

  it('honors caller abort, cancels a late response, and never publishes it into the cache', async () => {
    const credential = 'caller-secret';
    const caller = new AbortController();
    const removeAbortListener = vi.spyOn(caller.signal, 'removeEventListener');
    const lateCancelled = vi.fn();
    let resolveLateResponse!: (response: Response) => void;
    const lateResponse = new Promise<Response>((resolve) => {
      resolveLateResponse = resolve;
    });
    const requestSignals: AbortSignal[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      if (requestSignals.length === 1) return lateResponse;
      return new Response(deepSeekPayload(), { status: 200 });
    });
    const service = new ProviderResourceUsageService(fetchImplementation);

    const pending = service.read('project', 'deepseek', credential, false, caller.signal);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    caller.abort(new Error(`cancel ${credential}`));
    const cancelled = await pending;

    expect(cancelled?.detail).toBe('官方余额读取已取消。');
    expect(JSON.stringify(cancelled)).not.toContain(credential);
    expect(requestSignals[0]?.aborted).toBe(true);
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));

    const retry = await service.read('project', 'deepseek', credential, true);
    expect(retry?.availability).toBe('available');
    resolveLateResponse(
      streamResponse([], {
        close: false,
        onCancel: lateCancelled,
      }),
    );
    await vi.waitFor(() => expect(lateCancelled).toHaveBeenCalledOnce());

    const cached = await service.read('project', 'deepseek', credential);
    expect(cached?.availability).toBe('available');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('cancels terminal parse failures and returns a typed bounded error', async () => {
    const reader = {
      cancel: vi.fn().mockResolvedValue(undefined),
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: encoder.encode('{"broken":') })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    let requestSignal: AbortSignal | undefined;
    const response = {
      body: { getReader: () => reader },
      headers: new Headers(),
      ok: true,
      status: 200,
    } as unknown as Response;
    const service = new ProviderResourceUsageService(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return response;
    });

    const result = await service.read('project', 'deepseek', 'secret');

    expect(result?.detail).toBe('官方余额接口没有返回有效 JSON。');
    expect(result?.detail?.length).toBeLessThanOrEqual(300);
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('cancels terminal read failures without exposing credentials', async () => {
    const credential = 'credential-in-read-error';
    const reader = {
      cancel: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockRejectedValue(new Error(`${credential}:${'x'.repeat(10_000)}`)),
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    let requestSignal: AbortSignal | undefined;
    const response = {
      body: { getReader: () => reader },
      headers: new Headers(),
      ok: true,
      status: 200,
    } as unknown as Response;
    const service = new ProviderResourceUsageService(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return response;
    });

    const result = await service.read('project', 'deepseek', credential);

    expect(result?.detail).toBe('无法读取官方余额。');
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not publish credentials or unbounded transport errors', async () => {
    const credential = 'credential-that-must-stay-private';
    let requestSignal: AbortSignal | undefined;
    const service = new ProviderResourceUsageService(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      throw new Error(`${credential}:${'x'.repeat(10_000)}`);
    });

    const result = await service.read('project', 'openrouter', credential);
    const serialized = JSON.stringify(result);

    expect(result?.detail).toBe('无法读取官方余额。');
    expect(result?.detail?.length).toBeLessThanOrEqual(300);
    expect(serialized).not.toContain(credential);
    expect(requestSignal?.aborted).toBe(true);
  });
});
