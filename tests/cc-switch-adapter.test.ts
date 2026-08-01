import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCcSwitchProviderDeepLink,
  parseCcSwitchRelease,
} from '../src/main/cc-switch-adapter';

const adapterSource = readFileSync(
  new URL('../src/main/cc-switch-adapter.ts', import.meta.url),
  'utf8',
);

describe('CC Switch adapter', () => {
  it('accepts only the official digest-bearing Windows x64 MSI', () => {
    expect(
      parseCcSwitchRelease({
        assets: [
          {
            browser_download_url:
              'https://github.com/farion1231/cc-switch/releases/download/v3.19.1/CC-Switch-v3.19.1-Windows.msi',
            digest: `sha256:${'a'.repeat(64)}`,
            name: 'CC-Switch-v3.19.1-Windows.msi',
            size: 13_033_472,
          },
        ],
        tag_name: 'v3.19.1',
      }),
    ).toMatchObject({ version: '3.19.1', size: 13_033_472 });
    expect(() =>
      parseCcSwitchRelease({
        assets: [
          {
            browser_download_url: 'https://example.com/CC-Switch-v3.19.1-Windows.msi',
            digest: `sha256:${'a'.repeat(64)}`,
            name: 'CC-Switch-v3.19.1-Windows.msi',
            size: 13_033_472,
          },
        ],
        tag_name: 'v3.19.1',
      }),
    ).toThrow(/来源/);
  });

  it('exports a provider only through the documented ccswitch v1 deep link', () => {
    const deepLink = buildCcSwitchProviderDeepLink({
      authMode: 'apiKey',
      baseUrl: 'https://api.example.com/anthropic',
      credential: 'secret-test-key',
      model: 'example-model',
      modelFast: 'example-fast',
      name: 'Example',
    });
    const parsed = new URL(deepLink);
    expect(parsed.protocol).toBe('ccswitch:');
    expect(parsed.pathname).toBe('/import');
    expect(parsed.searchParams.get('resource')).toBe('provider');
    expect(parsed.searchParams.get('app')).toBe('claude');
    const config = JSON.parse(
      Buffer.from(parsed.searchParams.get('config') ?? '', 'base64').toString('utf8'),
    ) as { env: Record<string, string> };
    expect(config.env).toMatchObject({
      ANTHROPIC_API_KEY: 'secret-test-key',
      ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
      ANTHROPIC_MODEL: 'example-model',
    });
  });

  it('never opens or mutates the CC Switch database', () => {
    expect(adapterSource).not.toMatch(/sqlite|\.db\b|rusqlite/i);
    expect(adapterSource).toContain("new URL('ccswitch://v1/import')");
  });
});
