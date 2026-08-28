import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAutomaticChatConnection } from '../../src/main/chat/automatic-connection';
import { findChatProvider, inferChatProvider } from '../../src/shared/claude/chat-providers';
import type { SaveChatConfigInput } from '../../src/shared/contracts';

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

const { ChatConfigStore, normalizeChatBaseUrl } = await import('../../src/main/chat/config-store');

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-chat-'));
  fixtureRoots.push(fixtureRoot);
  return {
    profilePath: path.join(fixtureRoot, 'claude', 'chat-profile.json'),
    store: new ChatConfigStore(fixtureRoot),
  };
};

describe('independent chat profile store', () => {
  it('encrypts the credential and restores only the configured flag to the renderer', () => {
    const { profilePath, store } = createStore();

    const view = store.save({
      authMode: 'bearer',
      baseUrl: 'https://gateway.example.com/v1',
      credential: 'top-secret',
      credentialAction: 'replace',
      model: 'custom-model',
      protocol: 'openai',
    });

    expect(view).toEqual({
      authMode: 'bearer',
      baseUrl: 'https://gateway.example.com/v1',
      credentialConfigured: true,
      model: 'custom-model',
      protocol: 'openai',
    });
    expect(store.getRuntimeConfig().credential).toBe('top-secret');
    expect(readFileSync(profilePath, 'utf8')).not.toContain('top-secret');
  });

  it('keeps or clears an existing credential explicitly', () => {
    const { store } = createStore();
    store.save({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      credential: 'secret',
      credentialAction: 'replace',
      model: 'model-a',
      protocol: 'anthropic',
    });

    expect(
      store.save({
        authMode: 'apiKey',
        baseUrl: 'https://api.anthropic.com',
        credentialAction: 'keep',
        model: 'model-b',
        protocol: 'anthropic',
      }).credentialConfigured,
    ).toBe(true);
    expect(
      store.save({
        authMode: 'apiKey',
        baseUrl: 'https://api.anthropic.com',
        credentialAction: 'clear',
        model: 'model-b',
        protocol: 'anthropic',
      }).credentialConfigured,
    ).toBe(false);
  });

  it('resolves an unsaved draft for connection testing without persisting the new credential', () => {
    const { store } = createStore();
    store.save({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      credential: 'saved-secret',
      credentialAction: 'replace',
      model: 'saved-model',
      protocol: 'anthropic',
    });

    expect(
      store.resolveRuntimeConfig({
        authMode: 'bearer',
        baseUrl: 'https://gateway.example.com/v1',
        credential: 'draft-secret',
        credentialAction: 'replace',
        model: 'draft-model',
        protocol: 'openai',
      }),
    ).toEqual({
      authMode: 'bearer',
      baseUrl: 'https://gateway.example.com/v1',
      credential: 'draft-secret',
      model: 'draft-model',
      protocol: 'openai',
    });
    expect(store.getRuntimeConfig().credential).toBe('saved-secret');
    expect(store.getRuntimeConfig()).not.toHaveProperty('encryptedCredential');
  });

  it('allows local HTTP but rejects remote plaintext and URL-embedded metadata', () => {
    expect(normalizeChatBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1');
    expect(() => normalizeChatBaseUrl('http://gateway.example.com')).toThrow(/HTTPS/);
    expect(() => normalizeChatBaseUrl('https://user:secret@example.com')).toThrow(/用户名或密码/);
    expect(() => normalizeChatBaseUrl('https://example.com?v=1')).toThrow(/查询/);
  });

  it('resolves a simple draft without persisting it, ignoring hidden manual fields', async () => {
    const { store } = createStore();
    const before = store.getView();
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
      options?.method
        ? Response.json({ id: 'msg-test', content: [] })
        : Response.json({ data: [{ id: 'discovered-model' }] }),
    );
    const result = await resolveAutomaticChatConnection(
      {
        autoDetect: true,
        authMode: 'none',
        baseUrl: 'relay.example.com',
        credential: 'draft-secret',
        credentialAction: 'replace',
        model: 'hidden-model',
        preset: 'custom',
        protocol: 'openai',
      },
      store,
      fetchMock,
    );
    expect(result.input).toMatchObject({
      authMode: 'bearer',
      baseUrl: 'https://relay.example.com/v1/messages',
      credential: 'draft-secret',
      model: 'discovered-model',
      protocol: 'anthropic',
    });
    expect(store.getView()).toEqual(before);
    expect(store.save(result.input)).toMatchObject({ model: 'discovered-model', preset: 'custom' });
  });

  it('keeps saved keys on the same API scope and refuses to send them to another host or tenant', async () => {
    const { store } = createStore();
    const saved: SaveChatConfigInput = {
      authMode: 'bearer',
      baseUrl: 'https://relay.example.com/tenant/v1',
      credential: 'saved-secret',
      credentialAction: 'replace',
      model: 'saved-model',
      protocol: 'openai',
    };
    store.save(saved);
    const request = {
      ...saved,
      autoDetect: true,
      credential: undefined,
      credentialAction: 'keep' as const,
      preset: 'custom',
    };
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
      options?.method
        ? Response.json({ id: 'msg-test', content: [] })
        : Response.json({ data: [{ id: 'saved-model' }] }),
    );
    await resolveAutomaticChatConnection(
      { ...request, baseUrl: 'relay.example.com/tenant' },
      store,
      fetchMock,
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer saved-secret',
    );
    for (const baseUrl of ['relay.example.com/another-tenant', 'another.example.com/tenant']) {
      fetchMock.mockClear();
      await expect(
        resolveAutomaticChatConnection({ ...request, baseUrl }, store, fetchMock),
      ).rejects.toThrow('重新填写密钥');
      expect(fetchMock).not.toHaveBeenCalled();
    }
    expect(store.getRuntimeConfig().credential).toBe('saved-secret');
  });

  it('uses main-owned domestic endpoints and never tries a renderer-supplied replacement host', async () => {
    const { store } = createStore();
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
      options?.method
        ? Response.json({ id: 'msg-test', content: [] })
        : Response.json({ data: [{ id: 'deepseek-v4-flash' }] }),
    );
    const result = await resolveAutomaticChatConnection(
      {
        autoDetect: true,
        authMode: 'apiKey',
        baseUrl: 'https://other.example.com',
        credential: 'private-key',
        credentialAction: 'replace',
        model: '',
        preset: 'deepseek',
        protocol: 'anthropic',
      },
      store,
      fetchMock,
    );
    expect(result.input.baseUrl).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(
      fetchMock.mock.calls.every(([url]) => new URL(String(url)).hostname === 'api.deepseek.com'),
    ).toBe(true);
  });

  it('never invents a default model for a new custom relay whose catalog is unavailable', async () => {
    const { store } = createStore();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    await expect(
      resolveAutomaticChatConnection(
        {
          autoDetect: true,
          authMode: 'bearer',
          baseUrl: 'relay.example.com',
          credential: 'private-key',
          credentialAction: 'replace',
          model: 'default',
          preset: 'custom',
          protocol: 'openai',
        },
        store,
        fetchMock,
      ),
    ).rejects.toThrow('未能获取模型');
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('separates coding plans from ordinary chat APIs and recognizes saved API endpoints', async () => {
    expect(findChatProvider('qwen-cn')).toBeUndefined();
    expect(findChatProvider('glm-cn')).toBeUndefined();
    expect(findChatProvider('qwen-api')).toBeDefined();
    expect(inferChatProvider('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('qwen-api');
    expect(inferChatProvider('https://open.bigmodel.cn/api/paas/v4/chat/completions')).toBe(
      'glm-api',
    );
    const { store } = createStore();
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      resolveAutomaticChatConnection(
        {
          autoDetect: true,
          authMode: 'bearer',
          baseUrl: '',
          credential: 'sk-sp-plan-key',
          credentialAction: 'replace',
          model: '',
          preset: 'qwen-api',
          protocol: 'openai',
        },
        store,
        fetchMock,
      ),
    ).rejects.toThrow('Coding Plan');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getView().credentialConfigured).toBe(false);
  });
});
