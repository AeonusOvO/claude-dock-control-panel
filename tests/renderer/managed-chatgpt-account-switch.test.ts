import { expect, it } from 'vitest';
import type {
  ManagedChatGptGatewayOperationResult,
  ManagedChatGptGatewayState,
} from '../../src/shared/contracts';
import {
  change,
  settle,
  withRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import { claudeProjectState } from '../helpers/renderer-terminal-fixture';

const readyState = (): ManagedChatGptGatewayState => ({
  accountEmail: 'current@example.test',
  authenticated: true,
  availableModels: ['gpt-5.6-sol'],
  busy: false,
  checkedAt: 1,
  endpoint: 'http://127.0.0.1:8317',
  installed: true,
  managementAvailable: true,
  message: '安装与授权已就绪。',
  phase: 'ready',
  running: true,
  usageStatisticsEnabled: false,
});

const nextChatGptConnection = (model = 'gpt-5.6-sol') => ({
  config: {
    ...claudeProjectState().config,
    authMode: 'authToken' as const,
    baseUrl: 'http://127.0.0.1:8317',
    credentialConfigured: true,
    model,
    preset: 'chatgpt-subscription' as const,
    provider: 'gateway' as const,
  },
});

it('enables projectless model selection and recommends GPT-5.6 over a leading GPT-4o', async () => {
  await withRenderer(
    {
      getManagedChatGptGatewayState: async () => ({
        ...readyState(),
        availableModels: ['gpt-4o', 'gpt-5.6-sol', 'gpt-5.4'],
      }),
      getNextClaudeConnection: async () => ({}),
    },
    async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.click('[data-provider-id="chatgpt-subscription"]');
      await settle(harness);

      const select = harness.query<HTMLSelectElement>('.subscription-gateway-model select');
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('gpt-5.6-sol');
    },
  );
});

it('restores the saved model when a projectless model switch fails', async () => {
  const state = {
    ...readyState(),
    availableModels: ['gpt-4o', 'gpt-5.6-sol', 'gpt-5.4'],
  };
  await withRenderer(
    {
      getManagedChatGptGatewayState: async () => state,
      getNextClaudeConnection: async () => nextChatGptConnection(),
      setManagedChatGptGatewayModel: async () => ({
        error: '模型测试失败。',
        message: '模型测试失败。',
        nextConnection: nextChatGptConnection(),
        ok: false,
        state,
      }),
    },
    async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.click('[data-provider-id="chatgpt-subscription"]');
      await settle(harness);
      const select = harness.query<HTMLSelectElement>('.subscription-gateway-model select');

      change(select, 'gpt-5.4');
      await settle(harness);

      expect(harness.method('setManagedChatGptGatewayModel')).toHaveBeenCalledWith(
        undefined,
        'gpt-5.4',
      );
      expect(select.value).toBe('gpt-5.6-sol');
      expect(harness.query('#toast').textContent).toContain('模型测试失败');
    },
  );
});

it('logs out only the managed account when the red current-account button is clicked', async () => {
  const state = readyState();
  const loggedOutState: ManagedChatGptGatewayState = {
    ...state,
    accountEmail: undefined,
    authenticated: false,
    availableModels: [],
    managementAvailable: false,
    message: '已安装，等待 OpenAI 授权。',
    phase: 'login-required',
    running: false,
  };
  const result: ManagedChatGptGatewayOperationResult = {
    message: '已退出 ClaudeDock 托管的 OpenAI 账号。',
    ok: true,
    state: loggedOutState,
  };
  let currentState = state;
  await withTerminalRenderer(
    {
      getManagedChatGptGatewayState: async () => currentState,
      getNextClaudeConnection: async () => ({
        ...nextChatGptConnection(),
        accountIdentity: 'current@example.test',
      }),
      logoutManagedChatGptGateway: async () => {
        currentState = loggedOutState;
        return result;
      },
    },
    async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      await settle(harness);
      harness.click('[data-provider-id="chatgpt-subscription"]');
      await settle(harness);
      expect(harness.query('.subscription-gateway-account').textContent).toContain(
        'current@example.test',
      );

      harness.clearCalls();
      harness.click('.subscription-gateway-actions .button--danger');
      await settle(harness);

      expect(harness.method('logoutManagedChatGptGateway')).toHaveBeenCalledOnce();
      expect(harness.method('setupManagedChatGptGateway')).not.toHaveBeenCalled();
      expect(harness.query('.subscription-gateway-status strong').textContent).toContain(
        '等待 OpenAI 授权',
      );
      expect(harness.query('#current-connection-metadata').textContent).not.toContain(
        'current@example.test',
      );
      harness.emit('onClaudeState', claudeProjectState({ active: true, ptyGeneration: 2 }));
      await settle(harness);
      expect(harness.query('#current-connection-metadata').textContent).not.toContain(
        'current@example.test',
      );
    },
  );
});
