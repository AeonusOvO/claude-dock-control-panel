import { describe, expect, it, vi } from 'vitest';
import type { ClaudeConversationModelResolution } from '../../src/shared/contracts';
import {
  restoreLastConversationModelOnly,
  type StartupModelRestoreDependencies,
} from '../../src/main/app/startup-model-restore';

const modelResolution = (
  overrides: Partial<ClaudeConversationModelResolution> = {},
): ClaudeConversationModelResolution => ({
  conversation: {
    accountDetail: 'API 凭据已配置',
    authModeLabel: 'Bearer',
    credentialConfigured: true,
    mainModel: 'deepseek-v4-pro',
    networkPresentation: 'domestic',
    protocolLabel: 'Anthropic Messages',
    providerLabel: 'DeepSeek',
    smallModel: 'deepseek-v4-flash',
    source: 'bound',
  },
  current: {
    accountDetail: '订阅账户',
    authModeLabel: '现有登录',
    credentialConfigured: false,
    mainModel: 'claude-sonnet-5',
    networkPresentation: 'foreign',
    protocolLabel: 'Anthropic Messages',
    providerLabel: 'Anthropic',
    smallModel: 'claude-haiku-4-5',
    source: 'current',
  },
  differences: ['main-model', 'platform'],
  mismatch: true,
  preference: 'use-conversation',
  restorable: true,
  ...overrides,
});

const dependencies = (
  overrides: Partial<StartupModelRestoreDependencies> = {},
): StartupModelRestoreDependencies => ({
  allowExternalRoutingWrites: true,
  applyConversationModel: vi.fn(async () => undefined),
  clearNextConnection: vi.fn(),
  closeTemporarySession: vi.fn(),
  getLastActiveProject: vi.fn(() => 'D:\\Project'),
  getLatestConversation: vi.fn(() => ({
    conversationId: '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    modelId: 'deepseek-v4-pro',
  })),
  getPreferences: vi.fn(() => ({
    autoLoadLastConversationModelOnStartup: true,
    autoLoadLastConversationOnStartup: false,
    modelMismatchBehavior: 'ask' as const,
  })),
  inspectConversationModel: vi.fn(async () => modelResolution()),
  openTemporarySession: vi.fn(() => 'temporary-session'),
  projectExists: vi.fn(() => true),
  projectRuntime: vi.fn(() => 'claude' as const),
  restoreWorkspace: true,
  warn: vi.fn(),
  ...overrides,
});

describe('startup model-only restore', () => {
  it('uses a temporary transaction and always closes it after restoring the latest model', async () => {
    const events: string[] = [];
    const input = dependencies({
      applyConversationModel: vi.fn(async () => {
        events.push('apply');
      }),
      closeTemporarySession: vi.fn(() => events.push('close')),
      openTemporarySession: vi.fn(() => {
        events.push('open');
        return 'temporary-session';
      }),
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('restored');
    expect(events).toEqual(['open', 'apply', 'close']);
    expect(input.applyConversationModel).toHaveBeenCalledWith(
      'D:\\Project',
      expect.objectContaining({ modelId: 'deepseek-v4-pro' }),
      'temporary-session',
    );
  });

  it('restores the next-conversation choice even when conversation loading is also enabled', async () => {
    const input = dependencies({
      getPreferences: vi.fn(() => ({
        autoLoadLastConversationModelOnStartup: true,
        autoLoadLastConversationOnStartup: true,
        modelMismatchBehavior: 'ask' as const,
      })),
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('restored');
    expect(input.inspectConversationModel).toHaveBeenCalledOnce();
    expect(input.openTemporarySession).toHaveBeenCalledOnce();
  });

  it('clears the next-conversation connection when automatic model restore is disabled', async () => {
    const input = dependencies({
      getPreferences: vi.fn(() => ({
        autoLoadLastConversationModelOnStartup: false,
        autoLoadLastConversationOnStartup: false,
        modelMismatchBehavior: 'ask' as const,
      })),
      restoreWorkspace: false,
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('skipped');
    expect(input.clearNextConnection).toHaveBeenCalledOnce();
    expect(input.inspectConversationModel).not.toHaveBeenCalled();
  });

  it('keeps the current connection when the old binding cannot be restored', async () => {
    const input = dependencies({
      inspectConversationModel: vi.fn(async () => modelResolution({ restorable: false })),
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('failed');
    expect(input.openTemporarySession).not.toHaveBeenCalled();
    expect(input.warn).toHaveBeenCalledWith('上次对话的模型接入信息不完整，保留当前接入。');
  });

  it('starts and verifies the matching route instead of treating saved configuration as a live connection', async () => {
    const events: string[] = [];
    const input = dependencies({
      applyConversationModel: vi.fn(async () => {
        events.push('apply');
      }),
      closeTemporarySession: vi.fn(() => events.push('close')),
      inspectConversationModel: vi.fn(async () =>
        modelResolution({ differences: [], mismatch: false, restorable: true }),
      ),
      openTemporarySession: vi.fn(() => {
        events.push('open');
        return 'temporary-session';
      }),
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('restored');
    expect(events).toEqual(['open', 'apply', 'close']);
  });

  it('reports the exact official subscription account with each connection stage', async () => {
    const progress = vi.fn();
    const official = { ...modelResolution().current, accountIdentity: 'person@example.com' };
    const input = dependencies({
      inspectConversationModel: vi.fn(async () =>
        modelResolution({ conversation: { ...official, source: 'bound' } }),
      ),
      progress,
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('restored');
    expect(progress).toHaveBeenCalledWith({
      accountLabel: 'Anthropic · person@example.com',
      detail: '正在连接并验证最近一次选择的平台和模型。',
      step: '连接验证',
    });
    expect(progress).toHaveBeenLastCalledWith({
      accountLabel: 'Anthropic · person@example.com',
      detail: '验证已通过，正在提交下个对话使用的接入配置。',
      step: '提交接入配置',
    });
  });

  it('closes the temporary terminal and reports failure when model application rejects', async () => {
    const input = dependencies({
      applyConversationModel: vi.fn(async () => {
        throw new Error('fixture connection failure');
      }),
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('failed');
    expect(input.closeTemporarySession).toHaveBeenCalledExactlyOnceWith('temporary-session');
    expect(input.warn).toHaveBeenCalledWith(
      '自动加载上次对话模型失败，保留当前接入。',
      expect.objectContaining({ message: 'fixture connection failure' }),
    );
  });

  it('treats an aborted transaction as cancellation, closes its owner, and does not report failure', async () => {
    const controller = new AbortController();
    const input = dependencies({
      applyConversationModel: vi.fn(async () => {
        controller.abort(new Error('fixture cancellation'));
        throw controller.signal.reason;
      }),
      assertActive: () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      signal: controller.signal,
    });

    await expect(restoreLastConversationModelOnly(input)).resolves.toBe('cancelled');
    expect(input.closeTemporarySession).toHaveBeenCalledExactlyOnceWith('temporary-session');
    expect(input.warn).not.toHaveBeenCalled();
  });
});
