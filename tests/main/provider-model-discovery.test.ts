import { describe, expect, it, vi } from 'vitest';
import {
  discoverOpenAiModels,
  parseOpenAiModelIds,
} from '../../src/main/network/provider-model-discovery';

describe('provider model discovery', () => {
  it('deduplicates and validates model identifiers', () => {
    expect(
      parseOpenAiModelIds({
        data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-5.4-mini' }],
      }),
    ).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini']);
    expect(() => parseOpenAiModelIds({ data: [{ id: 'bad model name' }] })).toThrow('没有可用模型');
  });

  it('requests the derived models endpoint with the supplied bearer credential', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    );
    await expect(
      discoverOpenAiModels(
        'https://relay.example.com/openai/v1/chat/completions',
        'secret-value',
        fetchImplementation as unknown as typeof fetch,
      ),
    ).resolves.toEqual(['model-a', 'model-b']);
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://relay.example.com/openai/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-value' },
        redirect: 'error',
      }),
    );
  });

  it('reports authentication failures without echoing the credential', async () => {
    const fetchImplementation = vi.fn(async () => new Response('', { status: 401 }));
    await expect(
      discoverOpenAiModels(
        'https://relay.example.com/v1',
        'do-not-echo',
        fetchImplementation as unknown as typeof fetch,
      ),
    ).rejects.toThrow('拒绝了当前密钥');
    await discoverOpenAiModels(
      'https://relay.example.com/v1',
      'do-not-echo',
      fetchImplementation as unknown as typeof fetch,
    ).catch((error: unknown) => {
      expect(String(error)).not.toContain('do-not-echo');
    });
  });

  it('stops reading oversized model catalogs', async () => {
    const fetchImplementation = vi.fn(
      async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
    );
    await expect(
      discoverOpenAiModels(
        'https://relay.example.com/v1',
        undefined,
        fetchImplementation as unknown as typeof fetch,
      ),
    ).rejects.toThrow('安全大小上限');
  });
});
