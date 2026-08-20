import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(() => normalizeChatBaseUrl('https://user:secret@example.com')).toThrow(/凭据/);
    expect(() => normalizeChatBaseUrl('https://example.com?v=1')).toThrow(/查询/);
  });
});
