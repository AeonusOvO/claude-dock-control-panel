import { describe, expect, it, vi } from 'vitest';
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

  it('FLIP-translates the action capsule from its current screen position without fading it', async () => {
    await withTerminalRenderer({}, async (harness) => {
      const actions = harness.query<HTMLElement>('.connection-wizard-actions');
      const configureStep = harness.query<HTMLElement>('[data-connection-wizard-step="configure"]');
      vi.spyOn(actions, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            bottom: configureStep.hidden ? 476 : 796,
            height: 56,
            left: 80,
            right: 1080,
            top: configureStep.hidden ? 420 : 740,
            width: 1000,
            x: 80,
            y: configureStep.hidden ? 420 : 740,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const cancel = vi.fn();
      const addEventListener = vi.fn();
      const animate = vi.fn(
        (
          _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
          _options?: number | KeyframeAnimationOptions,
        ) => ({ addEventListener, cancel }) as unknown as Animation,
      );
      Object.defineProperty(actions, 'animate', { configurable: true, value: animate });

      harness.click('[data-rail-tab="connection"]');
      harness.click('[data-provider-id="deepseek"]');
      harness.click('#connection-wizard-next');

      expect(animate).toHaveBeenCalledOnce();
      const [keyframes, options] = animate.mock.calls[0]!;
      expect(keyframes).toEqual([
        { transform: 'translate3d(0px, -320px, 0)' },
        { transform: 'translate3d(0, 0, 0)' },
      ]);
      expect(keyframes).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ opacity: 0 })]),
      );
      expect(options).toEqual(
        expect.objectContaining({ easing: expect.stringContaining('cubic-bezier') }),
      );
      expect(actions.dataset.motion).toBe('flip');

      Object.defineProperty(harness.dom.window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({ matches: query.includes('prefers-reduced-motion') }),
      });
      harness.click('#connection-wizard-previous');
      expect(cancel).toHaveBeenCalledOnce();
      expect(animate).toHaveBeenCalledOnce();
      expect(actions.dataset.motion).toBeUndefined();
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
