import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedClaudeConfig } from '../src/main/claude-configuration';
import { readLimitedResponseText, testClaudeConnection } from '../src/main/claude-connection-test';

const gatewayConfig: NormalizedClaudeConfig = {
  apiKeyHelperPolicy: 'prefer-claudedock',
  authMode: 'authToken',
  baseUrl: 'http://127.0.0.1:3456',
  model: 'claude-fable-5',
  preset: 'gateway',
  provider: 'gateway',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Claude connection test', () => {
  it('stops reading a response after 64 KiB', async () => {
    const text = await readLimitedResponseText(new Response('a'.repeat(80 * 1024)));

    expect(text).toHaveLength(64 * 1024);
  });

  it('accepts a standard Anthropic Messages response without returning its content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ text: 'x', type: 'text' }],
          id: 'msg_fixture',
          type: 'message',
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await testClaudeConnection(gatewayConfig, 'router-client-key');

    expect(result.ok).toBe(true);
    expect(result.tone).toBe('success');
    expect(JSON.stringify(result)).not.toContain('router-client-key');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3456/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer router-client-key',
        }),
        method: 'POST',
      }),
    );
  });

  it('accepts an Anthropic-compatible response whose non-empty id uses a provider prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: [], id: 'deepseek-response-1', type: 'message' }), {
          status: 200,
        }),
      ),
    );

    const result = await testClaudeConnection(gatewayConfig, 'router-client-key');

    expect(result.ok).toBe(true);
    expect(result.observedProtocol).toBe('anthropic');
  });

  it('identifies an OpenAI success body instead of blindly treating every 200 as convertible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'x', role: 'assistant' } }] }),
          {
            status: 200,
          },
        ),
      ),
    );

    const result = await testClaudeConnection(gatewayConfig, 'router-client-key');

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('response-shape');
    expect(result.observedProtocol).toBe('openai');
    expect(result.stages.at(-1)?.detail).toContain('OpenAI');
  });

  it('builds the current DeepSeek Anthropic endpoint from its documented base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ text: 'x', type: 'text' }],
          id: 'msg_deepseek',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await testClaudeConnection(
      {
        apiKeyHelperPolicy: 'prefer-claudedock',
        authMode: 'apiKey',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-pro',
        preset: 'deepseek',
        provider: 'gateway',
      },
      'deepseek-example-key',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/anthropic/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'deepseek-example-key',
        }),
      }),
    );
  });

  it('turns a 401 into an authentication-specific visual result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'invalid token' } }), {
          status: 401,
        }),
      ),
    );

    const result = await testClaudeConnection(gatewayConfig, 'wrong-example-key');

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('authentication');
    expect(result.httpStatus).toBe(401);
    expect(result.message).toContain('认证方式');
    expect(result.stages).toContainEqual(
      expect.objectContaining({ id: 'authentication', status: 'failed' }),
    );
  });
});
