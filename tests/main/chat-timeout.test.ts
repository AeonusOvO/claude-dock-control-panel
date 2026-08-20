import { describe, expect, it, vi } from 'vitest';
import type { ChatConfigStore } from '../../src/main/chat/config-store';
import { ChatService } from '../../src/main/chat/service';
import type { ChatStreamEvent } from '../../src/shared/contracts';

const store = {
  getRuntimeConfig: () => ({
    authMode: 'none' as const,
    baseUrl: 'https://gateway.example.com',
    model: 'model',
    protocol: 'openai' as const,
  }),
} as unknown as ChatConfigStore;

const delayedStreamResponse = (chunks: string[], delayMs: number): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk, index) => {
          setTimeout(
            () => {
              controller.enqueue(encoder.encode(chunk));
              if (index === chunks.length - 1) controller.close();
            },
            delayMs * (index + 1),
          );
        });
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  );
};

const stalledRequest = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('independent chat timeout invariants', () => {
  it('lets an active stream outlive the idle threshold while chunks keep arriving', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      delayedStreamResponse(
        [
          'data: {"choices":[{"delta":{"content":"一"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"二"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"三"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ],
        8,
      ),
    );
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      idleRepeatMs: 10,
      idleTimeoutMs: 12,
      probeTimeoutMs: 20,
    });

    service.start({
      messages: [{ content: '持续输出', role: 'user' }],
      requestId: 'request-healthy-stream',
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.filter((event) => event.type === 'delta').map((event) => event.delta)).toEqual([
      '一',
      '二',
      '三',
    ]);
    expect(events.some((event) => event.type === 'aborted')).toBe(false);
  });

  it('reports an explicit stop only as a manual abort', async () => {
    const events: ChatStreamEvent[] = [];
    const service = new ChatService(
      store,
      (event) => events.push(event),
      vi.fn<typeof fetch>(stalledRequest),
      undefined,
      { idleTimeoutMs: 1_000 },
    );

    service.start({
      messages: [{ content: '停止', role: 'user' }],
      requestId: 'request-manual-stop',
    });
    service.stop('request-manual-stop');

    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ abortReason: 'manual', type: 'aborted' }),
    );
  });

  it('keeps idle handling non-destructive by default and enables TCP keepalive', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(stalledRequest)
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      idleRepeatMs: 10,
      idleTimeoutMs: 10,
      probeTimeoutMs: 20,
    });

    service.start({
      messages: [{ content: '保持连接', role: 'user' }],
      requestId: 'request-default-idle',
    });

    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === 'idle').length).toBeGreaterThanOrEqual(2);
    });
    expect(events.some((event) => event.type === 'aborted')).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ keepalive: true, redirect: 'manual' });

    service.stop('request-default-idle');
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('aborted'));
  });
});
