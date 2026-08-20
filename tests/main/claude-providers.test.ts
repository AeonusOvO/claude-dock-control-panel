import { describe, expect, it } from 'vitest';
import { MODEL_NAME_PATTERN } from '../../src/main/claude/configuration';
import {
  CLAUDE_PROVIDER_GROUPS,
  CLAUDE_PROVIDERS,
  collapsedClaudeProviderGroups,
  findClaudeProvider,
  officialNetworkProviderForClaudePreset,
  providerForPreset,
} from '../../src/shared/claude/providers';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

describe('Claude provider catalog', () => {
  it('matches the current official DeepSeek Claude Code integration variables', () => {
    const provider = CLAUDE_PROVIDERS.find(({ id }) => id === 'deepseek');
    expect(provider).toMatchObject({
      authMode: 'authToken',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro[1m]',
      modelFast: 'deepseek-v4-flash',
    });
  });

  it('keeps identifiers unique and every entry in a declared group', () => {
    expect(new Set(CLAUDE_PROVIDERS.map((provider) => provider.id)).size).toBe(
      CLAUDE_PROVIDERS.length,
    );
    const groupIds = new Set(CLAUDE_PROVIDER_GROUPS.map((group) => group.id));
    expect(CLAUDE_PROVIDERS.every((provider) => groupIds.has(provider.group))).toBe(true);
  });

  it('tracks the current official Claude Code integration presets', () => {
    expect(findClaudeProvider('anthropic-api')).toMatchObject({
      authMode: 'apiKey',
      model: 'claude-sonnet-5',
      modelFast: 'claude-haiku-4-5',
    });
    expect(findClaudeProvider('glm-cn')).toMatchObject({
      authMode: 'authToken',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.2[1m]',
    });
    expect(findClaudeProvider('glm-global')).toMatchObject({
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'glm-5.2',
    });
    expect(findClaudeProvider('kimi-code')).toMatchObject({
      authMode: 'apiKey',
      baseUrl: 'https://api.kimi.com/coding',
      model: 'kimi-for-coding',
    });
    expect(findClaudeProvider('qwen-global')).toMatchObject({
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
      model: 'qwen3.7-plus',
    });
    for (const providerId of ['minimax-cn', 'minimax-global']) {
      expect(findClaudeProvider(providerId)).toMatchObject({
        authMode: 'authToken',
        model: 'MiniMax-M3[1m]',
      });
    }
  });

  it('keeps the managed ChatGPT subscription route local and separate from official access', () => {
    expect(findClaudeProvider('chatgpt-subscription')).toMatchObject({
      authMode: 'authToken',
      baseUrl: 'http://127.0.0.1:8317',
      editableBaseUrl: false,
      group: 'subscription',
      label: 'ChatGPT 订阅（ClaudeDock 托管）',
      model: 'gpt-5.6-sol',
      modelFast: 'gpt-5.4-mini',
    });
    expect(findClaudeProvider('chatgpt-subscription')?.caveat).toContain('OpenAI Codex 负责人');
    expect(findClaudeProvider('chatgpt-subscription')?.caveat).toContain('第三方开源网关');
    expect(findClaudeProvider('chatgpt-subscription')?.consoleUrl).toContain('thsottiaux/status');
    expect(providerForPreset('chatgpt-subscription')).toBe('gateway');
    expect(collapsedClaudeProviderGroups('chatgpt-subscription')).not.toContain('subscription');
  });

  it('maps only official and subscription presets to their matching official profiles', () => {
    expect(officialNetworkProviderForClaudePreset('anthropic')).toBe('anthropic-claude');
    expect(officialNetworkProviderForClaudePreset('anthropic-api')).toBe('anthropic-claude');
    expect(officialNetworkProviderForClaudePreset('chatgpt-subscription')).toBe('openai-codex');
    for (const provider of CLAUDE_PROVIDERS.filter(
      ({ group }) => !['official', 'subscription'].includes(group),
    )) {
      expect(officialNetworkProviderForClaudePreset(provider.id)).toBeUndefined();
    }
  });

  it('only permits HTTPS remote endpoints and explicit loopback HTTP endpoints', () => {
    for (const provider of CLAUDE_PROVIDERS) {
      if (!provider.baseUrl) {
        expect(providerForPreset(provider.id)).toBe('anthropic');
        continue;
      }
      const parsed = new URL(provider.baseUrl);
      expect(
        parsed.protocol === 'https:' ||
          (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())),
      ).toBe(true);
      expect(parsed.username).toBe('');
      expect(parsed.password).toBe('');
    }
  });

  it('uses valid main and fast model identifiers', () => {
    for (const provider of CLAUDE_PROVIDERS) {
      expect(MODEL_NAME_PATTERN.test(provider.model)).toBe(true);
      expect(MODEL_NAME_PATTERN.test(provider.modelFast ?? provider.model)).toBe(true);
    }
  });

  it('keeps provider-specific authentication caveats explicit', () => {
    expect(findClaudeProvider('siliconflow')).toMatchObject({ authMode: 'apiKey' });
    expect(findClaudeProvider('kimi-open')?.caveat).toContain('Kimi Code');
    expect(findClaudeProvider('kimi-code')?.caveat).toContain('互不通用');
    expect(findClaudeProvider('ollama')).toMatchObject({
      authMode: 'authToken',
      baseUrl: 'http://localhost:11434',
    });
  });

  it('exposes only parseable HTTPS help and console links', () => {
    for (const provider of CLAUDE_PROVIDERS) {
      for (const link of [provider.consoleUrl, provider.docsUrl]) {
        if (link) {
          expect(new URL(link).protocol).toBe('https:');
        }
      }
    }
  });

  it('opens only the group containing the last provider selection', () => {
    expect(collapsedClaudeProviderGroups('anthropic')).not.toContain('official');
    expect(collapsedClaudeProviderGroups('chatgpt-subscription')).not.toContain('subscription');
    expect(collapsedClaudeProviderGroups('deepseek')).not.toContain('domestic');
    expect(collapsedClaudeProviderGroups('custom')).not.toContain('advanced');
    expect(collapsedClaudeProviderGroups('custom')).toHaveLength(CLAUDE_PROVIDER_GROUPS.length - 1);
  });

  it('keeps every provider group folded until an unknown selection is resolved', () => {
    expect(collapsedClaudeProviderGroups(undefined)).toEqual(
      CLAUDE_PROVIDER_GROUPS.map((group) => group.id),
    );
  });
});
