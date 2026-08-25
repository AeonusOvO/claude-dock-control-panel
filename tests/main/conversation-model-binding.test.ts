import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

const {
  conversationModelDifferences,
  conversationModelIdentity,
  createConversationConnectionBinding,
} = await import('../../src/main/claude/conversation-model-binding');

const view = (modelFast?: string) => ({
  apiKeyHelperPolicy: 'prefer-claudedock' as const,
  authMode: 'authToken' as const,
  baseUrl: 'https://api.deepseek.com/anthropic',
  credentialConfigured: true,
  model: 'deepseek-v4-pro',
  modelFast,
  preset: 'deepseek' as const,
  protocol: 'anthropic' as const,
  provider: 'gateway' as const,
});

describe('conversation model binding', () => {
  it('canonicalises blank and explicit main-model small routes to one identity', () => {
    const blank = createConversationConnectionBinding({
      credential: 'sk-same',
      view: view(''),
    });
    const explicit = createConversationConnectionBinding({
      credential: 'sk-same',
      view: view('deepseek-v4-pro'),
    });

    expect(blank.config.modelFast).toBe('deepseek-v4-pro');
    expect(conversationModelDifferences(blank, explicit)).toEqual([]);
  });

  it('detects a small-model change even when provider, endpoint, API key and main model match', () => {
    const original = createConversationConnectionBinding({
      credential: 'sk-same',
      view: view('deepseek-v4-flash'),
    });
    const current = createConversationConnectionBinding({
      credential: 'sk-same',
      view: view('deepseek-v4-pro'),
    });

    expect(conversationModelDifferences(original, current)).toEqual(['small-model']);
  });

  it('detects account and key changes without exposing credential material', () => {
    const original = createConversationConnectionBinding({
      account: { accountIdentity: 'first@example.com' },
      credential: 'sk-first',
      view: view('deepseek-v4-flash'),
    });
    const current = createConversationConnectionBinding({
      account: { accountIdentity: 'second@example.com' },
      credential: 'sk-second',
      view: view('deepseek-v4-flash'),
    });
    const identity = conversationModelIdentity(original, 'bound');

    expect(conversationModelDifferences(original, current)).toEqual(['account', 'credential']);
    expect(identity.accountDetail).toMatch(/SHA-256 [0-9a-f]{10}/);
    expect(identity.accountDetail).not.toContain('sk-first');
    expect(identity.networkPresentation).toBe('domestic');
  });

  it('uses the immutable current credential even when matching history contains an older key', () => {
    const current = createConversationConnectionBinding({
      credential: 'sk-current',
      preferReplayConfig: false,
      replay: {
        config: {
          ...view('deepseek-v4-flash'),
          credential: 'sk-history',
          credentialAction: 'replace',
        },
        name: '团队接入',
        protocol: 'anthropic',
      },
      view: view('deepseek-v4-flash'),
    });

    expect(current.config.credential).toBe('sk-current');
    expect(current.connectionName).toBe('团队接入');
  });
});
