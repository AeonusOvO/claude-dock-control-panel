import { describe, expect, it } from 'vitest';
import { expectCss, settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import { claudeProjectState, terminalWorkspace } from '../helpers/renderer-terminal-fixture';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settlePromise) => {
    resolve = settlePromise;
  });
  return { promise, resolve };
};

describe('remaining renderer behavior contracts', () => {
  it('exposes permanent history deletion with confirmation in every stored conversation row', async () => {
    await withTerminalRenderer(
      {
        getClaudeSessionsForPath: async () => [
          {
            conversationId: 'history-1',
            lastActiveAt: 1,
            messageCount: 2,
            sessionId: 'history-1',
            sessionName: 'Stored',
          },
        ],
      },
      async (harness) => {
        harness.click('[data-rail-tab="projects"]');
        harness.query<HTMLButtonElement>('.project-folder__disclosure').click();
        await settle(harness);
        const button = harness.query<HTMLButtonElement>('.history-item__delete');
        button.click();
        expect(harness.query('#confirmation-dialog').textContent).toContain('永久删除');
      },
    );
  });

  it('moves history into a pending live row immediately and restores it after a failed resume', async () => {
    const conversationId = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
    let historyReads = 0;
    const opening =
      deferred<Awaited<ReturnType<Window['controlPanel']['openStoredConversation']>>>();
    await withTerminalRenderer(
      {
        getClaudeSessionsForPath: async () =>
          ++historyReads === 1
            ? []
            : [
                {
                  conversationId,
                  lastActiveAt: 1,
                  messageCount: 2,
                  sessionId: conversationId,
                  sessionName: '待恢复设计稿',
                },
              ],
        openStoredConversation: () => opening.promise,
      },
      async (harness) => {
        harness.click('[data-rail-tab="projects"]');
        harness.query<HTMLButtonElement>('.project-folder__disclosure').click();
        await settle(harness);

        harness.query<HTMLButtonElement>('.history-item__select').click();
        await Promise.resolve();
        expect(harness.document.querySelector('.history-item')).toBeNull();
        expect(harness.query('.conversation-item--pending').textContent).toContain('正在恢复');
        expect(harness.query('.terminal-mask--workspace-preview').textContent).toContain(
          '正在恢复历史对话',
        );

        opening.resolve({ error: '历史终端无法创建', ok: false, state: terminalWorkspace() });
        await settle(harness);

        expect(harness.document.querySelector('.conversation-item--pending')).toBeNull();
        expect(harness.query('.history-item').textContent).toContain('待恢复设计稿');
        expect(harness.document.body.textContent).toContain('历史终端无法创建');
      },
    );
  });

  it('keeps a restored live row honest until the CLI launch commits', async () => {
    const conversationId = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
    let historyReads = 0;
    const launch =
      deferred<Awaited<ReturnType<Window['controlPanel']['launchClaudeWithSession']>>>();
    await withTerminalRenderer(
      {
        getClaudeSessionsForPath: async () =>
          ++historyReads === 1
            ? []
            : [
                {
                  conversationId,
                  lastActiveAt: 1,
                  messageCount: 2,
                  sessionId: conversationId,
                  sessionName: '待恢复设计稿',
                },
              ],
        closeProject: async () => ({
          ok: true,
          state: {
            activeSessionId: '',
            projects: [
              {
                lastActiveAt: 1,
                missing: false,
                name: 'Project',
                open: false,
                path: 'D:\\Project',
                remembered: true,
                sessionIds: [],
              },
            ],
            sessions: [],
          },
        }),
        inspectClaudeConversationModel: async () => {
          const identity = {
            accountDetail: 'Claude 官方登录',
            authModeLabel: '订阅账户',
            credentialConfigured: false,
            mainModel: 'default',
            networkPresentation: 'foreign' as const,
            protocolLabel: 'Anthropic Messages',
            providerLabel: 'Anthropic',
            smallModel: 'default',
            source: 'current' as const,
          };
          return {
            conversation: identity,
            current: identity,
            differences: [],
            mismatch: false,
            preference: 'ask',
            restorable: true,
          };
        },
        launchClaudeWithSession: () => launch.promise,
        openStoredConversation: async () => ({
          createdSessionId: 'session-1',
          ok: true,
          reused: false,
          runtime: 'claude',
          state: terminalWorkspace(),
        }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="projects"]');
        harness.query<HTMLButtonElement>('.project-folder__disclosure').click();
        await settle(harness);
        harness.query<HTMLButtonElement>('.history-item__select').click();
        await settle(harness);

        const liveRow = harness.query<HTMLElement>(
          '.conversation-item[data-session-id="session-1"]',
        );
        expect(liveRow.dataset.transition).toBe('restoring');
        expect(liveRow.textContent).toContain('正在恢复');
        expect(
          liveRow.querySelectorAll<HTMLButtonElement>('.conversation-item__action')[0]?.disabled,
        ).toBe(true);

        launch.resolve({
          result: { error: 'Claude 恢复失败', ok: false, state: claudeProjectState() },
          status: 'completed',
        });
        await settle(harness);
        expect(harness.document.querySelector('[data-transition="restoring"]')).toBeNull();
        expect(harness.query('.history-item').textContent).toContain('待恢复设计稿');
        expect(harness.document.body.textContent).toContain('Claude 恢复失败');
      },
    );
  });

  it('shows a complete animated model comparison and remembers the selected policy', async () => {
    const conversationId = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
    await withTerminalRenderer(
      {
        getClaudeSessionsForPath: async () => [
          {
            conversationId,
            lastActiveAt: 1,
            messageCount: 2,
            modelId: 'deepseek-v4-pro',
            sessionId: conversationId,
            sessionName: 'DeepSeek 设计稿',
          },
        ],
        inspectClaudeConversationModel: async () => ({
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
        }),
        openStoredConversation: async () => ({
          createdSessionId: 'session-1',
          ok: true,
          reused: false,
          state: terminalWorkspace(),
        }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="projects"]');
        harness.query<HTMLButtonElement>('.project-folder__disclosure').click();
        await settle(harness);
        harness.query<HTMLButtonElement>('.history-item__select').click();
        await settle(harness);

        const dialog = harness.query<HTMLDialogElement>('#conversation-model-dialog');
        expect(dialog.open).toBe(true);
        expect(dialog.textContent).toContain('deepseek-v4-flash');
        expect(dialog.textContent).toContain('person@example.com');
        expect(dialog.textContent).toContain('SHA-256 1234567890');
        harness.query<HTMLInputElement>('#conversation-model-dialog-remember').checked = true;
        harness.click('#conversation-model-dialog-current');
        await settle(harness);

        expect(harness.method('setConversationResumePreferences')).toHaveBeenCalledWith({
          autoLoadLastConversationModelOnStartup: true,
          autoLoadLastConversationOnStartup: true,
          modelMismatchBehavior: 'use-current',
          startupModelConnectCancelAfterMinutes: 2,
          startupModelConnectForceStopAfterMinutes: 5,
        });
        expect(harness.method('openStoredConversation')).toHaveBeenCalled();
        expectCss(/conversationModelCardEnter/u);
        expectCss(/launchProgressSweep/u);
      },
    );
  });

  it.each([
    ['domestic', '正在切换对话模型…', false],
    ['foreign', '正在切换模型并检查网络…', true],
  ] as const)(
    'uses the %s model progress copy without inventing the word 当前',
    async (networkPresentation, switchingLabel, mentionsNetwork) => {
      const conversationId = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
      const apply =
        deferred<Awaited<ReturnType<Window['controlPanel']['applyClaudeConversationModel']>>>();
      const launch =
        deferred<Awaited<ReturnType<Window['controlPanel']['launchClaudeWithSession']>>>();
      await withTerminalRenderer(
        {
          applyClaudeConversationModel: () => apply.promise,
          getClaudeSessionsForPath: async () => [
            {
              conversationId,
              lastActiveAt: 1,
              messageCount: 2,
              modelId: 'old-model',
              sessionId: conversationId,
              sessionName: 'Stored',
            },
          ],
          inspectClaudeConversationModel: async () => ({
            conversation: {
              accountDetail: 'API 凭据已配置',
              authModeLabel: 'Bearer / Auth Token',
              credentialConfigured: true,
              mainModel: 'old-model',
              networkPresentation,
              protocolLabel: 'Anthropic Messages',
              providerLabel: '原平台',
              smallModel: 'old-fast',
              source: 'bound',
            },
            current: {
              accountDetail: 'API 凭据已配置',
              authModeLabel: 'Bearer / Auth Token',
              credentialConfigured: true,
              mainModel: 'new-model',
              networkPresentation: 'foreign',
              protocolLabel: 'Anthropic Messages',
              providerLabel: '现平台',
              smallModel: 'new-fast',
              source: 'current',
            },
            differences: ['main-model'],
            mismatch: true,
            preference: 'use-conversation',
            restorable: true,
          }),
          launchClaudeWithSession: () => launch.promise,
          openStoredConversation: async () => ({
            ok: true,
            reused: false,
            state: terminalWorkspace(),
          }),
        },
        async (harness) => {
          harness.click('[data-rail-tab="projects"]');
          harness.query<HTMLButtonElement>('.project-folder__disclosure').click();
          await settle(harness);
          harness.query<HTMLButtonElement>('.history-item__select').click();
          await settle(harness);

          const switchingText = harness.query('#run-agent-label').textContent ?? '';
          expect(switchingText).toContain(switchingLabel);
          expect(switchingText.includes('网络')).toBe(mentionsNetwork);
          expect(switchingText).not.toContain('当前');

          const state = claudeProjectState({ active: true, stateRevision: 2 });
          apply.resolve({ choice: 'use-conversation', ok: true, state });
          await settle(harness);
          expect(harness.query('#run-agent-label').textContent).toContain('正在恢复历史对话…');
          launch.resolve({ result: { ok: true, state }, status: 'completed' });
          await settle(harness);
        },
      );
    },
  );

  it('collapses an already-selected activity tab without losing the terminal', async () => {
    await withTerminalRenderer({}, async (harness) => {
      const terminal = harness.query('.project-terminal');
      harness.click('[data-rail-tab="projects"]');
      expect(harness.query('#workspace').classList.contains('workspace--rail-collapsed')).toBe(
        true,
      );
      expect(harness.query('.project-terminal')).toBe(terminal);
      expect(harness.query('#control-panel')).toHaveProperty('inert', true);
    });
  });

  it('locks the complete connection remedy surface and preserves the provider draft', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.query<HTMLButtonElement>('[data-provider-id="anthropic"]').click();
      expect(harness.query<HTMLInputElement>('#claude-model').value).toBe('default');
      expect(harness.query('#connection-provider-picker')).not.toHaveProperty('inert', true);
    });
  });

  it('transitions the sidebar collapse and re-fits the terminal once it settles', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      harness.clearCalls();
      control.proposedDimensions = { cols: 120, rows: 40 };
      harness.query('#workspace').dispatchEvent(
        new harness.dom.window.TransitionEvent('transitionend', {
          bubbles: true,
          propertyName: 'grid-template-columns',
        }),
      );
      await settle(harness);
      expect(harness.method('resizeTerminal')).toHaveBeenCalled();
      expectCss(/body\.is-resizing \.workspace\s*\{\s*transition:\s*none/u);
    });
  });
});
