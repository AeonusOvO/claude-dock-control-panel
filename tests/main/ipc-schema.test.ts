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
    expect(
      parseIpcRequestArgs(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP, [undefined, false]),
    ).toEqual([undefined, false]);
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
    expect(validateHistoryEntryId('history-a1-b2')).toBe('history-a1-b2');
    expect(validateModelOptionId('history:current')).toBe('history:current');
  });

  it('preserves native submit passthrough fields and legacy numeric acceptance', () => {
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
    expect(validateNetworkProvider('openai-codex')).toBe('openai-codex');
    expect(validateNetworkPreflightAction('provider-switch')).toBe('provider-switch');
    expect(validateClaudeLaunchMode('resume')).toBe('resume');
    expect(validateCodexLoginMethod('device-code')).toBe('device-code');
    expect(validateClaudeEffortRequest('ultracode')).toBe('ultracode');
    expect(validateClaudePermissionMode('dontAsk')).toBe('dontAsk');
    expect(validateModelSpeedMode('fast')).toBe('fast');
    expect(() => validateNetworkProvider('unknown')).toThrow('网络预检服务商标识无效。');
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

  it('strips and resolves MCP install and remove inputs', () => {
    expect(
      validateMcpInstallInput({
        catalogId: '',
        cwd: 'relative/project',
        extensionField: true,
        scope: 'project',
      }),
    ).toEqual({
      catalogId: '',
      cwd: path.resolve('relative/project'),
      scope: 'project',
    });
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

  it('strips unknown model-discovery fields and preserves empty base URLs', () => {
    expect(
      validateProviderModelDiscoveryInput({
        baseUrl: '',
        credential: 'secret',
        extensionField: true,
      }),
    ).toEqual({ baseUrl: '', credential: 'secret' });
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
