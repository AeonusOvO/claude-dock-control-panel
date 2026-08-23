import { expect, it } from 'vitest';
import type {
  ManagedChatGptGatewayOperationResult,
  ManagedChatGptGatewayState,
} from '../../src/shared/contracts';
import { settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';

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
    },
  );
});
