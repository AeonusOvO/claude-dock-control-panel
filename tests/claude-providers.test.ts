import { describe, expect, it } from 'vitest';
import { MODEL_NAME_PATTERN } from '../src/main/claude-configuration';
import {
  CLAUDE_PROVIDER_GROUPS,
  CLAUDE_PROVIDERS,
  findClaudeProvider,
  providerForPreset,
} from '../src/shared/claude-providers';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

describe('Claude provider catalog', () => {
  it('keeps identifiers unique and every entry in a declared group', () => {
    expect(new Set(CLAUDE_PROVIDERS.map((provider) => provider.id)).size).toBe(
      CLAUDE_PROVIDERS.length,
    );
    const groupIds = new Set(CLAUDE_PROVIDER_GROUPS.map((group) => group.id));
    expect(CLAUDE_PROVIDERS.every((provider) => groupIds.has(provider.group))).toBe(true);
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
});
