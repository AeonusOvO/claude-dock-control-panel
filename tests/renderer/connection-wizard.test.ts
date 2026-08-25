import { describe, expect, it } from 'vitest';
import { withTerminalRenderer } from '../helpers/renderer-interaction-fixture';

describe('connection access wizard', () => {
  it('keeps model selection explicit and moves forward and backward', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.query<HTMLButtonElement>('[data-provider-id="deepseek"]').click();
      expect(
        harness
          .query<HTMLButtonElement>('[data-provider-id="deepseek"]')
          .getAttribute('aria-pressed'),
      ).toBe('true');
      harness.click('#connection-wizard-next');
      expect(harness.query('[data-connection-wizard-step="configure"]').hidden).toBe(false);
      expect(harness.query('#connection-provider-setup').hasAttribute('hidden')).toBe(false);
      harness.click('#connection-wizard-previous');
      expect(harness.query('[data-connection-wizard-step="choice"]').hidden).toBe(false);
    });
  });

  it('cancels an interruptible authorization on Previous and locks Proxy API configuration', async () => {
    await withTerminalRenderer(
      {
        cancelManagedChatGptGatewaySetup: async () => ({
          message: '已取消当前 OpenAI 授权并返回模型选择。',
          ok: true,
        }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="chatgpt-subscription"]');
        harness.click('#connection-wizard-next');
        harness.emit('onManagedChatGptSetupProgress', {
          active: true,
          detail: '正在等待你在 OpenAI 官方页面完成授权。',
          interruptible: true,
          sessionId: 'session-1',
          stage: 'logging-in',
          step: 5,
          totalSteps: 8,
        });
        expect(harness.query<HTMLButtonElement>('#connection-wizard-previous').disabled).toBe(
          false,
        );
        harness.click('#connection-wizard-previous');
        await harness.flush();
        expect(harness.method('cancelManagedChatGptGatewaySetup')).toHaveBeenCalledOnce();
        expect(harness.query('[data-connection-wizard-step="choice"]').hidden).toBe(false);

        harness.emit('onManagedChatGptSetupProgress', {
          active: false,
          detail: 'OpenAI 授权已取消。',
          interruptible: false,
          sessionId: 'session-1',
          stage: 'error',
          step: 5,
          totalSteps: 8,
        });
        harness.click('#connection-wizard-next');
        harness.emit('onManagedChatGptSetupProgress', {
          active: true,
          detail: '授权已确认，正在配置本机 Proxy API。',
          interruptible: false,
          sessionId: 'session-1',
          stage: 'discovering-models',
          step: 6,
          totalSteps: 8,
        });
        expect(harness.query<HTMLButtonElement>('#connection-wizard-previous').disabled).toBe(true);
        expect(harness.query('#connection-wizard-status').textContent).toContain('不可打断');
      },
    );
  });

  it('stays on configuration when the main process reports that cancellation lost the race', async () => {
    await withTerminalRenderer(
      {
        cancelManagedChatGptGatewaySetup: async () => ({
          message: '当前没有可取消的授权操作。',
          ok: false,
        }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="chatgpt-subscription"]');
        harness.click('#connection-wizard-next');
        harness.emit('onManagedChatGptSetupProgress', {
          active: true,
          detail: '正在等待你在 OpenAI 官方页面完成授权。',
          interruptible: true,
          sessionId: 'session-1',
          stage: 'logging-in',
          step: 5,
          totalSteps: 8,
        });

        harness.click('#connection-wizard-previous');
        await harness.flush();

        expect(harness.query('[data-connection-wizard-step="configure"]').hidden).toBe(false);
        expect(harness.query<HTMLButtonElement>('#connection-wizard-previous').disabled).toBe(true);
        expect(harness.query('#toast').textContent).toContain('当前没有可取消');
      },
    );
  });
});
