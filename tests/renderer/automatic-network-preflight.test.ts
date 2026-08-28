import { describe, expect, it } from 'vitest';
import type {
  AppSettingsView,
  NetworkPreflightPreferences,
  NetworkPreflightResult,
} from '../../src/shared/contracts';
import { change, settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import { preflightResult, readyCodexState } from '../helpers/renderer-preflight-fixture';

const settings = (networkPreflight: NetworkPreflightPreferences): AppSettingsView => ({
  advanced: { chatIdleTimeoutMinutes: 0, networkPreflight, webResearchIsolation: false },
  artifactNetworkAllowed: true,
  claudeContextWindowMode: 'auto',
  closeBehavior: 'tray',
  conversationResume: {
    autoLoadLastConversationModelOnStartup: false,
    autoLoadLastConversationOnStartup: false,
    modelMismatchBehavior: 'ask',
    startupModelConnectCancelAfterMinutes: 2,
    startupModelConnectForceStopAfterMinutes: 5,
  },
  footerResourcePreference: 'auto',
  language: 'zh-CN',
  launchAtLogin: false,
  managedChatGptContextWindowMode: 'standard',
  theme: 'claude',
  version: 'test',
});

const disabled = { checkOnNewSession: false, checkOnProviderLogin: false };

describe('renderer automatic network preflight switches', () => {
  it('waits for saved preferences before visibility or online events can start probes', async () => {
    let finishSettings!: (value: AppSettingsView) => void;
    const loading = new Promise<AppSettingsView>((resolve) => {
      finishSettings = resolve;
    });
    await withTerminalRenderer(
      {
        getAppSettings: () => loading,
        getCodexProjectState: async () => readyCodexState(),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('online'));
        await settle(harness);
        expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
        finishSettings(settings(disabled));
        await settle(harness);
        expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
      },
    );
  });
  it.each(['claude', 'codex'] as const)(
    'does not probe %s on startup, visibility, network changes or settings navigation when disabled',
    async (runtime) => {
      await withTerminalRenderer(
        {
          getAppSettings: async () => settings(disabled),
          getCodexProjectState: async () => readyCodexState(),
          getDevelopmentRuntime: async (sessionId) => ({ cwd: 'D:\\Project', runtime, sessionId }),
          runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
        },
        async (harness) => {
          expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
          expect(harness.query('#network-preflight-summary').textContent).toBe(
            '自动网络预检已关闭',
          );
          window.dispatchEvent(new Event('online'));
          window.dispatchEvent(new Event('offline'));
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          await settle(harness);
          harness.click('#open-connection-advanced');
          await settle(harness);
          harness.click('[data-settings-tab="network"]');
          await settle(harness);
          expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
          expect(harness.query('#settings-network-summary').textContent).toBe('自动网络预检已关闭');
          expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(false);
          if (runtime === 'codex') {
            expect(harness.query<HTMLButtonElement>('#codex-launch-new').disabled).toBe(false);
          }
        },
      );
    },
  );

  it('keeps each manual detection button usable while automatic checks are disabled', async () => {
    await withTerminalRenderer(
      {
        getAppSettings: async () => settings(disabled),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        for (const selector of [
          '#network-preflight-trigger',
          '#network-preflight-recheck',
          '#settings-network-recheck',
          '#network-preflight-dialog-recheck',
        ]) {
          harness.clearCalls();
          harness.click(selector);
          await settle(harness);
          expect(harness.method('runNetworkPreflight')).toHaveBeenCalledExactlyOnceWith({
            action: 'background',
            force: true,
            provider: 'ai-services',
          });
          expect(harness.query(selector).getAttribute('aria-busy')).toBe('false');
        }
      },
    );
  });

  it('applies saved switches immediately, ignores late automatic results, and permits later re-enabling', async () => {
    let saved = settings({ checkOnNewSession: true, checkOnProviderLogin: true });
    let finishFirst!: (value: NetworkPreflightResult) => void;
    let runs = 0;
    await withTerminalRenderer(
      {
        getAppSettings: async () => saved,
        setAdvancedSettings: async (advanced) => {
          saved = { ...saved, advanced };
          return saved;
        },
        runNetworkPreflight: async ({ provider }) => {
          runs += 1;
          return runs === 1
            ? new Promise<NetworkPreflightResult>((resolve) => {
                finishFirst = resolve;
              })
            : preflightResult(provider, 'allowed');
        },
      },
      async (harness) => {
        expect(runs).toBe(1);
        harness.click('#open-connection-advanced');
        await settle(harness);
        for (const selector of [
          '#settings-network-new-session',
          '#settings-network-provider-login',
        ]) {
          const toggle = harness.query<HTMLInputElement>(selector);
          toggle.checked = false;
          change(toggle);
        }
        harness.click('#complete-connection-advanced');
        await settle(harness);
        expect(saved.advanced.networkPreflight).toEqual(disabled);
        expect(harness.query('#network-preflight-trigger').getAttribute('aria-busy')).toBe('false');
        const late = preflightResult('anthropic-claude', 'blocked', {
          mainRunId: 20,
          generation: 2,
        });
        harness.emit('onNetworkPreflight', late);
        finishFirst(late);
        window.dispatchEvent(new Event('online'));
        await settle(harness);
        expect(runs).toBe(1);
        expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(false);
        expect(harness.query('#network-preflight-summary').textContent).toBe('自动网络预检已关闭');

        harness.click('#open-connection-advanced');
        await settle(harness);
        const toggle = harness.query<HTMLInputElement>('#settings-network-new-session');
        toggle.checked = true;
        change(toggle);
        harness.click('#complete-connection-advanced');
        await settle(harness);
        window.dispatchEvent(new Event('online'));
        await settle(harness);
        expect(saved.advanced.networkPreflight.checkOnNewSession).toBe(true);
        expect(runs).toBe(2);
      },
    );
  });

  it('does not let a manual blocked result disable Codex launch when new-session checks are off', async () => {
    await withTerminalRenderer(
      {
        getAppSettings: async () => settings(disabled),
        getCodexProjectState: async () => readyCodexState(),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'blocked'),
      },
      async (harness) => {
        harness.click('#network-preflight-recheck');
        await settle(harness);
        harness.emit('onCodexState', readyCodexState());
        await settle(harness);
        expect(harness.query<HTMLButtonElement>('#codex-launch-new').disabled).toBe(false);
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledOnce();
      },
    );
  });
});
