import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateClaudeConfigInput,
  validateClaudeEffortRequest,
  validateClaudeLaunchMode,
  validateClaudePermissionDecision,
  validateClaudePermissionMode,
  validateClaudeRelaunchInput,
  validateClaudeRouterProviderInput,
  validateCodexLoginMethod,
  validateConversationId,
  validateDevelopmentRuntime,
  validateDownloadRecoveryToken,
  validateDownloadTaskId,
  validateExternalUrl,
  validateHistoryEntryId,
  validateMarkdownExternalUrl,
  validateMcpInstallInput,
  validateMcpRemoveInput,
  validateModelOptionId,
  validateModelSpeedMode,
  validateNativeControlUpdate,
  validateNativeInteractionResponse,
  validateNativeSubmitInput,
  validateNetworkPreflightAction,
  validateNetworkProvider,
  validatePluginId,
  validateProjectPath,
  validateProviderModelDiscoveryInput,
  validatePtyGeneration,
  validateSessionId,
} from '../../src/main/ipc/validation';
import { CHANNELS, REQUEST_CHANNELS } from '../../src/shared/ipc/channels';
import { IPC_REQUESTS, parseIpcRequestArgs } from '../../src/shared/ipc/schema';

describe('shared IPC schemas', () => {
  it('covers every request channel with one typed definition', () => {
    expect(Object.keys(IPC_REQUESTS)).toEqual(REQUEST_CHANNELS);
    expect(new Set(Object.values(IPC_REQUESTS).map(({ method }) => method)).size).toBe(
      REQUEST_CHANNELS.length,
    );
  });

  it('parses positional tuples without collapsing explicit undefined values', () => {
    expect(parseIpcRequestArgs(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, [undefined])).toEqual(
      [undefined],
    );
    expect(() =>
      parseIpcRequestArgs(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, [false]),
    ).toThrow();
  });

  it('keeps identifier boundaries and normalization compatible', () => {
    expect(validateSessionId('session-123')).toBe('session-123');
    expect(() => validateSessionId('session-a')).toThrow('项目会话标识无效。');
    expect(validatePtyGeneration(0)).toBe(0);
    expect(() => validatePtyGeneration(-1)).toThrow('终端代次无效。');
    expect(validateConversationId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(validateDownloadTaskId('download:item-1')).toBe('download:item-1');
    expect(validateDownloadRecoveryToken('00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(() => validateDownloadRecoveryToken('stale-token')).toThrow('下载恢复标识无效。');
    expect(validateHistoryEntryId('history-a1-b2')).toBe('history-a1-b2');
    expect(validateModelOptionId('history:current')).toBe('history:current');
  });

  it('requires recovery decisions to carry the task-bound token', () => {
    const token = '00000000-0000-4000-8000-000000000001';
    expect(
      parseIpcRequestArgs(CHANNELS.DOWNLOAD_RECOVERY_RESUME, ['download:item-1', token]),
    ).toEqual(['download:item-1', token]);
    expect(() =>
      parseIpcRequestArgs(CHANNELS.DOWNLOAD_RECOVERY_RESUME, ['download:item-1']),
    ).toThrow();
    expect(() =>
      parseIpcRequestArgs(CHANNELS.DOWNLOAD_RECOVERY_DISCARD, ['download:item-1', 'stale-token']),
    ).toThrow();
  });

  it('preserves native submit extensions while rejecting renderer authority fields', () => {
    const input = {
      blocks: [
        {
          attachment: {
            id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
            mediaType: 'image/png',
            name: 'image.png',
            size: Number.NaN,
          },
          type: 'image' as const,
        },
      ],
      clientSubmissionId: 'submission-1',
      extensionField: true,
    };
    expect(validateNativeSubmitInput(input)).toBe(input);
    for (const authorityField of [
      'action',
      'cwd',
      'networkScope',
      'officialNetworkProvider',
      'officialNetworkTarget',
      'projectPath',
      'provider',
      'target',
    ]) {
      expect(() =>
        validateNativeSubmitInput({ ...input, [authorityField]: 'renderer-owned' }),
      ).toThrow('原生对话输入包含未授权字段。');
    }
  });

  it('checks serialized native interaction size before accepting the action', () => {
    const response = { action: 'allow' as const, extensionField: true };
    expect(validateNativeInteractionResponse(response)).toBe(response);
    expect(() =>
      validateNativeInteractionResponse({ action: 'allow', message: '汉'.repeat(90_000) }),
    ).toThrow('原生交互响应过大。');
    expect(() => validateNativeInteractionResponse({ action: 'other' })).toThrow(
      '原生交互响应动作无效。',
    );
  });

  it('preserves native control passthrough while validating bounded controls', () => {
    const update = {
      expectedCapabilityRevision: 0,
      extensionField: 'kept',
      fast: true,
      permissionMode: 'plan',
    };
    expect(validateNativeControlUpdate(update)).toBe(update);
    expect(() => validateNativeControlUpdate({ expectedCapabilityRevision: -1 })).toThrow(
      '模型控制参数无效。',
    );
  });

  it('validates the runtime, network, launch, login, effort, permission and speed enums', () => {
    expect(validateDevelopmentRuntime('claude')).toBe('claude');
    expect(validateNetworkProvider('ai-services')).toBe('ai-services');
    expect(validateNetworkProvider('openai-codex')).toBe('openai-codex');
    expect(validateNetworkProvider('xai-grok')).toBe('xai-grok');
    expect(validateNetworkPreflightAction('provider-switch')).toBe('provider-switch');
    expect(validateClaudeLaunchMode('resume')).toBe('resume');
    expect(validateCodexLoginMethod('device-code')).toBe('device-code');
    expect(validateClaudeEffortRequest('ultracode')).toBe('ultracode');
    expect(validateClaudePermissionMode('dontAsk')).toBe('dontAsk');
    expect(validateModelSpeedMode('fast')).toBe('fast');
    expect(() => validateNetworkProvider('unknown')).toThrow('网络预检服务商标识无效。');
  });

  it('accepts only renderer-owned network preflight fields', () => {
    expect(
      parseIpcRequestArgs(CHANNELS.NETWORK_PREFLIGHT_RUN, [
        {
          action: 'first-request',
          cwd: 'relative/project',
          force: true,
          networkScope: 'conversation',
          provider: 'openai-codex',
        },
      ]),
    ).toEqual([
      {
        action: 'first-request',
        cwd: 'relative/project',
        force: true,
        networkScope: 'conversation',
        provider: 'openai-codex',
      },
    ]);
    for (const authorityField of [
      'canonicalCwd',
      'configurationRevision',
      'generation',
      'mainRunId',
    ]) {
      expect(() =>
        parseIpcRequestArgs(CHANNELS.NETWORK_PREFLIGHT_RUN, [
          {
            action: 'background',
            [authorityField]: authorityField === 'canonicalCwd' ? 'D:\\Injected' : 1,
            provider: 'openai-api',
          },
        ]),
      ).toThrow();
    }
  });

  it('strips unknown relaunch fields and preserves optional keys', () => {
    expect(
      validateClaudeRelaunchInput({
        compactFirst: true,
        entryId: 'history-a-b',
        extensionField: true,
        permissionMode: 'plan',
      }),
    ).toEqual({
      compactFirst: true,
      entryId: 'history-a-b',
      permissionMode: 'plan',
    });
  });

  it('strips unknown Claude connection fields without trimming accepted strings', () => {
    expect(
      validateClaudeConfigInput({
        authMode: 'apiKey',
        baseUrl: '',
        credentialAction: 'keep',
        extensionField: true,
        model: '',
        preset: 'anthropic',
        provider: 'anthropic',
      }),
    ).toEqual({
      apiKeyHelperPolicy: undefined,
      authMode: 'apiKey',
      baseUrl: '',
      credential: undefined,
      credentialAction: 'keep',
      model: '',
      modelFast: undefined,
      preset: 'anthropic',
      protocol: undefined,
      provider: 'anthropic',
      routerProviderId: undefined,
    });
  });

  it('strips unknown router-provider fields while retaining empty strings and arrays', () => {
    expect(
      validateClaudeRouterProviderInput({
        baseUrl: '',
        credentialAction: 'keep',
        extensionField: true,
        makePreferred: false,
        models: [],
        name: '',
        protocol: 'anthropic_messages',
        useForCurrentProject: false,
      }),
    ).toEqual({
      apiKey: undefined,
      baseUrl: '',
      credentialAction: 'keep',
      id: undefined,
      makePreferred: false,
      models: [],
      name: '',
      protocol: 'anthropic_messages',
      useForCurrentProject: false,
    });
  });

  it('keeps URL authorization and canonicalization in the main process', () => {
    expect(validateExternalUrl('https://github.com/anthropics/claude-code')).toBe(
      'https://github.com/anthropics/claude-code',
    );
    expect(validateExternalUrl('http://localhost:3458/management')).toBe(
      'http://localhost:3458/management',
    );
    expect(() => validateExternalUrl('https://example.com/')).toThrow(
      '该链接不在 ClaudeDock 允许打开的帮助或本机管理地址中。',
    );
    expect(validateMarkdownExternalUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
    expect(() => validateMarkdownExternalUrl('file:///tmp/a')).toThrow(
      '只允许打开 HTTP、HTTPS 或邮件链接。',
    );
  });

  it('validates plugin identifiers without importing the plugin manager', () => {
    expect(validatePluginId('plugin-name@marketplace')).toBe('plugin-name@marketplace');
    expect(() => validatePluginId('../plugin')).toThrow('插件标识无效。');
  });

  it('resolves project paths only in the main-process adapter', () => {
    expect(validateProjectPath('relative/project')).toBe(path.resolve('relative/project'));
    expect(() => validateProjectPath('   ')).toThrow('项目路径格式无效。');
  });

  it('accepts only renderer-owned MCP install fields and resolves the project path', () => {
    expect(
      validateMcpInstallInput({
        catalogId: 'curated:filesystem',
        cwd: 'relative/project',
        scope: 'project',
      }),
    ).toEqual({
      catalogId: 'curated:filesystem',
      cwd: path.resolve('relative/project'),
      scope: 'project',
    });
    for (const authority of [
      { executable: 'powershell.exe' },
      { args: ['--yes', 'untrusted-package'] },
      { config: { command: 'untrusted' } },
      { url: 'https://renderer-controlled.invalid/mcp' },
      { '--yes': true },
    ]) {
      expect(() =>
        validateMcpInstallInput({
          ...authority,
          catalogId: 'curated:filesystem',
          cwd: 'relative/project',
          scope: 'project',
        }),
      ).toThrow('MCP 安装参数包含未授权字段。');
    }

    expect(
      validateMcpRemoveInput({
        cwd: 'relative/project',
        extensionField: true,
        name: 'server-name',
        scope: 'local',
      }),
    ).toEqual({
      cwd: path.resolve('relative/project'),
      name: 'server-name',
      scope: 'local',
    });
  });

  it('accepts only the three Claude execution-settings request modes', () => {
    const custom = {
      mode: 'custom' as const,
      values: {
        concurrentSubagents: 128,
        spawnDepth: 16,
        toolSearch: 'auto:100' as const,
        toolUseConcurrency: 128,
      },
    };
    expect(parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_GET, [])).toEqual([]);
    expect(
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [{ mode: 'claude-default' }]),
    ).toEqual([{ mode: 'claude-default' }]);
    expect(
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
        { mode: 'profile', profileId: 'best-performance' },
      ]),
    ).toEqual([{ mode: 'profile', profileId: 'best-performance' }]);
    expect(parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [custom])).toEqual([
      custom,
    ]);
  });

  it('rejects renderer-supplied Claude execution authority and arbitrary fields', () => {
    for (const authorityField of [
      'benchmark',
      'credentials',
      'endpoint',
      'environment',
      'evidence',
      'installation',
      'machine',
      'operations',
      'route',
    ]) {
      expect(() =>
        parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
          {
            [authorityField]: 'renderer-controlled',
            mode: 'profile',
            profileId: 'balanced',
          },
        ]),
      ).toThrow();
    }
    expect(() =>
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
        { arbitrary: true, mode: 'claude-default' },
      ]),
    ).toThrow();
    expect(() =>
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
        {
          mode: 'custom',
          values: {
            concurrentSubagents: 8,
            environment: { ENABLE_TOOL_SEARCH: 'true' },
            spawnDepth: 2,
            toolSearch: true,
            toolUseConcurrency: 8,
          },
        },
      ]),
    ).toThrow();
  });

  it('enforces Claude execution profile, numeric, and tool-search boundaries', () => {
    const values = {
      concurrentSubagents: 8,
      spawnDepth: 2,
      toolSearch: 'auto' as const,
      toolUseConcurrency: 8,
    };
    for (const profileId of [
      'balanced',
      'best-performance',
      'high-throughput',
      'restrained',
      'token-saver',
    ]) {
      expect(
        parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
          { mode: 'profile', profileId },
        ]),
      ).toEqual([{ mode: 'profile', profileId }]);
    }
    expect(() =>
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
        { mode: 'profile', profileId: 'renderer-profile' },
      ]),
    ).toThrow();

    for (const patch of [
      { concurrentSubagents: 0 },
      { concurrentSubagents: 129 },
      { concurrentSubagents: 1.5 },
      { concurrentSubagents: Number.MAX_SAFE_INTEGER + 1 },
      { spawnDepth: 0 },
      { spawnDepth: 17 },
      { toolUseConcurrency: Number.NaN },
      { toolUseConcurrency: Number.POSITIVE_INFINITY },
    ]) {
      expect(() =>
        parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
          { mode: 'custom', values: { ...values, ...patch } },
        ]),
      ).toThrow();
    }

    for (const toolSearch of [true, false, 'inherit', 'auto', 'auto:0', 'auto:100']) {
      expect(
        parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
          { mode: 'custom', values: { ...values, toolSearch } },
        ])[0],
      ).toMatchObject({ mode: 'custom', values: { toolSearch } });
    }
    for (const toolSearch of ['auto:00', 'auto:01', 'auto:101', 'auto:-1', 'true', 'AUTO:1']) {
      expect(() =>
        parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
          { mode: 'custom', values: { ...values, toolSearch } },
        ]),
      ).toThrow();
    }
  });

  it('rejects extra positional arguments for Claude execution settings operations', () => {
    for (const channel of [
      CHANNELS.CLAUDE_EXECUTION_SETTINGS_GET,
      CHANNELS.CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED,
      CHANNELS.CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT,
    ] as const) {
      expect(() => parseIpcRequestArgs(channel, ['unexpected'])).toThrow();
    }
    expect(() =>
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, [
        { mode: 'claude-default' },
        'unexpected',
      ]),
    ).toThrow();
  });

  it('accepts only renderer-owned model-discovery fields', () => {
    expect(
      validateProviderModelDiscoveryInput({
        baseUrl: '',
        credential: 'secret',
      }),
    ).toEqual({ baseUrl: '', credential: 'secret' });

    for (const authorityField of [
      'action',
      'configurationRevision',
      'cwd',
      'endpoint',
      'mainRunId',
      'officialProvider',
      'projectPath',
      'provider',
      'runId',
      'target',
      'transport',
    ]) {
      expect(() =>
        validateProviderModelDiscoveryInput({
          baseUrl: 'https://api.anthropic.com',
          [authorityField]: 'renderer-controlled',
        }),
      ).toThrow('模型发现参数包含无效字段。');
    }
  });

  it('normalizes permission decisions exactly at the boundary', () => {
    expect(
      validateClaudePermissionDecision({ behavior: 'fallback', extensionField: true }),
    ).toEqual({ behavior: 'fallback' });
    expect(validateClaudePermissionDecision({ behavior: 'allow', suggestionId: '' })).toEqual({
      behavior: 'allow',
    });
    expect(
      validateClaudePermissionDecision({ behavior: 'deny', message: 'x'.repeat(400) }),
    ).toEqual({ behavior: 'deny', message: 'x'.repeat(300) });
  });
});
