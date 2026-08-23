import { describe, expect, it, vi } from 'vitest';
import type { ChatConfigStore } from '../../src/main/chat/config-store';
import type { ChatAttachmentStore } from '../../src/main/chat/attachment-store';
import {
  ChatService,
  serializeChatRequestBody,
  validateChatRequest,
} from '../../src/main/chat/service';
import type { ChatStartInput, ChatStreamEvent } from '../../src/shared/contracts';

const startChat = (service: ChatService, input: ChatStartInput): void => {
  service.start(input, service.captureRuntimeSnapshot());
};

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

    startChat(service, {
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

    startChat(service, {
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

    startChat(service, {
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

  it('accepts a valid DeepSeek Anthropic envelope when the one-token probe only returns thinking', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ thinking: 'x', type: 'thinking' }],
            id: 'deepseek-message-1',
            stop_reason: 'max_tokens',
            type: 'message',
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      ),
    );
    const store = {
      resolveRuntimeConfig: () => ({
        authMode: 'apiKey' as const,
        baseUrl: 'https://api.deepseek.com/anthropic',
        credential: 'deepseek-key',
        model: 'deepseek-v4-pro',
        protocol: 'anthropic' as const,
      }),
    } as unknown as ChatConfigStore;

    const result = await new ChatService(store, () => undefined, fetchMock).test({
      authMode: 'apiKey',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credential: 'deepseek-key',
      credentialAction: 'replace',
      model: 'deepseek-v4-pro',
      protocol: 'anthropic',
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('有效协议结构');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/anthropic/v1/messages',
      expect.any(Object),
    );
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

  it('serializes Anthropic attachments before text and OpenAI images as data URLs', () => {
    const messages = validateChatRequest({
      messages: [
        { content: 'system text', role: 'system' },
        {
          content: [
            { text: 'describe this', type: 'text' },
            {
              fileName: 'pixel.png',
              mediaType: 'image/png',
              source: { data: 'iVBORw==', type: 'base64' },
              type: 'image',
            },
          ],
          role: 'user',
        },
      ],
      requestId: 'request-serialize',
    });
    const anthropic = serializeChatRequestBody(
      {
        authMode: 'apiKey',
        baseUrl: 'https://api.anthropic.com',
        credential: 'secret',
        model: 'claude-test',
        protocol: 'anthropic',
      },
      messages,
      { includeUsage: true, stream: true, thinking: true },
    );
    expect(anthropic).toMatchObject({
      system: 'system text',
      thinking: { display: 'summarized', type: 'adaptive' },
    });
    expect((anthropic.messages as Array<{ content: unknown[] }>)[0]?.content).toEqual([
      {
        source: {
          data: 'iVBORw==',
          media_type: 'image/png',
          type: 'base64',
        },
        type: 'image',
      },
      { text: 'describe this', type: 'text' },
    ]);

    const openai = serializeChatRequestBody(
      {
        authMode: 'bearer',
        baseUrl: 'https://api.openai.com',
        credential: 'secret',
        model: 'gpt-test',
        protocol: 'openai',
      },
      messages,
      { includeUsage: true, stream: true },
    );
    expect((openai.messages as Array<{ content: unknown[] }>)[1]?.content).toEqual([
      { text: 'describe this', type: 'text' },
      {
        image_url: { url: 'data:image/png;base64,iVBORw==' },
        type: 'image_url',
      },
    ]);
  });

  it('emits typed thinking, input-json and refusal events and retries without incompatible thinking', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('thinking unsupported', { status: 400 }))
      .mockResolvedValueOnce(
        streamResponse([
          'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"分析"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"x\\":"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":3}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'apiKey' as const,
        baseUrl: 'https://api.anthropic.com',
        credential: 'secret',
        model: 'claude-test',
        protocol: 'anthropic' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock);

    startChat(service, {
      messages: [{ content: 'run', role: 'user' }],
      requestId: 'request-thinking-fallback',
    });

    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('done');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toHaveProperty('thinking');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty('thinking');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delta: '分析', type: 'thinking' }),
        expect.objectContaining({ delta: '{"x":', type: 'input-json' }),
        expect.objectContaining({
          refusal: '模型拒绝了此请求。',
          stopReason: 'refusal',
          type: 'refusal',
        }),
        expect.objectContaining({ stopReason: 'refusal', type: 'done' }),
      ]),
    );
  });

  it('removes an unavailable attachment from an older turn without poisoning the conversation', () => {
    const missingId = '8f9aa605-adb6-4e2b-a25a-607e14bad666';
    const attachmentStore = {
      get: () => {
        throw new Error('missing');
      },
    } as unknown as ChatAttachmentStore;
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'none' as const,
        baseUrl: 'https://gateway.example.com',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, () => undefined, vi.fn<typeof fetch>(), attachmentStore);

    const prepared = service.preflight({
      messages: [
        {
          content: [
            {
              fileName: 'missing.txt',
              mediaType: 'text/plain',
              source: { attachmentId: missingId, type: 'local' },
              type: 'document',
            },
            { text: '旧问题', type: 'text' },
          ],
          role: 'user',
        },
        { content: '旧回答', role: 'assistant' },
        { content: '继续', role: 'user' },
      ],
      requestId: 'request-repair',
    });

    expect(prepared.removedAttachmentIds).toEqual([missingId]);
    expect(prepared.warning).toContain('自动移除');
    expect(prepared.messages[0]?.content).toEqual([{ text: '旧问题', type: 'text' }]);
  });

  it('sends both gateway auth headers and a generous generation ceiling in apiKey mode', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse(['data: {"type":"message_stop"}\n\n']),
    );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'apiKey' as const,
        baseUrl: 'https://relay.example.com',
        credential: 'relay-key',
        model: 'claude-test',
        protocol: 'anthropic' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock);

    startChat(service, {
      messages: [{ content: '你好', role: 'user' }],
      requestId: 'request-relay-headers',
    });

    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('done');
    });
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('relay-key');
    expect(headers.authorization).toBe('Bearer relay-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      max_tokens: 64_000,
    });
  });

  it('lowers the generation ceiling when a gateway rejects both thinking and max_tokens', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('thinking unsupported', { status: 400 }))
      .mockResolvedValueOnce(new Response('max_tokens too large', { status: 400 }))
      .mockResolvedValueOnce(streamResponse(['data: {"type":"message_stop"}\n\n']));
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'apiKey' as const,
        baseUrl: 'https://relay.example.com',
        credential: 'relay-key',
        model: 'claude-test',
        protocol: 'anthropic' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock);

    startChat(service, {
      messages: [{ content: '你好', role: 'user' }],
      requestId: 'request-ceiling-fallback',
    });

    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('done');
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      max_tokens: 8_192,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).not.toHaveProperty('thinking');
  });

  it('retries transient HTTP failures with Retry-After before any stream output', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('bad gateway', { headers: { 'retry-after': '0' }, status: 502 }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"恢复"},"finish_reason":null}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'bearer' as const,
        baseUrl: 'https://gateway.example.com',
        credential: 'token',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      maxTransientRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    startChat(service, {
      messages: [{ content: 'retry', role: 'user' }],
      requestId: 'request-http-retry',
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt: 2,
          retryAfterMs: 0,
          retryReason: 'http-status',
          status: 502,
          type: 'retrying',
        }),
      ]),
    );
    expect(events.some((event) => event.delta === '恢复')).toBe(true);
  });

  it('returns the final transient HTTP response after the retry budget is exhausted', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('upstream unavailable', { status: 502 })),
    );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'none' as const,
        baseUrl: 'https://gateway.example.com',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      maxTransientRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    startChat(service, {
      messages: [{ content: 'retry', role: 'user' }],
      requestId: 'request-http-exhausted',
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('error'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === 'retrying')).toHaveLength(2);
    expect(events.at(-1)?.error).toContain('接口返回 502：upstream unavailable');
    expect(events.at(-1)?.error).toContain('已自动重试 2 次');
  });

  it('retries a network failure and reports exhaustion without leaking the credential', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed for network-secret');
    });
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'bearer' as const,
        baseUrl: 'https://gateway.example.com',
        credential: 'network-secret',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      maxTransientRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    startChat(service, {
      messages: [{ content: 'retry', role: 'user' }],
      requestId: 'request-network-retry',
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('error'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === 'retrying')).toHaveLength(2);
    expect(events.at(-1)?.error).toContain('已自动重试 2 次');
    expect(JSON.stringify(events)).not.toContain('network-secret');
  });

  it('retries an incomplete stream only before model output starts', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([]))
      .mockResolvedValueOnce(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"完整"},"finish_reason":null}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'none' as const,
        baseUrl: 'https://gateway.example.com',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      maxTransientRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    startChat(service, {
      messages: [{ content: 'retry', role: 'user' }],
      requestId: 'request-empty-stream',
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ retryReason: 'stream-incomplete', type: 'retrying' }),
      ]),
    );
  });

  it('marks a partial stream as interrupted instead of duplicating it or reporting done', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"部分回答"},"finish_reason":null}]}\n\n',
      ]),
    );
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'none' as const,
        baseUrl: 'https://gateway.example.com',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      maxTransientRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    startChat(service, {
      messages: [{ content: 'partial', role: 'user' }],
      requestId: 'request-partial-stream',
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('error'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'delta').map((event) => event.delta)).toEqual([
      '部分回答',
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events.at(-1)?.continuable).toBe(true);
    expect(events.at(-1)?.error).toContain('结束标记前断开');
  });

  it('rejects ambiguous and cross-origin redirects but follows same-origin 307 safely', async () => {
    const config = {
      authMode: 'bearer' as const,
      baseUrl: 'https://gateway.example.com',
      credential: 'redirect-secret',
      model: 'model',
      protocol: 'openai' as const,
    };
    const store = { getRuntimeConfig: () => config } as unknown as ChatConfigStore;

    const ambiguousEvents: ChatStreamEvent[] = [];
    const ambiguousFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          headers: { location: 'https://login.example.com/session' },
          status: 302,
        }),
    );
    startChat(new ChatService(store, (event) => ambiguousEvents.push(event), ambiguousFetch), {
      messages: [{ content: 'redirect', role: 'user' }],
      requestId: 'request-redirect-302',
    });
    await vi.waitFor(() => expect(ambiguousEvents.at(-1)?.type).toBe('error'));
    expect(ambiguousFetch).toHaveBeenCalledTimes(1);
    expect(ambiguousEvents.at(-1)?.error).toContain('HTTP 302');
    expect(ambiguousFetch.mock.calls[0]?.[1]?.keepalive).toBe(true);
    expect(ambiguousFetch.mock.calls[0]?.[1]?.redirect).toBe('manual');

    const crossOriginEvents: ChatStreamEvent[] = [];
    const crossOriginFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          headers: { location: 'https://other.example.com/v1/chat/completions' },
          status: 307,
        }),
    );
    startChat(new ChatService(store, (event) => crossOriginEvents.push(event), crossOriginFetch), {
      messages: [{ content: 'redirect', role: 'user' }],
      requestId: 'request-cross-origin-307',
    });
    await vi.waitFor(() => expect(crossOriginEvents.at(-1)?.type).toBe('error'));
    expect(crossOriginFetch).toHaveBeenCalledTimes(1);
    expect(crossOriginEvents.at(-1)?.error).toContain('避免凭据泄漏');
    expect(JSON.stringify(crossOriginEvents)).not.toContain('redirect-secret');

    const sameOriginEvents: ChatStreamEvent[] = [];
    const sameOriginFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: '/edge/chat/completions' },
          status: 307,
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"重定向成功"},"finish_reason":null}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    startChat(new ChatService(store, (event) => sameOriginEvents.push(event), sameOriginFetch), {
      messages: [{ content: 'redirect', role: 'user' }],
      requestId: 'request-same-origin-307',
    });
    await vi.waitFor(() => expect(sameOriginEvents.at(-1)?.type).toBe('done'));
    expect(sameOriginFetch).toHaveBeenCalledTimes(2);
    expect(sameOriginFetch.mock.calls[1]?.[0]).toBe(
      'https://gateway.example.com/edge/chat/completions',
    );
    expect(
      (sameOriginFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization,
    ).toBe('Bearer redirect-secret');
  });

  it('retries retryable provider error events before output begins', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        streamResponse([
          'data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(streamResponse(['data: {"type":"message_stop"}\n\n']));
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'apiKey' as const,
        baseUrl: 'https://api.anthropic.com',
        credential: 'secret',
        model: 'claude-test',
        protocol: 'anthropic' as const,
      }),
    } as unknown as ChatConfigStore;
    const service = new ChatService(store, (event) => events.push(event), fetchMock, undefined, {
      maxTransientRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    startChat(service, {
      messages: [{ content: 'overload', role: 'user' }],
      requestId: 'request-stream-overload',
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ retryReason: 'stream-incomplete', type: 'retrying' }),
      ]),
    );
  });

  it('reports idle state with a side probe without aborting the active request', async () => {
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'none' as const,
        baseUrl: 'https://gateway.example.com',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const stalledRequest = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    const stalledFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(stalledRequest)
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );

    const idleEvents: ChatStreamEvent[] = [];
    const idleService = new ChatService(
      store,
      (event) => idleEvents.push(event),
      stalledFetch,
      undefined,
      { idleRepeatMs: 100, idleTimeoutMs: 15, probeTimeoutMs: 50 },
    );
    startChat(idleService, {
      messages: [{ content: 'slow', role: 'user' }],
      requestId: 'request-idle',
    });
    await vi.waitFor(() => {
      expect(idleEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            probe: expect.objectContaining({ ok: true }),
            type: 'idle',
          }),
        ]),
      );
    });
    expect(idleEvents.some((event) => event.type === 'aborted')).toBe(false);
    idleService.stop('request-idle');
    await vi.waitFor(() => {
      expect(idleEvents.at(-1)).toMatchObject({
        abortReason: 'manual',
        type: 'aborted',
      });
    });

    const manualEvents: ChatStreamEvent[] = [];
    const manualFetch = vi.fn<typeof fetch>(stalledRequest);
    const manualService = new ChatService(
      store,
      (event) => manualEvents.push(event),
      manualFetch,
      undefined,
      { idleTimeoutMs: 1_000 },
    );
    startChat(manualService, {
      messages: [{ content: 'manual', role: 'user' }],
      requestId: 'request-manual',
    });
    manualService.stop('request-manual');
    await vi.waitFor(() => {
      expect(manualEvents.at(-1)).toMatchObject({
        abortReason: 'manual',
        type: 'aborted',
      });
    });
  });

  it('only aborts at the second idle threshold when the local setting opts in', async () => {
    const events: ChatStreamEvent[] = [];
    const store = {
      getRuntimeConfig: () => ({
        authMode: 'none' as const,
        baseUrl: 'https://gateway.example.com',
        model: 'model',
        protocol: 'openai' as const,
      }),
    } as unknown as ChatConfigStore;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );
    const service = new ChatService(
      store,
      (event) => events.push(event),
      fetchMock,
      undefined,
      { idleRepeatMs: 5, idleTimeoutMs: 50, probeTimeoutMs: 20 },
      () => 15,
    );

    startChat(service, {
      messages: [{ content: 'slow', role: 'user' }],
      requestId: 'request-local-timeout',
    });

    await vi.waitFor(() => {
      expect(events.at(-1)).toMatchObject({
        abortReason: 'local-timeout',
        type: 'aborted',
      });
    });
    expect(events.some((event) => event.type === 'idle')).toBe(true);
  });
});
