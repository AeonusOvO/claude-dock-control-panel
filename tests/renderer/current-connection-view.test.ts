import { describe, expect, it } from 'vitest';
import type {
  ClaudeConnectionHistoryEntry,
  ManagedChatGptGatewayState,
} from '../../src/shared/contracts';
import {
  settle,
  withRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import { claudeProjectState } from '../helpers/renderer-terminal-fixture';

const managedChatGptState = (
  overrides: Partial<ManagedChatGptGatewayState> = {},
): ManagedChatGptGatewayState => ({
  authenticated: true,
  availableModels: ['gpt-5.6-sol'],
  busy: false,
  checkedAt: 1,
  endpoint: 'http://127.0.0.1:8317',
  installed: true,
  managementAvailable: true,
  message: '已就绪。',
  phase: 'ready',
  running: true,
  usageStatisticsEnabled: false,
  ...overrides,
});

describe('current connection view', () => {
  it('shows an empty next-conversation choice independently of open conversations', async () => {
    await withRenderer(
      {
        getManagedChatGptGatewayState: async () =>
          managedChatGptState({ accountEmail: 'member@example.test' }),
      },
      async (harness) => {
        await settle(harness);
        expect(harness.query('#current-connection-name').textContent).toBe('尚未选择接入');
        expect(harness.query('#current-connection-metadata').textContent).toContain(
          '下个新对话会立即捕获这套配置',
        );
      },
    );
  });

  it('uses the safe Claude CLI account projection for the official subscription', async () => {
    await withTerminalRenderer(
      {
        getNextClaudeConnection: async () => ({
          config: claudeProjectState().config,
          officialAuth: {
            accountIdentity: 'claude-member@example.test',
            authMethod: 'claude.ai',
            available: true,
            checkedAt: 1,
            loggedIn: true,
          },
        }),
        getClaudeProjectState: async () =>
          claudeProjectState({
            active: true,
            officialAuth: {
              accountIdentity: 'claude-member@example.test',
              authMethod: 'claude.ai',
              available: true,
              checkedAt: 1,
              loggedIn: true,
            },
            ptyGeneration: 1,
          }),
      },
      async (harness) => {
        await settle(harness);
        expect(harness.query('#current-connection-name').textContent).toBe('Claude 官方订阅');
        expect(harness.query('#current-connection-metadata').textContent).toContain(
          'claude-member@example.test',
        );
      },
    );
  });

  it('shows the verified ChatGPT account and ignores later active-conversation changes', async () => {
    const chatGptState = claudeProjectState({
      active: true,
      config: {
        ...claudeProjectState().config,
        authMode: 'authToken',
        baseUrl: 'http://127.0.0.1:8317',
        credentialConfigured: true,
        model: 'gpt-5.6-sol',
        preset: 'chatgpt-subscription',
        provider: 'gateway',
      },
      ptyGeneration: 1,
    });
    await withTerminalRenderer(
      {
        getClaudeProjectState: async () => chatGptState,
        getNextClaudeConnection: async () => ({ config: chatGptState.config }),
        getManagedChatGptGatewayState: async () =>
          managedChatGptState({ accountEmail: 'member@example.test' }),
      },
      async (harness) => {
        await settle(harness);
        expect(harness.query('#current-connection-name').textContent).toBe('ChatGPT 官方订阅');
        expect(harness.query('#current-connection-metadata').textContent).toContain(
          'member@example.test',
        );

        harness.emit(
          'onClaudeState',
          claudeProjectState({
            active: true,
            config: {
              ...chatGptState.config,
              baseUrl: 'https://user:secret@relay.example.test/anthropic?token=private#hidden',
              model: 'relay-model',
              preset: 'custom',
            },
            ptyGeneration: 1,
            stateRevision: 2,
          }),
        );
        await settle(harness);
        expect(harness.query('#current-connection-name').textContent).toBe('ChatGPT 官方订阅');
        expect(harness.query('#current-connection-metadata').textContent).not.toContain('secret');
        expect(harness.query('#current-connection-metadata').textContent).not.toContain('private');
      },
    );
  });

  it('does not let a tentative history selection rename the effective connection', async () => {
    const config = {
      ...claudeProjectState().config,
      authMode: 'authToken' as const,
      baseUrl: 'https://relay.example.test',
      credentialConfigured: true,
      model: 'relay-model',
      preset: 'custom' as const,
      provider: 'gateway' as const,
    };
    const entry = (id: string, name: string): ClaudeConnectionHistoryEntry => ({
      apiKeyHelperPolicy: 'inherit',
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      credentialConfigured: true,
      gatewayState: 'unknown',
      id,
      model: config.model,
      name,
      preset: config.preset,
      protocol: 'anthropic',
      provider: config.provider,
      savedAt: 1,
    });
    await withTerminalRenderer(
      {
        getClaudeConnectionHistory: async () => [
          entry('effective', '当前中转站'),
          entry('tentative', '只是待选择'),
        ],
        getNextClaudeConnection: async () => ({ config }),
        getClaudeProjectState: async () =>
          claudeProjectState({ active: true, config, ptyGeneration: 1 }),
      },
      async (harness) => {
        await settle(harness);
        expect(harness.query('#current-connection-name').textContent).toBe('当前中转站');

        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-api');
        harness.click(
          '[data-history-dialog-list="api"] [data-history-id="tentative"] .connection-history__restore',
        );
        await settle(harness);

        expect(harness.query('#connection-history-dialog-selection').textContent).toContain(
          '只是待选择',
        );
        expect(harness.query('#current-connection-name').textContent).toBe('当前中转站');
      },
    );
  });
});
