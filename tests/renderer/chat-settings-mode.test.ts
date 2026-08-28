import { describe, expect, it } from 'vitest';
import type { ChatConfigView, SaveChatConfigInput } from '../../src/shared/contracts';
import { change, input, settle, withRenderer } from '../helpers/renderer-interaction-fixture';

const config: ChatConfigView = {
  authMode: 'bearer',
  baseUrl: 'https://relay.example.com',
  credentialConfigured: false,
  model: 'previous-model',
  preset: 'custom',
  protocol: 'openai',
};

describe('independent chat simple settings', () => {
  it('defaults to simple settings, hides domestic URLs, and preserves a draft through both toggles', async () => {
    await withRenderer({ getChatConfig: async () => config }, async (harness) => {
      harness.click('#open-chat-settings');
      await settle(harness);
      const form = harness.query<HTMLFormElement>('#chat-config-form');
      const provider = harness.query<HTMLSelectElement>('#chat-provider');
      expect(form.dataset.settingsMode).toBe('simple');
      expect(harness.query('#chat-settings-mode').textContent).toBe('高级设置');
      expect(harness.query('#chat-config-status').textContent).toBe('');
      expect(harness.query('#chat-credential-status').textContent).toBe('');
      expect(harness.query('#chat-connection-test').dataset.tone).toBe('idle');
      expect(harness.query('#test-chat-connection').hasAttribute('data-connection-advanced')).toBe(
        true,
      );
      change(provider, 'deepseek');
      input(harness.query('#chat-credential'), 'draft-key');
      expect(harness.query('#chat-base-url-field').hidden).toBe(true);
      harness.click('#chat-settings-mode');
      expect(form.dataset.settingsMode).toBe('advanced');
      expect(harness.query('#chat-settings-mode').textContent).toBe('极简设置');
      expect(harness.query('#chat-base-url-field').hidden).toBe(false);
      input(harness.query('#chat-model'), 'manual-model');
      harness.click('#chat-settings-mode');
      expect(form.dataset.settingsMode).toBe('simple');
      expect(harness.query<HTMLInputElement>('#chat-credential').value).toBe('draft-key');
      expect(harness.query<HTMLInputElement>('#chat-model').value).toBe('manual-model');
      expect(harness.query<HTMLInputElement>('#chat-model').required).toBe(false);
      expect(harness.query('.chat-config-form .connection-cost-notice').textContent).toBe(
        '可能会消耗少量 token',
      );
      expect(harness.method('saveChatConfig')).not.toHaveBeenCalled();
      harness.click('#chat-settings-mode');
      input(harness.query('#chat-base-url'), 'relay.example.com/custom');
      harness.click('#chat-settings-mode');
      expect(provider.value).toBe('custom');
      expect(harness.query('#chat-base-url-field').hidden).toBe(false);
      expect(harness.query<HTMLInputElement>('#chat-base-url').value).toBe(
        'relay.example.com/custom',
      );
      expect(harness.query<HTMLInputElement>('#chat-credential').value).toBe('draft-key');
    });
  });

  it('submits one immutable auto-connect request and does not duplicate a paid test', async () => {
    let finish!: (value: ChatConfigView) => void;
    await withRenderer(
      {
        getChatConfig: async () => config,
        saveChatConfig: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      async (harness) => {
        harness.click('#open-chat-settings');
        await settle(harness);
        input(harness.query('#chat-base-url'), 'relay.example.com/prefix');
        input(harness.query('#chat-credential'), 'draft-key');
        harness.click('#save-chat-config');
        const captured = harness.method('saveChatConfig').mock.calls[0]?.[0] as SaveChatConfigInput;
        expect(captured).toMatchObject({
          autoDetect: true,
          baseUrl: 'relay.example.com/prefix',
          credential: 'draft-key',
          preset: 'custom',
        });
        expect(harness.query<HTMLButtonElement>('#chat-settings-mode').disabled).toBe(true);
        expect(harness.query<HTMLSelectElement>('#chat-provider').disabled).toBe(true);
        expect(harness.query<HTMLInputElement>('#chat-credential').disabled).toBe(true);
        input(harness.query('#chat-base-url'), 'another.example.com');
        harness.click('#save-chat-config');
        expect(harness.method('saveChatConfig')).toHaveBeenCalledOnce();
        expect(captured.baseUrl).toBe('relay.example.com/prefix');
        finish({ ...config, model: 'discovered-model', credentialConfigured: true });
        await settle(harness);
        expect(harness.query<HTMLDialogElement>('#chat-settings-dialog').open).toBe(false);
        expect(harness.query<HTMLInputElement>('#chat-credential').value).toBe('');
        expect(harness.query<HTMLButtonElement>('#save-chat-config').disabled).toBe(false);
        expect(harness.method('testChatConnection')).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps failed drafts editable and only uses explicit fields in advanced mode', async () => {
    await withRenderer(
      {
        getChatConfig: async () => config,
        saveChatConfig: async () => {
          throw new Error('请检查密钥。');
        },
      },
      async (harness) => {
        harness.click('#open-chat-settings');
        await settle(harness);
        harness.click('#chat-settings-mode');
        input(harness.query('#chat-credential'), 'draft-key');
        input(harness.query('#chat-model'), 'manual-model');
        harness.click('#save-chat-config');
        await settle(harness);
        expect(harness.method('saveChatConfig').mock.calls[0]?.[0]).toMatchObject({
          model: 'manual-model',
          protocol: 'openai',
        });
        expect(harness.method('saveChatConfig').mock.calls[0]?.[0]).not.toHaveProperty(
          'autoDetect',
        );
        expect(harness.query<HTMLDialogElement>('#chat-settings-dialog').open).toBe(true);
        expect(harness.query<HTMLInputElement>('#chat-credential').value).toBe('draft-key');
        expect(harness.query<HTMLInputElement>('#chat-credential').disabled).toBe(false);
        expect(harness.query('#chat-config-status').textContent).toBe('请检查密钥。');
        harness.click('#close-chat-settings');
        harness.click('#open-chat-settings');
        await settle(harness);
        expect(harness.query('#chat-config-form').dataset.settingsMode).toBe('simple');
        expect(harness.query<HTMLInputElement>('#chat-model').value).toBe('previous-model');
      },
    );
  });
});
