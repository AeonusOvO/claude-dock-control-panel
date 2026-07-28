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
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
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
    } as unknown as ChatConfigStore;
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
    expect(events.at(-1)?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 2,
      source: 'provider',
      totalTokens: 14,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
  });

  it('supports OpenAI-compatible SSE and bearer authentication independently', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
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
    } as unknown as ChatConfigStore;
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
    expect(events.at(-1)?.usage).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      source: 'provider',
      totalTokens: 10,
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stream_options: { include_usage: true },
    });
  });

  it('retries OpenAI-compatible streams without stream_options when a gateway rejects it', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unsupported', { status: 422 }))
      .mockResolvedValueOnce(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"兼容"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'bearer' as const,
        baseUrl: 'https://gateway.example.com/v1',
        credential: 'token',
        model: 'gateway-model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock);

    service.start({
      messages: [{ content: 'ping', role: 'user' }],
      requestId: 'request-fallback',
    });

    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('done');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toHaveProperty('stream_options');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty(
      'stream_options',
    );
  });

  it('tests a draft with a one-token non-streaming request and returns provider usage', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            content: [{ text: '好', type: 'text' }],
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
    );
    const store = {
      resolveRuntimeConfig: () => ({
        authMode: 'apiKey' as const,
        baseUrl: 'https://api.anthropic.com',
        credential: 'draft-secret',
        model: 'claude-test',
        protocol: 'anthropic' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, () => undefined, fetchMock);

    const result = await service.test({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      credential: 'draft-secret',
      credentialAction: 'replace',
      model: 'claude-test',
      protocol: 'anthropic',
    });

    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      source: 'provider',
      totalTokens: 6,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 1, stream: false });
  });

  it('sanitizes a rejected connection test so credentials never return to the renderer', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: 'bad draft-secret' } }), {
          headers: { 'content-type': 'application/json' },
          status: 401,
        }),
    );
    const store = {
      resolveRuntimeConfig: () => ({
        authMode: 'bearer' as const,
        baseUrl: 'https://gateway.example.com/v1',
        credential: 'draft-secret',
        model: 'draft-model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;

    const result = await new ChatService(store, () => undefined, fetchMock).test({
      authMode: 'bearer',
      baseUrl: 'https://gateway.example.com/v1',
      credential: 'draft-secret',
      credentialAction: 'replace',
      model: 'draft-model',
      protocol: 'openai',
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('•••');
    expect(JSON.stringify(result)).not.toContain('draft-secret');
  });
});
