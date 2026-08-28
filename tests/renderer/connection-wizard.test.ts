import { describe, expect, it, vi } from 'vitest';
import {
  input,
  change,
  settle,
  withRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import type {
  ClaudeNextConversationConnectionState,
  ManagedChatGptGatewayState,
  SubscriptionResult,
  SubscriptionState,
} from '../../src/shared/contracts';
import { claudeProjectState } from '../helpers/renderer-terminal-fixture';
import { SUBSCRIPTION_PROVIDERS } from '../../src/shared/claude/subscriptions';

const readyManagedChatGptState = (): ManagedChatGptGatewayState => ({
  authenticated: true,
  availableModels: ['gpt-5.6-sol'],
  busy: false,
  checkedAt: 1,
  endpoint: 'http://127.0.0.1:8317',
  installed: true,
  managementAvailable: true,
  message: 'CLIProxyAPI 已在本机安全运行。',
  phase: 'ready',
  running: true,
  usageStatisticsEnabled: false,
});

describe('connection access wizard', () => {
  it('keeps an open domestic model menu alive during repeated terminal state updates', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      await settle(harness);
      harness.click('[data-provider-id="deepseek"]');
      const select = harness.query<HTMLSelectElement>('#connection-domestic-model');
      const trigger = select.parentElement!.querySelector<HTMLButtonElement>('button')!;
      select.dispatchEvent(
        new harness.dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      for (let revision = 2; revision <= 5; revision += 1) {
        harness.emit(
          'onClaudeState',
          claudeProjectState({
            active: true,
            ptyGeneration: 1,
            stateRevision: revision,
            metrics: { capturedAt: revision, inputTokens: revision * 10 },
          }),
        );
        await harness.flush();
      }
      expect(harness.query('#connection-domestic-model')).toBe(select);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      change(select, 'glm-subscription-cn');
      expect(harness.query<HTMLSelectElement>('#claude-preset').value).toBe('glm-subscription-cn');
    });
  });

  it.each(['custom', 'deepseek', 'anthropic-api', 'anthropic'] as const)(
    'shows one success dialog and returns to model selection after connecting %s',
    async (preset) => {
      await withRenderer(
        {
          saveNextClaudeConfig: async (input) => ({
            ok: true,
            state: {
              config: {
                ...claudeProjectState().config,
                preset: input.preset,
                baseUrl: input.baseUrl,
                authMode: input.authMode,
                model: input.model,
                provider: input.provider,
                credentialConfigured: true,
              },
            },
          }),
        },
        async (harness) => {
          harness.click('[data-rail-tab="connection"]');
          harness.click(
            preset === 'anthropic'
              ? '[data-provider-id="anthropic"]'
              : preset === 'deepseek'
                ? '[data-provider-id="deepseek"]'
                : '[data-provider-id="custom"]',
          );
          harness.click('#connection-wizard-next');
          if (preset === 'anthropic-api')
            change(harness.query<HTMLSelectElement>('#claude-preset'), preset);
          if (preset !== 'anthropic') {
            input(harness.query('#claude-base-url'), 'https://api.example.test');
            input(harness.query('#claude-credential'), 'test-secret');
          }
          harness.query<HTMLFormElement>('#claude-config-form').requestSubmit();
          await settle(harness);
          expect(harness.query<HTMLDialogElement>('#connection-success-dialog').open).toBe(true);
          expect(harness.query('#connection-success-title').textContent).toBe('模型已连接');
          expect(
            harness
              .query('[data-connection-wizard-step="choice"]')
              .classList.contains('connection-wizard-step--active'),
          ).toBe(true);
          expect(
            harness
              .query('[data-connection-wizard-step="configure"]')
              .classList.contains('connection-wizard-step--active'),
          ).toBe(false);
          expect(harness.method('saveNextClaudeConfig')).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it.each(SUBSCRIPTION_PROVIDERS)(
    'returns to the picker with the bound account after %s succeeds',
    async (provider) => {
      const complete: SubscriptionState = {
        attempt: 'completed-login',
        provider,
        revision: 5,
        phase: 'complete',
        busy: false,
        cancellable: false,
        message: '订阅已连接。',
      };
      await withRenderer(
        {
          setupSubscription: async () => ({
            ok: true,
            message: '订阅已连接。',
            state: complete,
            nextConnection: {
              accountIdentity: 'member@example.test',
              config: {
                ...claudeProjectState().config,
                preset: provider,
                provider: 'gateway',
                authMode: 'authToken',
                baseUrl: 'http://127.0.0.1:18520/s/' + 'a'.repeat(32),
                model: 'subscription-model',
                credentialConfigured: true,
              },
            },
          }),
        },
        async (harness) => {
          harness.click('[data-rail-tab="connection"]');
          harness.click('[data-provider-id="deepseek"]');
          change(harness.query<HTMLSelectElement>('#connection-domestic-model'), provider);
          harness.click('#connection-wizard-next');
          harness.click('#connection-wizard-next');
          await settle(harness);
          const dialog = harness.query<HTMLDialogElement>('#connection-success-dialog');
          expect(dialog.open).toBe(true);
          expect(
            harness
              .query('[data-connection-wizard-step="choice"]')
              .classList.contains('connection-wizard-step--active'),
          ).toBe(true);
          expect(harness.query('#current-connection-type').textContent).toBe('订阅');
          expect(harness.query('#current-connection-metadata').textContent).toContain(
            '账户：member@example.test',
          );
          expect(harness.query('#current-connection').textContent).not.toContain('127.0.0.1');
          dialog.close();
          harness.emit('onSubscriptionState', complete);
          await harness.flush();
          expect(dialog.open).toBe(false);
        },
      );
    },
  );

  it('confirms ChatGPT setup once and rejects an older connection read after it commits', async () => {
    let finishRead!: (value: ClaudeNextConversationConnectionState) => void;
    const previousConnection = new Promise<ClaudeNextConversationConnectionState>((resolve) => {
      finishRead = resolve;
    });
    const connected = {
      config: {
        ...claudeProjectState().config,
        preset: 'chatgpt-subscription' as const,
        provider: 'gateway' as const,
        authMode: 'authToken' as const,
        baseUrl: 'http://127.0.0.1:8317',
        model: 'gpt-5.6-sol',
        credentialConfigured: true,
      },
    };
    await withRenderer(
      {
        getNextClaudeConnection: () => previousConnection,
        getManagedChatGptGatewayState: async () => readyManagedChatGptState(),
        setupManagedChatGptGateway: async () => ({
          ok: true,
          message: '已连接',
          state: readyManagedChatGptState(),
          nextConnection: connected,
        }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="chatgpt-subscription"]');
        harness.click('#connection-wizard-next');
        await settle(harness);
        harness.click('#connection-wizard-next');
        await settle(harness);
        expect(harness.query<HTMLDialogElement>('#connection-success-dialog').open).toBe(true);
        expect(
          harness
            .query('[data-connection-wizard-step="choice"]')
            .classList.contains('connection-wizard-step--active'),
        ).toBe(true);
        harness.query<HTMLDialogElement>('#connection-success-dialog').close();
        finishRead({ config: claudeProjectState().config });
        await settle(harness);
        expect(harness.query('#current-connection-name').textContent).toBe('ChatGPT 官方订阅');
        expect(harness.query('#current-connection-type').textContent).toBe('订阅');
        expect(harness.query<HTMLDialogElement>('#connection-success-dialog').open).toBe(false);
      },
    );
  });

  it('labels domestic options with subscription/API capsules and opens an account login without key fields', async () => {
    let finish!: (value: SubscriptionResult) => void;
    await withRenderer(
      {
        setupSubscription: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="deepseek"]');
        const select = harness.query<HTMLSelectElement>('#connection-domestic-model');
        expect(select.querySelector<HTMLOptionElement>('[value="deepseek"]')?.dataset.badge).toBe(
          'API',
        );
        expect(
          select.querySelector<HTMLOptionElement>('[value="kimi-subscription"]')?.dataset.badge,
        ).toBe('订阅');
        change(select, 'kimi-subscription');
        expect(
          harness.query('#connection-domestic-model').parentElement?.querySelector('.select__badge')
            ?.textContent,
        ).toBe('订阅');
        harness.click('#connection-wizard-next');
        expect(harness.query('#claude-config-form').hidden).toBe(true);
        expect(harness.query('.domestic-subscription-guide').textContent).toContain(
          '可能会消耗少量 token',
        );
        harness.click('#connection-wizard-next');
        harness.click('#connection-wizard-next');
        expect(harness.method('setupSubscription')).toHaveBeenCalledExactlyOnceWith(
          'kimi-subscription',
        );
        expect(harness.method('saveNextClaudeConfig')).not.toHaveBeenCalled();
        finish({
          ok: false,
          message: '已取消',
          state: {
            revision: 2,
            phase: 'error',
            provider: 'kimi-subscription',
            attempt: 'one',
            message: '已取消',
            busy: false,
            cancellable: false,
          },
        });
        await harness.flush();
      },
    );
  });

  it('uses the exact main-owned attempt for cancellation and ignores stale subscription snapshots', async () => {
    let finish!: (value: SubscriptionResult) => void;
    const active: SubscriptionState = {
      revision: 8,
      phase: 'authorizing',
      provider: 'kimi-subscription',
      attempt: 'current-attempt',
      busy: true,
      cancellable: true,
      message: '请在浏览器中完成登录。',
      userCode: 'ABCD',
    };
    const stopped: SubscriptionState = {
      ...active,
      revision: 9,
      phase: 'error',
      busy: false,
      cancellable: false,
      message: '已取消',
      userCode: undefined,
    };
    await withRenderer(
      {
        setupSubscription: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        cancelSubscriptionSetup: async () => {
          const result = { ok: true, message: '已取消', state: stopped };
          finish({ ...result, ok: false });
          return result;
        },
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="deepseek"]');
        change(harness.query<HTMLSelectElement>('#connection-domestic-model'), 'kimi-subscription');
        harness.click('#connection-wizard-next');
        harness.click('#connection-wizard-next');
        harness.emit('onSubscriptionState', active);
        harness.emit('onSubscriptionState', {
          ...active,
          revision: 2,
          busy: false,
          cancellable: false,
          message: 'stale',
        });
        expect(harness.query('#connection-wizard-status').textContent).toBe(active.message);
        expect(harness.query('.subscription-user-code').textContent).toContain('ABCD');
        expect(harness.query<HTMLButtonElement>('#connection-wizard-next').disabled).toBe(true);
        harness.click('#connection-wizard-previous');
        await harness.flush();
        expect(harness.method('cancelSubscriptionSetup')).toHaveBeenCalledExactlyOnceWith(
          'current-attempt',
        );
        expect(harness.query('[data-connection-wizard-step="choice"]').hidden).toBe(false);
        expect(harness.method('saveNextClaudeConfig')).not.toHaveBeenCalled();
      },
    );
  });

  it('does not let a slow startup read overwrite a newly connected subscription', async () => {
    let finishRead!: (value: ClaudeNextConversationConnectionState) => void;
    const connected: ClaudeNextConversationConnectionState = {
      config: {
        preset: 'kimi-subscription',
        provider: 'gateway',
        protocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:18520/s/' + 'a'.repeat(32),
        authMode: 'authToken',
        credentialConfigured: true,
        model: 'kimi-for-coding',
        apiKeyHelperPolicy: 'prefer-claudedock',
      },
    };
    await withRenderer(
      {
        getNextClaudeConnection: () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
        setupSubscription: async () => ({
          ok: true,
          message: '订阅已连接。',
          nextConnection: connected,
          state: {
            revision: 3,
            attempt: 'new',
            provider: 'kimi-subscription',
            phase: 'complete',
            busy: false,
            cancellable: false,
            message: '订阅已连接。',
          },
        }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="deepseek"]');
        change(harness.query<HTMLSelectElement>('#connection-domestic-model'), 'kimi-subscription');
        harness.click('#connection-wizard-next');
        harness.click('#connection-wizard-next');
        await harness.flush();
        expect(harness.method('setupSubscription')).toHaveBeenCalledOnce();
        finishRead({});
        await harness.flush();
        expect(harness.query<HTMLSelectElement>('#claude-preset').value).toBe('kimi-subscription');
        expect(harness.query('#current-connection-name').textContent).toContain('Kimi');
      },
    );
  });
  it('shows only the key for domestic presets and preserves fields when advanced settings are toggled', async () => {
    await withRenderer(
      {
        getSoftwareUpdates: async () => ({
          checkedAt: 1,
          claudeCode: { installed: true, updateAvailable: false, message: '' },
          router: { installed: false, updateAvailable: false, message: '' },
        }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        await settle(harness);
        harness.click('[data-provider-id="deepseek"]');
        harness.click('#connection-wizard-next');
        expect(harness.query('#claude-config-form').dataset.settingsMode).toBe('simple');
        expect(harness.query('#base-url-field').hidden).toBe(true);
        expect(harness.query('#protocol-field').hidden).toBe(true);
        expect(harness.query('#auth-mode-field').hidden).toBe(true);
        input(harness.query('#claude-credential'), 'draft-secret');
        harness.click('#connection-settings-mode');
        expect(harness.query('#connection-settings-mode').textContent).toBe('极简设置');
        expect(harness.query('#base-url-field').hidden).toBe(false);
        expect(harness.query('#protocol-field').hidden).toBe(false);
        input(harness.query('#claude-model'), 'manual-model');
        harness.click('#connection-settings-mode');
        expect(harness.query('#claude-config-form').dataset.settingsMode).toBe('simple');
        expect(harness.query<HTMLInputElement>('#claude-model').value).toBe('manual-model');
        expect(harness.query<HTMLInputElement>('#claude-credential').value).toBe('draft-secret');
        expect(harness.method('saveNextClaudeConfig')).not.toHaveBeenCalled();
        harness.click('#connection-settings-mode');
        input(harness.query('#claude-base-url'), 'relay.example.com/custom');
        harness.click('#connection-settings-mode');
        expect(harness.query<HTMLSelectElement>('#claude-preset').value).toBe('custom');
        expect(harness.query('#base-url-field').hidden).toBe(false);
        expect(harness.query<HTMLInputElement>('#claude-base-url').value).toBe(
          'relay.example.com/custom',
        );
        expect(harness.query<HTMLInputElement>('#claude-credential').value).toBe('draft-secret');
      },
    );
  });

  it('connects a simple draft in one transaction and preserves the draft on failure', async () => {
    await withRenderer(
      {
        saveNextClaudeConfig: async () => ({ ok: false, error: '请检查密钥。', state: {} }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="custom"]');
        harness.click('#connection-wizard-next');
        input(harness.query('#claude-base-url'), 'relay.example.com/tenant');
        input(harness.query('#claude-credential'), 'draft-secret');
        harness.query<HTMLFormElement>('#claude-config-form').requestSubmit();
        await harness.flush();
        expect(harness.method('saveNextClaudeConfig')).toHaveBeenCalledOnce();
        expect(harness.method('saveNextClaudeConfig').mock.calls[0]?.[0]).toMatchObject({
          autoDetect: true,
          baseUrl: 'https://relay.example.com/tenant',
          credential: 'draft-secret',
        });
        expect(harness.method('testNextClaudeConnection')).not.toHaveBeenCalled();
        expect(harness.query<HTMLInputElement>('#claude-credential').value).toBe('draft-secret');
        expect(harness.query('#connection-test-summary').textContent).toBe('请检查密钥。');
        expect(harness.query<HTMLDialogElement>('#connection-success-dialog').open).toBe(false);
        expect(
          harness
            .query('[data-connection-wizard-step="configure"]')
            .classList.contains('connection-wizard-step--active'),
        ).toBe(true);
      },
    );
  });

  it('configures the next ChatGPT conversation without requiring an opened conversation', async () => {
    await withRenderer(
      { getManagedChatGptGatewayState: async () => readyManagedChatGptState() },
      async (harness) => {
        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="chatgpt-subscription"]');
        harness.click('#connection-wizard-next');
        await harness.flush();

        expect(harness.query('#connection-wizard-status').textContent).toBe(
          '正在配置下个对话使用的 ChatGPT 官方订阅',
        );
        expect(harness.query('#current-connection-name').textContent).toBe('尚未选择接入');
      },
    );
  });

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

  it('returns to model selection whenever the user re-enters Access', async () => {
    await withRenderer({}, async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.click('[data-provider-id="deepseek"]');
      harness.click('#connection-wizard-next');
      expect(harness.query('[data-connection-wizard-step="configure"]').hidden).toBe(false);

      harness.click('[data-rail-tab="connection"]');
      harness.click('[data-rail-tab="connection"]');

      const choice = harness.query('[data-connection-wizard-step="choice"]');
      const configure = harness.query('[data-connection-wizard-step="configure"]');
      expect(choice.hidden).toBe(false);
      expect(choice.classList.contains('connection-wizard-step--active')).toBe(true);
      expect(configure.classList.contains('connection-wizard-step--active')).toBe(false);
      expect(configure.classList.contains('connection-wizard-step--leaving')).toBe(true);
    });
  });

  it('does not let a late global-profile read overwrite a model source the user just chose', async () => {
    let resolveConnection!: (value: {
      config: ReturnType<typeof claudeProjectState>['config'];
    }) => void;
    const connection = new Promise<{ config: ReturnType<typeof claudeProjectState>['config'] }>(
      (resolve) => {
        resolveConnection = resolve;
      },
    );
    await withRenderer({ getNextClaudeConnection: () => connection }, async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.click('[data-provider-id="deepseek"]');
      resolveConnection({ config: claudeProjectState().config });
      await harness.flush();

      expect(
        harness
          .query<HTMLButtonElement>('[data-provider-id="deepseek"]')
          .getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        harness
          .query<HTMLButtonElement>('[data-provider-id="anthropic"]')
          .getAttribute('aria-pressed'),
      ).toBe('false');
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
          sessionId: undefined,
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
          sessionId: undefined,
          stage: 'error',
          step: 5,
          totalSteps: 8,
        });
        harness.click('#connection-wizard-next');
        harness.emit('onManagedChatGptSetupProgress', {
          active: true,
          detail: '授权已确认，正在配置本机 Proxy API。',
          interruptible: false,
          sessionId: undefined,
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
          sessionId: undefined,
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
