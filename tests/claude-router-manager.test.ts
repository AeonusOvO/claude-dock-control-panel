import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SaveClaudeRouterProviderInput } from '../src/shared/contracts';
import {
  buildDeletedRouterConfig,
  buildUpdatedRouterConfig,
  normalizeRouterProviderInput,
  routerCliStartSpec,
  routerDataDirectory,
  routerGatewayErrorMessage,
  routerNativeModuleErrorMessage,
  routerServiceRunsInAppRuntime,
  sanitizeRouterConfig,
  tasklistImageNames,
  ROUTER_DATA_ENTRIES,
  ClaudeRouterManager,
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
  it('deduplicates installs and leaves a secret-free journal for automatic recovery', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-router-recovery-'));
    let rejectInstall!: (error: Error) => void;
    const pendingInstall = new Promise<string>((_resolve, reject) => {
      rejectInstall = reject;
    });
    const runCommand = vi.fn(() => pendingInstall);
    const progress: string[] = [];
    const manager = new ClaudeRouterManager(
      userDataPath,
      (event) => progress.push(`${event.operation}:${event.stage}`),
      () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890' }),
      runCommand,
    );
    try {
      const first = manager.installFromNpm('npm');
      const second = manager.installFromNpm('npm');
      await Promise.resolve();
      expect(runCommand).toHaveBeenCalledOnce();
      expect(runCommand).toHaveBeenCalledWith(
        'npm',
        expect.arrayContaining(['install', '--global']),
        expect.objectContaining({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } }),
      );

      rejectInstall(new Error('simulated power loss'));
      await expect(first).rejects.toThrow('simulated power loss');
      await expect(second).rejects.toThrow('simulated power loss');

      const journalPath = path.join(userDataPath, 'claude', 'router-operation.json');
      expect(existsSync(journalPath)).toBe(true);
      const journal = readFileSync(journalPath, 'utf8');
      expect(journal).toContain('"source": "npmmirror"');
      expect(journal).not.toMatch(/proxy|token|key|secret/i);
      expect(progress).toContain('install:error');

      const recoveryProgress: string[] = [];
      const recoveryCommand = vi.fn(() => Promise.reject(new Error('still offline')));
      const recoveredManager = new ClaudeRouterManager(
        userDataPath,
        (event) => recoveryProgress.push(`${event.operation}:${event.stage}`),
        () => ({}),
        recoveryCommand,
      );
      await expect(recoveredManager.recoverInterruptedInstall()).rejects.toThrow('still offline');
      expect(recoveryCommand).toHaveBeenCalledOnce();
      expect(recoveryProgress).toContain('recover:recovering');
      expect(recoveryProgress).toContain('recover:error');
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

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
    ).toThrow('服务提供方名称只能包含');
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

  it('clears an existing upstream key for a no-auth relay', () => {
    const updated = buildUpdatedRouterConfig(baseConfig, {
      ...providerInput,
      apiKey: undefined,
      credentialAction: 'clear',
      id: 'existing',
      name: 'existing',
    });
    const provider = (updated.config.Providers as Array<Record<string, unknown>>)[0];

    expect(provider).not.toHaveProperty('api_key');
    expect(sanitizeRouterConfig(updated.config)[0]?.credentialConfigured).toBe(false);
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

  it('turns an empty Router startup error into a Chinese actionable solution', () => {
    const message = routerGatewayErrorMessage(
      0,
      'No available models. Configure at least one provider with a model.',
    );

    expect(message).toContain('还没有配置服务提供方和模型');
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
    expect(message).toContain('不会修改服务提供方或 Codex');
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

  it('only ever resolves the purge target to the CCR directory inside AppData', () => {
    expect(routerDataDirectory('C:\\Users\\tester\\AppData\\Roaming')).toBe(
      'C:\\Users\\tester\\AppData\\Roaming\\claude-code-router',
    );
    // A tampered APPDATA must not be able to widen the recursive delete.
    expect(routerDataDirectory('')).toBeUndefined();
    expect(routerDataDirectory('AppData\\Roaming')).toBeUndefined();
    expect(routerDataDirectory('C:\\Users\\tester\\AppData\\Roaming\\..')).toBe(
      'C:\\Users\\tester\\AppData\\claude-code-router',
    );
  });

  it('lists the CCR data files that a thorough uninstall removes', () => {
    expect(ROUTER_DATA_ENTRIES).toContain('config.sqlite');
    expect(ROUTER_DATA_ENTRIES).toContain('api-keys.sqlite');
    expect(ROUTER_DATA_ENTRIES).toContain('service.json');
    expect(ROUTER_DATA_ENTRIES).toContain('gateway.config.json');
    // Claude Code's and Codex's own configuration lives elsewhere and is never touched.
    expect(ROUTER_DATA_ENTRIES.some((entry) => entry.includes('claude.json'))).toBe(false);
  });
});
