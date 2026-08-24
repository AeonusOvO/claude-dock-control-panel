import { describe, expect, it } from 'vitest';
import {
  getProviderProfile,
  PROVIDER_PROFILES,
  validateProviderProfile,
} from '../../src/shared/router/provider-profiles';

describe('official provider profiles', () => {
  it('keeps HTTPS/WSS endpoints, source metadata, and two-minute caches schema-valid', () => {
    for (const profile of Object.values(PROVIDER_PROFILES)) {
      expect(() => validateProviderProfile(profile)).not.toThrow();
      expect(profile.cacheTtlMs).toBe(120_000);
      expect(profile.sources.every((source) => source.url.startsWith('https://'))).toBe(true);
    }
  });

  it('carries the Claude security baseline as structured policy data', () => {
    const profile = getProviderProfile('anthropic-claude');
    expect(profile.minimumSecureClientVersion).toBe('2.1.197');
    expect(profile.versionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          maximum: '2.1.162',
          severity: 'block',
        }),
      ]),
    );
  });

  it('keeps external-browser pages advisory while requiring exact CLI login authority', () => {
    const profile = getProviderProfile('openai-codex');
    expect(profile.endpoints.find((endpoint) => endpoint.id === 'openai-auth')).toMatchObject({
      process: 'application',
      requiredFor: [],
    });
    expect(
      profile.endpoints.find((endpoint) => endpoint.id === 'openai-chatgpt')?.requiredFor,
    ).toEqual([]);
    expect(profile.endpoints.find((endpoint) => endpoint.id === 'openai-codex-api')).toMatchObject({
      process: 'cli',
      requiredFor: expect.arrayContaining(['provider-switch', 'login']),
    });
    expect(
      profile.endpoints.find((endpoint) => endpoint.kind === 'websocket')?.requiredFor,
    ).toEqual(['cloud-task']);
  });

  it('covers ChatGPT, Claude and Grok in the independent manual suite', () => {
    const profile = getProviderProfile('ai-services');
    expect(profile.endpoints.map((endpoint) => endpoint.label)).toEqual(
      expect.arrayContaining([
        'ChatGPT',
        'OpenAI Codex',
        'Claude',
        'Claude API',
        'Grok',
        'xAI API',
      ]),
    );
    expect(profile.endpoints.every((endpoint) => endpoint.requiredFor.includes('background'))).toBe(
      true,
    );
  });

  it('uses xAI official authentication, API and Grok Build hosts', () => {
    const profile = getProviderProfile('xai-grok');
    expect(profile.requiredDomains).toEqual(
      expect.arrayContaining(['auth.x.ai', 'api.x.ai', 'cli-chat-proxy.grok.com', 'grok.com']),
    );
  });

  it('does not embed location or public-address intelligence policy', () => {
    for (const profile of Object.values(PROVIDER_PROFILES)) {
      expect(profile).not.toHaveProperty('supportedCountryCodes');
      expect(profile).not.toHaveProperty('regionCaveats');
      expect(profile.hardBlockRules).not.toContain('unsupported-region');
    }
  });
});
