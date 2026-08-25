import { describe, expect, it } from 'vitest';
import type { ClaudeConfigView } from '../../src/shared/contracts';
import {
  createCurrentConnectionSummary,
  redactConnectionEndpoint,
} from '../../src/renderer/features/connection/current-connection-summary';

const configView = (overrides: Partial<ClaudeConfigView> = {}): ClaudeConfigView => ({
  apiKeyHelperPolicy: 'prefer-claudedock',
  authMode: 'authToken',
  baseUrl: 'https://relay.example.test/v1',
  credentialConfigured: true,
  model: 'default',
  preset: 'custom',
  protocol: 'anthropic',
  provider: 'gateway',
  ...overrides,
});

describe('current connection summary', () => {
  it('uses an API relay name before its endpoint', () => {
    expect(createCurrentConnectionSummary(configView(), { connectionName: '团队中转站' })).toEqual({
      endpoint: 'https://relay.example.test/v1',
      kind: 'api',
      metadata: ['接口：https://relay.example.test/v1', 'API 凭据已配置'],
      name: '团队中转站',
    });
  });

  it('falls back to the user endpoint when a custom relay has no name', () => {
    expect(createCurrentConnectionSummary(configView())).toEqual({
      endpoint: 'https://relay.example.test/v1',
      kind: 'api',
      metadata: ['API 凭据已配置'],
      name: 'https://relay.example.test/v1',
    });
  });

  it('uses a known API provider name without losing its redacted endpoint', () => {
    expect(
      createCurrentConnectionSummary(
        configView({
          baseUrl: 'https://token@openrouter.ai/api?api_key=secret#private',
          model: '~anthropic/claude-sonnet-latest',
          preset: 'openrouter',
        }),
      ),
    ).toEqual({
      endpoint: 'https://openrouter.ai/api',
      kind: 'api',
      metadata: ['接口：https://openrouter.ai/api', 'API 凭据已配置'],
      name: 'OpenRouter',
    });
  });

  it('shows a domestic provider, selected model, and credential-safe API facts', () => {
    expect(
      createCurrentConnectionSummary(
        configView({
          baseUrl: 'http://local-user:local-pass@127.0.0.1:3456?token=private',
          model: 'converted-model',
          preset: 'deepseek',
          sourceAuthMode: 'authToken',
          sourceBaseUrl: 'https://api.deepseek.com/anthropic?key=private',
          sourceCredentialConfigured: true,
          sourceModel: 'deepseek-v4-pro[1m]',
        }),
      ),
    ).toEqual({
      endpoint: 'https://api.deepseek.com/anthropic',
      kind: 'domestic',
      metadata: [
        '模型：deepseek-v4-pro[1m]',
        'API 凭据已配置',
        '接口：https://api.deepseek.com/anthropic',
      ],
      name: 'DeepSeek',
    });
  });

  it.each([
    ['anthropic', 'Claude 官方订阅'],
    ['chatgpt-subscription', 'ChatGPT 官方订阅'],
  ] as const)('shows supplied account identity for %s', (preset, name) => {
    expect(
      createCurrentConnectionSummary(configView({ preset }), {
        accountIdentity: 'member@example.test',
      }),
    ).toEqual({
      accountIdentity: 'member@example.test',
      kind: 'official-subscription',
      metadata: ['账号：member@example.test'],
      name,
    });
  });

  it('states that account identity is unavailable instead of guessing it', () => {
    expect(
      createCurrentConnectionSummary(
        configView({
          authMode: 'existing',
          baseUrl: '',
          credentialConfigured: false,
          preset: 'anthropic',
          provider: 'anthropic',
        }),
      ),
    ).toEqual({
      kind: 'official-subscription',
      metadata: ['账号信息暂不可用'],
      name: 'Claude 官方订阅',
    });
  });

  it.each([
    [
      {
        accountIdentity: 'claude-member@example.test',
        available: true,
        checkedAt: 1,
        loggedIn: true,
      },
      '账号：claude-member@example.test',
    ],
    [{ authMethod: 'none', available: true, checkedAt: 1, loggedIn: false }, '未登录'],
    [
      { authMethod: 'claude.ai', available: true, checkedAt: 1, loggedIn: true },
      '登录方式：claude.ai',
    ],
    [{ available: false, checkedAt: 1, loggedIn: false }, '账号信息暂不可用'],
  ] as const)('renders safe Claude CLI auth state %#', (officialAuth, metadata) => {
    expect(
      createCurrentConnectionSummary(
        configView({
          authMode: 'existing',
          baseUrl: '',
          credentialConfigured: false,
          preset: 'anthropic',
          provider: 'anthropic',
        }),
        { officialAuth },
      ).metadata,
    ).toEqual([metadata]);
  });
});

describe('connection endpoint redaction', () => {
  it('removes credentials, query parameters, and fragments while preserving the route', () => {
    expect(
      redactConnectionEndpoint(' https://user:secret@relay.example.test/v1?q=token#private '),
    ).toBe('https://relay.example.test/v1');
  });

  it.each(['', 'not a URL', 'file:///C:/secret.txt', 'javascript:alert(1)'])(
    'does not echo an invalid or non-HTTP endpoint: %s',
    (endpoint) => {
      expect(redactConnectionEndpoint(endpoint)).toBeUndefined();
    },
  );
});
