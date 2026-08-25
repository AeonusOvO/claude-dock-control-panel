import { afterEach, describe, expect, it } from 'vitest';
import type {
  AppSettingsView,
  ClaudeConversationModelResolution,
  ControlPanelApi,
  WorkspaceState,
} from '../../src/shared/contracts';
import { createRendererHarness, type RendererHarness } from '../helpers/renderer-harness';
import {
  claudeProjectState,
  installFakeTerminalModules,
  terminalStatus,
  terminalWorkspace,
  type FakeTerminalControl,
} from '../helpers/renderer-terminal-fixture';

const conversationId = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const settings = (autoLoadModel = true): AppSettingsView => ({
  advanced: {
    chatIdleTimeoutMinutes: 0,
    networkPreflight: { checkOnNewSession: true, checkOnProviderLogin: true },
    webResearchIsolation: false,
  },
  artifactNetworkAllowed: true,
  claudeContextWindowMode: 'auto',
  closeBehavior: 'tray',
  conversationResume: {
    autoLoadLastConversationModelOnStartup: autoLoadModel,
    autoLoadLastConversationOnStartup: true,
    modelMismatchBehavior: 'ask',
  },
  footerResourcePreference: 'auto',
  language: 'zh-CN',
  launchAtLogin: false,
  managedChatGptContextWindowMode: 'standard',
  theme: 'claude',
  version: 'test',
});

const rememberedWorkspace = (): WorkspaceState => ({
  activeSessionId: '',
  projects: [
    {
      lastActiveAt: 42,
      missing: false,
      name: 'Project',
      open: false,
      path: 'D:\\Project',
      remembered: true,
      sessionIds: [],
    },
  ],
  sessions: [],
});

const resolution = (): ClaudeConversationModelResolution => ({
  conversation: {
    accountDetail: 'API 凭据已配置 · SHA-256 1234567890',
    authModeLabel: 'Bearer / Auth Token',
    credentialConfigured: true,
    credentialFingerprint: '1234567890',
    endpoint: 'https://api.deepseek.com/anthropic',
    mainModel: 'deepseek-v4-pro',
    networkPresentation: 'domestic',
    protocolLabel: 'Anthropic Messages',
    providerLabel: 'DeepSeek',
    smallModel: 'deepseek-v4-flash',
    source: 'bound',
  },
  current: {
    accountDetail: '订阅账户：person@example.com',
    accountIdentity: 'person@example.com',
    authModeLabel: '订阅账户 / 现有登录',
    credentialConfigured: false,
    mainModel: 'claude-sonnet-5',
    networkPresentation: 'foreign',
    protocolLabel: 'Anthropic Messages',
    providerLabel: 'Anthropic 官方登录',
    smallModel: 'claude-haiku-4-5',
    source: 'current',
  },
  differences: ['account', 'credential', 'main-model', 'platform', 'small-model'],
  mismatch: true,
  preference: 'ask',
  restorable: true,
});

const waitFor = async (harness: RendererHarness, predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => harness.dom.window.setTimeout(resolve, 10));
    await harness.flush();
    if (predicate()) return;
  }
  throw new Error('renderer startup condition did not settle');
};

describe('startup conversation restore', () => {
  let control: FakeTerminalControl | undefined;
  let harness: RendererHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    control?.uninstall();
    control = undefined;
  });

  it('restores the latest bound model, masks the terminal, and fences input until launch settles', async () => {
    control = installFakeTerminalModules();
    const inspect = deferred<ClaudeConversationModelResolution>();
    const apply = deferred<Awaited<ReturnType<ControlPanelApi['applyClaudeConversationModel']>>>();
    const launch = deferred<Awaited<ReturnType<ControlPanelApi['launchClaudeWithSession']>>>();
    harness = await createRendererHarness({
      applyClaudeConversationModel: () => apply.promise,
      getAppSettings: async () => settings(),
      getClaudeSessionsForPath: async () => [
        {
          conversationId,
          lastActiveAt: 42,
          messageCount: 3,
          modelId: 'deepseek-v4-pro',
          sessionId: conversationId,
          sessionName: 'DeepSeek 上次对话',
        },
      ],
      getWorkspace: async () => rememberedWorkspace(),
      inspectClaudeConversationModel: () => inspect.promise,
      launchClaudeWithSession: () => launch.promise,
      openStoredConversation: async () => ({ ok: true, state: terminalWorkspace() }),
    });

    await waitFor(
      harness,
      () => harness?.method('inspectClaudeConversationModel').mock.calls.length === 1,
    );
    expect(harness.method('openStoredConversation')).toHaveBeenCalledWith(
      'D:\\Project',
      conversationId,
    );
    expect(harness.query('.terminal-mask__label').textContent).toBe('正在连接模型…');
    expect(harness.query<HTMLTextAreaElement>('#composer-input').disabled).toBe(true);
    expect(control.terminals[0]?.options.disableStdin).toBe(true);

    inspect.resolve(resolution());
    await waitFor(
      harness,
      () => harness?.method('applyClaudeConversationModel').mock.calls.length === 1,
    );
    expect(harness.method('applyClaudeConversationModel')).toHaveBeenCalledWith(
      'session-1',
      conversationId,
      'use-conversation',
    );
    control.terminals[0]?.emitData('blocked');
    expect(harness.method('writeTerminal')).not.toHaveBeenCalledWith('session-1', 1, 'blocked');

    apply.resolve({
      choice: 'use-conversation',
      connectionTest: {
        message: '连接成功',
        ok: true,
        stages: [],
        testedAt: 1,
        tone: 'success',
      },
      ok: true,
      state: claudeProjectState(),
    });
    await waitFor(
      harness,
      () => harness?.method('launchClaudeWithSession').mock.calls.length === 1,
    );
    harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2, { phase: 'starting' })));
    harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
    launch.resolve({
      result: {
        ok: true,
        state: claudeProjectState({ active: true, ptyGeneration: 2, stateRevision: 2 }),
      },
      status: 'completed',
    });
    await waitFor(harness, () => !harness?.document.querySelector('.terminal-mask'));

    expect(harness.query<HTMLTextAreaElement>('#composer-input').disabled).toBe(false);
    expect(control.terminals.at(-1)?.options.disableStdin).toBe(false);
    expect(harness.method('launchClaudeWithSession')).toHaveBeenCalledWith(
      'session-1',
      conversationId,
    );
  });

  it('can restore the conversation with the current model when automatic model loading is off', async () => {
    control = installFakeTerminalModules();
    harness = await createRendererHarness({
      getAppSettings: async () => settings(false),
      getClaudeSessionsForPath: async () => [
        {
          conversationId,
          lastActiveAt: 42,
          messageCount: 3,
          modelId: 'deepseek-v4-pro',
          sessionId: conversationId,
        },
      ],
      getWorkspace: async () => rememberedWorkspace(),
      launchClaudeWithSession: async () => ({
        result: {
          ok: true,
          state: claudeProjectState({ active: true, stateRevision: 2 }),
        },
        status: 'completed',
      }),
      openStoredConversation: async () => ({ ok: true, state: terminalWorkspace() }),
    });

    await waitFor(
      harness,
      () => harness?.method('launchClaudeWithSession').mock.calls.length === 1,
    );
    expect(harness.method('inspectClaudeConversationModel')).not.toHaveBeenCalled();
    expect(harness.method('applyClaudeConversationModel')).not.toHaveBeenCalled();
  });

  it('does not inspect history when automatic conversation loading is off', async () => {
    control = installFakeTerminalModules();
    harness = await createRendererHarness({
      getAppSettings: async () => ({
        ...settings(),
        conversationResume: {
          ...settings().conversationResume,
          autoLoadLastConversationOnStartup: false,
        },
      }),
      getWorkspace: async () => rememberedWorkspace(),
    });

    await harness.flush();
    expect(harness.method('getClaudeSessionsForPath')).not.toHaveBeenCalled();
    expect(harness.method('openStoredConversation')).not.toHaveBeenCalled();
  });

  it('keeps renderer startup usable when the history index cannot be read', async () => {
    control = installFakeTerminalModules();
    harness = await createRendererHarness({
      getAppSettings: async () => settings(),
      getClaudeSessionsForPath: async () => {
        throw new Error('fixture history failure');
      },
      getWorkspace: async () => rememberedWorkspace(),
    });

    await waitFor(
      harness,
      () => harness?.query('#toast').textContent.includes('请从历史列表手动重试') ?? false,
    );
    expect(harness.method('openStoredConversation')).not.toHaveBeenCalled();
  });
});
