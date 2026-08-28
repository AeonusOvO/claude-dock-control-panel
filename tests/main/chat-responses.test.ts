import { describe, expect, it, vi } from 'vitest';
import type { ChatConfigStore, ChatRuntimeConfig } from '../../src/main/chat/config-store';
import {
  ChatService,
  directChatResponse,
  parseChatStreamDelta,
  serializeChatRequestBody,
} from '../../src/main/chat/service';
import type { ChatStreamEvent } from '../../src/shared/contracts';

const runtime: ChatRuntimeConfig = {
  authMode: 'bearer',
  baseUrl: 'https://relay.example.com/tenant/v1/responses',
  credential: 'private-key',
  model: 'responses-model',
  protocol: 'openai-responses',
};
const store = { getRuntimeConfig: () => runtime } as ChatConfigStore;
const sse = (...events: unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

describe('independent chat Responses protocol', () => {
  it('streams text, reasoning summaries and final usage through the selected endpoint', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(
        { type: 'response.created', response: { id: 'resp-test', status: 'in_progress' } },
        { type: 'response.reasoning_summary_text.delta', delta: '检查中' },
        { type: 'response.output_text.delta', delta: '你好' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-test',
            status: 'completed',
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      ),
    );
    const service = new ChatService(store, (event) => events.push(event), fetchMock);
    await service.startWithCompletion(
      { messages: [{ role: 'user', content: '你好' }], requestId: 'responses-stream-test' },
      service.captureRuntimeSnapshot(),
    ).completion;
    expect(events.some((event) => event.type === 'delta' && event.delta === '你好')).toBe(true);
    expect(events.some((event) => event.type === 'thinking' && event.delta === '检查中')).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, source: 'provider' },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(runtime.baseUrl);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'responses-model',
      stream: true,
      store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    });
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('stream_options');
    expect(JSON.stringify(events)).not.toContain('private-key');
  });

  it('serializes stateless history, images and documents using Responses content types', () => {
    const body = serializeChatRequestBody(
      runtime,
      [
        { role: 'system', content: 'system instructions' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'previous reply' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', mediaType: 'image/png', source: { type: 'base64', data: 'iVBORw==' } },
            {
              type: 'document',
              fileName: 'note.txt',
              mediaType: 'text/plain',
              source: { type: 'base64', data: 'YWJj' },
            },
          ],
        },
      ],
      { includeUsage: true, stream: true },
    );
    expect(body.input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'system instructions' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'first question' }] },
      { role: 'assistant', content: [{ type: 'input_text', text: 'previous reply' }] },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,iVBORw==' },
          { type: 'input_file', filename: 'note.txt', file_data: 'data:text/plain;base64,YWJj' },
        ],
      },
    ]);
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty('previous_response_id');
  });

  it('uses the minimum Responses probe cap and accepts a length-limited structured response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'resp-test',
        object: 'response',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
        usage: { input_tokens: 2, output_tokens: 16, total_tokens: 18 },
      }),
    );
    const result = await new ChatService(store, () => undefined, fetchMock).testRuntime(runtime);
    expect(result.ok).toBe(true);
    expect(result.usage?.totalTokens).toBe(18);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      max_output_tokens: 16,
      stream: false,
      store: false,
    });
  });

  it.each(['max_output_tokens', 'content_filter'])(
    'preserves the incomplete reason %s',
    (reason) => {
      const response = {
        id: 'resp-test',
        object: 'response',
        status: 'incomplete',
        incomplete_details: { reason },
        output: [],
      };
      const expected = reason === 'max_output_tokens' ? 'max_tokens' : reason;
      expect(directChatResponse('openai-responses', response).stopReason).toBe(expected);
      expect(
        parseChatStreamDelta('openai-responses', { type: 'response.incomplete', response }),
      ).toMatchObject({ done: true, stopReason: expected });
    },
  );

  it('reports Responses failures without claiming a completed answer or retrying identical bodies', async () => {
    const events: ChatStreamEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse({ type: 'response.failed', response: { status: 'failed' } }),
    );
    const service = new ChatService(store, (event) => events.push(event), fetchMock);
    await service.startWithCompletion(
      { messages: [{ role: 'user', content: 'test' }], requestId: 'responses-failure-test' },
      service.captureRuntimeSnapshot(),
    ).completion;
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(() =>
      directChatResponse('openai-responses', {
        id: 'resp-test',
        object: 'response',
        output: [],
        status: 'failed',
      }),
    ).toThrow('生成失败');
  });
});
