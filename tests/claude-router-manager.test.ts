import { describe, expect, it } from 'vitest';
import type { SaveClaudeRouterProviderInput } from '../src/shared/contracts';
import {
  buildDeletedRouterConfig,
  buildUpdatedRouterConfig,
  normalizeRouterProviderInput,
  parseRouterInstallerRelease,
  sanitizeRouterConfig,
} from '../src/main/claude-router-manager';

const providerInput: SaveClaudeRouterProviderInput = {
  apiKey: 'sk-upstream-example',
  baseUrl: 'https://relay.example.com/v1/chat/completions',
  credentialAction: 'replace',
  makePreferred: true,
  models: ['claude-fable-5'],
  name: 'relay-example',
  protocol: 'openai_chat_completions',
  useForCurrentProject: true,
};

const baseConfig = {
  APIKEY: 'sk-ccr-local-example',
  APIKEYS: [
    {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'local',
      key: 'sk-ccr-local-example',
    },
  ],
  Providers: [
    {
      api_base_url: 'https://existing.example.com/v1/messages',
      api_key: 'sk-existing-example',
      id: 'existing',
      models: ['existing-model'],
      name: 'existing',
      type: 'anthropic_messages',
    },
  ],
  preferredProvider: 'existing',
  profile: {
    profiles: [
      {
        agent: 'codex',
        id: 'default-codex',
        model: 'keep-this-codex-model',
      },
    ],
  },
  proxy: {
    systemProxy: false,
  },
};

describe('Claude Code Router management', () => {
  it('validates a provider without accepting insecure remote endpoints', () => {
    expect(normalizeRouterProviderInput(providerInput)).toMatchObject({
      baseUrl: 'https://relay.example.com/v1/chat/completions',
      models: ['claude-fable-5'],
      name: 'relay-example',
    });
    expect(() =>
      normalizeRouterProviderInput({
        ...providerInput,
        baseUrl: 'http://relay.example.com/v1/chat/completions',
      }),
    ).toThrow('必须使用 HTTPS');
    expect(() =>
      normalizeRouterProviderInput({
        ...providerInput,
        name: '包含空格',
      }),
    ).toThrow('Provider 名称只能包含');
  });

  it('adds a provider while preserving Codex and proxy configuration byte-for-byte', () => {
    const updated = buildUpdatedRouterConfig(baseConfig, providerInput);

    expect(updated.config.profile).toEqual(baseConfig.profile);
    expect(updated.config.proxy).toEqual(baseConfig.proxy);
    expect(updated.config.preferredProvider).toBe('relay-example');
    expect(updated.config.Providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          api_base_url: 'https://relay.example.com/v1/chat/completions',
          api_key: 'sk-upstream-example',
          id: 'relay-example',
          models: ['claude-fable-5'],
          name: 'relay-example',
          type: 'openai_chat_completions',
        }),
      ]),
    );

    const view = sanitizeRouterConfig(updated.config);
    expect(view).toContainEqual(
      expect.objectContaining({
        credentialConfigured: true,
        name: 'relay-example',
        preferred: true,
      }),
    );
    expect(JSON.stringify(view)).not.toContain('sk-upstream-example');
    expect(JSON.stringify(view)).not.toContain('sk-ccr-local-example');
  });

  it('keeps an existing upstream key when editing without a replacement', () => {
    const updated = buildUpdatedRouterConfig(baseConfig, {
      ...providerInput,
      apiKey: undefined,
      baseUrl: 'https://new.example.com/v1/messages',
      credentialAction: 'keep',
      id: 'existing',
      name: 'existing',
      protocol: 'anthropic_messages',
    });
    const provider = (updated.config.Providers as Array<Record<string, unknown>>)[0];

    expect(provider).toMatchObject({
      api_base_url: 'https://new.example.com/v1/messages',
      api_key: 'sk-existing-example',
      id: 'existing',
    });
    expect(updated.config.profile).toEqual(baseConfig.profile);
  });

  it('deletes only the selected provider and leaves Codex configuration untouched', () => {
    const withSecond = buildUpdatedRouterConfig(baseConfig, providerInput).config;
    const deleted = buildDeletedRouterConfig(withSecond, 'existing');

    expect(sanitizeRouterConfig(deleted).map((provider) => provider.id)).toEqual(['relay-example']);
    expect(deleted.preferredProvider).toBe('relay-example');
    expect(deleted.profile).toEqual(baseConfig.profile);
  });

  it('accepts only the official Windows release asset with a GitHub SHA-256 digest', () => {
    const release = {
      assets: [
        {
          browser_download_url:
            'https://github.com/musistudio/claude-code-router/releases/download/v3.0.15/Claude-Code-Router_3.0.15.exe',
          digest: `sha256:${'a'.repeat(64)}`,
          name: 'Claude-Code-Router_3.0.15.exe',
          size: 101_072_836,
        },
      ],
      tag_name: 'v3.0.15',
    };

    expect(parseRouterInstallerRelease(release)).toEqual({
      digest: 'a'.repeat(64),
      downloadUrl:
        'https://github.com/musistudio/claude-code-router/releases/download/v3.0.15/Claude-Code-Router_3.0.15.exe',
      fileName: 'Claude-Code-Router_3.0.15.exe',
      size: 101_072_836,
      version: '3.0.15',
    });
    expect(() =>
      parseRouterInstallerRelease({
        ...release,
        assets: [{ ...release.assets[0], digest: undefined }],
      }),
    ).toThrow('未通过来源、版本、大小或 SHA-256');
  });
});
