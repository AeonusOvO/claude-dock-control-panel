import { describe, expect, it } from 'vitest';
import {
  getProviderProfile,
  PROVIDER_PROFILES,
  validateProviderProfile,
} from '../src/shared/provider-profiles';

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

  it('separates login, CLI, and WebSocket action requirements', () => {
    const profile = getProviderProfile('openai-codex');
    expect(
      profile.endpoints.find((endpoint) => endpoint.id === 'openai-auth')?.requiredFor,
    ).toContain('login');
    expect(profile.endpoints.find((endpoint) => endpoint.id === 'openai-codex-api')?.process).toBe(
      'cli',
    );
    expect(
      profile.endpoints.find((endpoint) => endpoint.kind === 'websocket')?.requiredFor,
    ).toEqual(['cloud-task']);
  });

  it('does not embed location or public-address intelligence policy', () => {
    for (const profile of Object.values(PROVIDER_PROFILES)) {
      expect(profile).not.toHaveProperty('supportedCountryCodes');
      expect(profile).not.toHaveProperty('regionCaveats');
      expect(profile.hardBlockRules).not.toContain('unsupported-region');
    }
  });
});
