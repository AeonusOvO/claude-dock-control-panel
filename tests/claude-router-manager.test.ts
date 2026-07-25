import { describe, expect, it } from 'vitest';
import type { SaveClaudeRouterProviderInput } from '../src/shared/contracts';
import {
  buildDeletedRouterConfig,
  buildUpdatedRouterConfig,
  normalizeRouterProviderInput,
  parseRouterInstallerRelease,
  routerCliStartSpec,
  routerGatewayErrorMessage,
  routerNativeModuleErrorMessage,
  routerServiceRunsInAppRuntime,
  sanitizeRouterConfig,
  tasklistImageNames,
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

  it('recognizes and migrates a legacy preferred Provider ID to its current name', () => {
    const legacyConfig = {
      ...baseConfig,
      Providers: [
        {
          ...(baseConfig.Providers[0] as Record<string, unknown>),
          id: 'legacy-provider-id',
          name: 'renamed-provider',
        },
      ],
      preferredProvider: 'legacy-provider-id',
    };

    expect(sanitizeRouterConfig(legacyConfig)[0]?.preferred).toBe(true);
    const updated = buildUpdatedRouterConfig(legacyConfig, {
      ...providerInput,
      apiKey: undefined,
      credentialAction: 'keep',
      id: 'legacy-provider-id',
      name: 'renamed-provider',
    });
    expect(updated.config.preferredProvider).toBe('renamed-provider');
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

  it('turns an empty Router startup error into a Chinese actionable solution', () => {
    const message = routerGatewayErrorMessage(
      0,
      'No available models. Configure at least one provider with a model.',
    );

    expect(message).toContain('还没有配置 Provider 和模型');
    expect(message).toContain('解决办法');
    expect(message).not.toContain('No available models');
  });

  it('launches the CCR CLI with its compatible system Node instead of Electron', () => {
    expect(
      routerCliStartSpec(
        'D:\\Program Files\\nodejs\\node.exe',
        'D:\\ClaudeCode\\node_modules\\@musistudio\\claude-code-router\\dist\\main\\cli.js',
      ),
    ).toEqual({
      args: [
        'D:\\ClaudeCode\\node_modules\\@musistudio\\claude-code-router\\dist\\main\\cli.js',
        'start',
        '--no-open',
        '--gateway',
      ],
      executable: 'D:\\Program Files\\nodejs\\node.exe',
    });
  });

  it('turns a better-sqlite3 ABI mismatch into a safe repair instruction', () => {
    const message = routerNativeModuleErrorMessage(
      new Error(
        "The module 'D:\\ClaudeCode\\better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 148.",
      ),
    );

    expect(message).toContain('原生模块 ABI 137');
    expect(message).toContain('当前运行时 ABI 148');
    expect(message).toContain('修复运行环境并重启');
    expect(message).toContain('不会修改 Provider 或 Codex');
    expect(message).not.toContain('D:\\ClaudeCode');
  });

  it('detects a CCR daemon incorrectly hosted by the ClaudeDock Electron executable', () => {
    expect(
      routerServiceRunsInAppRuntime(
        'ClaudeDock 控制面板.exe',
        'D:\\Program Files\\claude-dock-control-panel\\ClaudeDock 控制面板.exe',
      ),
    ).toBe(true);
    expect(
      routerServiceRunsInAppRuntime(
        'node.exe',
        'D:\\Program Files\\claude-dock-control-panel\\ClaudeDock 控制面板.exe',
      ),
    ).toBe(false);
    expect(routerServiceRunsInAppRuntime('node.exe', 'D:\\Program Files\\nodejs\\node.exe')).toBe(
      false,
    );
  });

  it('decodes a Chinese tasklist image name from the Windows GB18030 code page', () => {
    const tasklistBytes = Buffer.from(
      '22436c61756465446f636b20bfd8d6c6c3e6b0e52e657865222c2231323334222c22436f6e736f6c65222c2231222c22312c303030204b22',
      'hex',
    );

    expect(tasklistImageNames(tasklistBytes)).toContain('ClaudeDock 控制面板.exe');
  });
});
