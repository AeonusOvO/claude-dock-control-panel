import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectAutomaticConnection,
  AutomaticConnectionAccessError,
} from '../../src/main/network/automatic-connection';
import { guardedAutomaticConnectionFetch } from '../../src/main/network/automatic-connection-access';
import {
  automaticConnectionCandidates,
  sameConnectionCredentialScope,
} from '../../src/shared/router/automatic-connection';
import type { AutomaticConnectionProtocol } from '../../src/shared/router/automatic-connection';

const reply = (protocol: AutomaticConnectionProtocol): Response =>
  Response.json(
    protocol === 'anthropic'
      ? { content: [{ type: 'text', text: '1' }], id: 'msg-test' }
      : protocol === 'openai'
        ? { choices: [{ message: { content: '1', role: 'assistant' } }] }
        : { id: 'resp-test', object: 'response', output: [], status: 'incomplete' },
  );
const catalog = () => Response.json({ data: [{ id: 'embed-test' }, { id: 'chat-test' }] });
const reject = (status = 404) => Response.json({ error: { message: 'unavailable' } }, { status });
const input = { address: 'relay.example.com', credential: 'private-test-key' };
afterEach(() => vi.restoreAllMocks());

describe('automatic provider connection', () => {
  it.each([
    ['relay.example.com', '/v1/messages', 'anthropic', 'apiKey'],
    ['relay.example.com/v1', '/v1/messages', 'anthropic', 'bearer'],
    ['relay.example.com/tenant/v1', '/tenant/v1/messages', 'anthropic', 'apiKey'],
    ['relay.example.com/v1', '/v1/v1/messages', 'anthropic', 'bearer'],
    ['relay.example.com/api/paas/v4', '/api/paas/v4/chat/completions', 'openai', 'bearer'],
    ['relay.example.com/v1/chat/completions', '/v1/chat/completions', 'openai', 'bearer'],
    ['relay.example.com/v1/responses', '/v1/responses', 'openai-responses', 'bearer'],
    ['relay.example.com/proxy', '/proxy/chat/completions', 'openai', 'bearer'],
  ] as const)(
    'finds %s without protocol or authentication choices',
    async (address, endpoint, protocol, authMode) => {
      const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
        if (!options?.method) return catalog();
        const headers = new Headers(options.headers);
        const authenticated =
          authMode === 'apiKey'
            ? headers.get('x-api-key') === input.credential && !headers.has('authorization')
            : headers.get('authorization') === `Bearer ${input.credential}` &&
              !headers.has('x-api-key');
        return new URL(String(url)).pathname === endpoint && authenticated
          ? reply(protocol)
          : reject(401);
      });
      const result = await detectAutomaticConnection({ ...input, address }, fetchMock);
      expect(result).toMatchObject({
        authMode,
        endpoint: `https://relay.example.com${endpoint}`,
        model: 'chat-test',
        protocol,
      });
      expect(JSON.stringify(result)).not.toContain(input.credential);
      expect(
        fetchMock.mock.calls.every(
          ([url, options]) =>
            new URL(String(url)).origin === 'https://relay.example.com' &&
            options?.redirect === 'error',
        ),
      ).toBe(true);
      expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
        result.requestCount,
      );
    },
  );

  it('stops after the first proven connection and never sends a transcript or tools', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
      options?.method ? reply('anthropic') : catalog(),
    );
    const result = await detectAutomaticConnection(input, fetchMock);
    expect(result.requestCount).toBe(1);
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body).toEqual({
      max_tokens: 1,
      messages: [{ content: '.', role: 'user' }],
      model: 'chat-test',
      stream: false,
    });
  });

  it('falls back to a documented model when the provider has no catalog', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
      options?.method ? reply('anthropic') : reject(),
    );
    expect(
      await detectAutomaticConnection(
        { ...input, modelHints: ['documented-model[1m]'] },
        fetchMock,
      ),
    ).toMatchObject({ model: 'documented-model', protocol: 'anthropic' });
  });

  it('does not invent model identifiers for an unknown relay with no catalog', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => reject());
    await expect(detectAutomaticConnection(input, fetchMock)).rejects.toThrow('未能获取模型');
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });

  it('retries the supported token parameter with a bounded output cap', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
      if (!options?.method) return catalog();
      const body = JSON.parse(String(options.body));
      return body.max_completion_tokens === 16
        ? reply('openai')
        : Response.json(
            { error: { message: 'Use max_completion_tokens instead of max_tokens' } },
            { status: 400 },
          );
    });
    const result = await detectAutomaticConnection(
      { ...input, address: 'relay.example.com/v1/chat/completions' },
      fetchMock,
    );
    expect(result).toMatchObject({ protocol: 'openai', requestCount: 2 });
  });

  it('rejects HTML and protocol-shaped error bodies instead of saving a false success', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
      options?.method ? new Response('<html>login required</html>') : catalog(),
    );
    await expect(detectAutomaticConnection(input, fetchMock)).rejects.toThrow('未找到可用连接');
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST').length,
    ).toBeLessThanOrEqual(12);
  });

  it('reaches every protocol before spending its budget on additional models', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (!options?.method)
        return Response.json({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] });
      return String(url).endsWith('/responses') ? reply('openai-responses') : reject(400);
    });
    const result = await detectAutomaticConnection({ ...input, openAiApiKey: true }, fetchMock);
    expect(result).toMatchObject({ protocol: 'openai-responses', model: 'model-a' });
    expect(result.requestCount).toBeLessThanOrEqual(5);
  });

  it('tries another discovered model on a supported endpoint without repeating rejected endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (!options?.method) return Response.json({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
      if (!String(url).endsWith('/v1/chat/completions')) return reject(404);
      return JSON.parse(String(options.body)).model === 'model-b' ? reply('openai') : reject(400);
    });
    expect(await detectAutomaticConnection(input, fetchMock)).toMatchObject({
      protocol: 'openai',
      model: 'model-b',
    });
  });

  it('cancels during catalog discovery without admitting a paid probe or a later fallback', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error('cancelled during discovery'));
      throw controller.signal.reason;
    });
    await expect(detectAutomaticConnection(input, fetchMock, controller.signal)).rejects.toThrow(
      'cancelled during discovery',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([402, 429])(
    'stops on HTTP %s instead of repeatedly charging or retrying a rate limit',
    async (status) => {
      const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
        options?.method ? reject(status) : catalog(),
      );
      await expect(detectAutomaticConnection(input, fetchMock)).rejects.toThrow(
        AutomaticConnectionAccessError,
      );
      expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
        1,
      );
    },
  );

  it('does not leak a key disguised as a model id', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: input.credential }] }),
    );
    await expect(detectAutomaticConnection(input, fetchMock)).rejects.toThrow('未能获取模型');
  });

  it.each([
    'http://relay.example.com',
    'https://user:password@relay.example.com',
    'relay.example.com?api_key=secret',
  ])('rejects unsafe address %s before sending any key', async (address) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(detectAutomaticConnection({ ...input, address }, fetchMock)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin model discovery override before any network request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      detectAutomaticConnection(
        { ...input, modelsAddress: 'https://another.example/models' },
        fetchMock,
      ),
    ).rejects.toThrow('同一站点');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels before admission and stops all subsequent candidates', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(detectAutomaticConnection(input, fetchMock, controller.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps an official access denial terminal across all protocol fallbacks', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const guard = vi.fn(async () => {
      throw new Error('denied');
    });
    await expect(
      detectAutomaticConnection(
        { ...input, address: 'api.openai.com.' },
        guardedAutomaticConnectionFetch(guard, fetchMock),
      ),
    ).rejects.toThrow('网络检查未通过');
    expect(guard).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains a relay prefix and refuses to reuse credentials for a different tenant or host', () => {
    expect(
      automaticConnectionCandidates('relay.example.com/tenant/v1').every((candidate) =>
        new URL(candidate.endpoint).pathname.startsWith('/tenant/'),
      ),
    ).toBe(true);
    expect(
      sameConnectionCredentialScope(
        'relay.example.com/tenant',
        'https://relay.example.com/tenant/v1/messages',
      ),
    ).toBe(true);
    expect(
      sameConnectionCredentialScope('relay.example.com/tenant-a', 'relay.example.com/tenant-b'),
    ).toBe(false);
    expect(sameConnectionCredentialScope('relay.example.com', 'another.example.com')).toBe(false);
  });

  it.each(['anthropic', 'openai', 'openai-responses'] as const)(
    'proves %s over a real loopback HTTP server without a paid account',
    async (protocol) => {
      let posts = 0;
      const suffix =
        protocol === 'anthropic'
          ? '/v1/messages'
          : protocol === 'openai'
            ? '/v1/chat/completions'
            : '/v1/responses';
      const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const isPost = request.method === 'POST';
        if (isPost) posts += 1;
        const accepted =
          !isPost || (request.url === suffix && JSON.parse(body).model === 'chat-test');
        const result = isPost ? (accepted ? reply(protocol) : reject()) : catalog();
        response.writeHead(result.status, { 'Content-Type': 'application/json' });
        response.end(await result.text());
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const result = await detectAutomaticConnection({ address: `127.0.0.1:${port}` }, fetch);
        expect(result).toMatchObject({ authMode: 'none', model: 'chat-test', protocol });
        expect(posts).toBe(result.requestCount);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
