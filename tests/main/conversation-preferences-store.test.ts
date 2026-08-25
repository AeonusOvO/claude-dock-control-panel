import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

const { ConversationPreferencesStore } =
  await import('../../src/main/conversation/preferences-store');

const CONVERSATION = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

describe('conversation preferences store', () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-conversation-'));
  });

  afterEach(() => {
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('round-trips a conversation through a fresh store instance', () => {
    new ConversationPreferencesStore(userDataPath).record(CONVERSATION, {
      effort: 'xhigh',
      model: 'claude-opus-5',
      permissionMode: 'acceptEdits',
    });

    expect(new ConversationPreferencesStore(userDataPath).get(CONVERSATION)).toMatchObject({
      effort: 'xhigh',
      model: 'claude-opus-5',
      permissionMode: 'acceptEdits',
    });
  });

  it('merges partial observations instead of erasing what is already known', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    store.record(CONVERSATION, { effort: 'high', model: 'claude-opus-5' });
    store.record(CONVERSATION, { permissionMode: 'plan' });

    expect(store.get(CONVERSATION)).toMatchObject({
      effort: 'high',
      model: 'claude-opus-5',
      permissionMode: 'plan',
    });
  });

  it('rejects ids and values that could reach a shell or a filename', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    store.record('../../etc/passwd', { model: 'claude-opus-5' });
    store.record(CONVERSATION, {
      effort: 'turbo' as never,
      model: 'claude-opus-5; rm -rf /',
      permissionMode: 'root' as never,
    });

    expect(store.get('../../etc/passwd')).toBeUndefined();
    expect(store.get(CONVERSATION)).toBeUndefined();
  });

  it('forgets a conversation on request', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    store.record(CONVERSATION, { effort: 'low' });
    store.remove(CONVERSATION);

    expect(store.get(CONVERSATION)).toBeUndefined();
  });

  it('encrypts a complete API binding and restores its detailed identity', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    store.record(CONVERSATION, {
      binding: {
        config: {
          authMode: 'authToken',
          baseUrl: 'https://api.deepseek.com/anthropic',
          credential: 'sk-super-secret',
          credentialAction: 'replace',
          model: 'deepseek-v4-pro',
          modelFast: 'deepseek-v4-flash',
          preset: 'deepseek',
          protocol: 'anthropic',
          provider: 'gateway',
        },
        connectionName: '生产 DeepSeek',
        credentialConfigured: true,
        protocol: 'anthropic',
      },
    });

    const onDisk = readFileSync(
      path.join(userDataPath, 'claude', 'conversation-preferences.json'),
      'utf8',
    );
    expect(onDisk).not.toContain('sk-super-secret');
    expect(onDisk).toContain('credentialFingerprint');
    expect(new ConversationPreferencesStore(userDataPath).get(CONVERSATION)?.binding).toMatchObject(
      {
        config: {
          credential: 'sk-super-secret',
          model: 'deepseek-v4-pro',
          modelFast: 'deepseek-v4-flash',
        },
        connectionName: '生产 DeepSeek',
        credentialConfigured: true,
      },
    );
  });

  it('treats a blank small model and an explicitly equal model as the same binding', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    const binding = {
      config: {
        authMode: 'authToken' as const,
        baseUrl: 'https://api.example.com/anthropic',
        credential: 'sk-stable',
        credentialAction: 'replace' as const,
        model: 'deepseek-v4-pro',
        modelFast: '',
        preset: 'custom' as const,
        protocol: 'anthropic' as const,
        provider: 'gateway' as const,
      },
      credentialConfigured: true,
      protocol: 'anthropic' as const,
    };
    store.record(CONVERSATION, { binding });
    const storagePath = path.join(userDataPath, 'claude', 'conversation-preferences.json');
    const first = readFileSync(storagePath, 'utf8');
    store.record(CONVERSATION, {
      binding: {
        ...binding,
        config: { ...binding.config, modelFast: 'deepseek-v4-pro' },
      },
    });

    expect(readFileSync(storagePath, 'utf8')).toBe(first);
    expect(store.get(CONVERSATION)?.binding?.config.modelFast).toBe('deepseek-v4-pro');
  });
});
