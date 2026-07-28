import { describe, expect, it, vi } from 'vitest';
import type { ChatConfigStore } from '../src/main/chat-config-store';
import { ChatService } from '../src/main/chat-service';
import type { ChatStreamEvent } from '../src/shared/contracts';

const streamResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  );
};

describe('independent chat service', () => {
  it('streams Anthropic deltas without exposing the credential in events', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'apiKey' as const,
        baseUrl: 'https://api.anthropic.com',
        credential: 'secret-key',
        model: 'claude-test',
        protocol: 'anthropic' as const,
      }),
    } as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock);

    service.start({
      messages: [{ content: '你好', role: 'user' }],
      requestId: 'request-12345678',
    });

    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('done');
    });
    expect(events.filter((event) => event.type === 'delta').map((event) => event.delta)).toEqual([
      '你',
      '好',
    ]);
    expect(JSON.stringify(events)).not.toContain('secret-key');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
  });

  it('supports OpenAI-compatible SSE and bearer authentication independently', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'bearer' as const,
        baseUrl: 'https://gateway.example.com/v1',
        credential: 'token',
        model: 'independent-model',
        protocol: 'openai' as const,
      }),
    } as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock);

    service.start({
      messages: [{ content: 'ping', role: 'user' }],
      requestId: 'request-87654321',
    });

    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('done');
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://gateway.example.com/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer token');
    expect(events.some((event) => event.delta === 'OK')).toBe(true);
  });
});
