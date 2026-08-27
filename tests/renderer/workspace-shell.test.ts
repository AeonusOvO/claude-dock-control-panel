import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeConversationModelResolution,
  ClaudeLaunchOutcome,
  WorkspaceResult,
  WorkspaceState,
} from '../../src/shared/contracts';
import { expectCss, settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import {
  claudeProjectState,
  terminalStatus,
  terminalWorkspace,
} from '../helpers/renderer-terminal-fixture';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settlePromise) => {
    resolve = settlePromise;
  });
  return { promise, resolve };
};

const appendConversation = (
  workspace: WorkspaceState,
  id: string,
  title: string,
): WorkspaceState => ({
  ...workspace,
  activeSessionId: id,
  projects: workspace.projects.map((project) => ({
    ...project,
    sessionIds: [...project.sessionIds, id],
  })),
  revision: (workspace.revision ?? 0) + 1,
  sessions: [...workspace.sessions, terminalStatus(1, { id, title })],
});

describe('remaining renderer behavior contracts', () => {
  it('preserves scroll position and animation progress through identical workspace status pushes', async () => {
    const initial = { ...terminalWorkspace(), revision: 1 };
    await withTerminalRenderer({ getWorkspace: async () => initial }, async (harness) => {
      const list = harness.query<HTMLElement>('#project-list');
      let paintedHeight = 80;
      let animation:
        | { currentTime: number; playState: string; cancel: () => void; play: () => void }
        | undefined;
      vi.spyOn(list, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            height:
              animation?.playState === 'running'
                ? paintedHeight
                : 50 + list.querySelectorAll('.conversation-item').length * 30,
          }) as DOMRect,
      );
      const animate = vi.fn<HTMLElement['animate']>(() => {
        animation = {
          currentTime: 0,
          playState: 'running',
          cancel() {
            this.playState = 'idle';
          },
          play() {
            this.playState = 'running';
          },
        };
        return animation as unknown as Animation;
      });
      list.animate = animate;
      list.scrollTop = 12;
      const grown = appendConversation(initial, 'session-2', '第二个对话');
      harness.emit('onWorkspaceState', grown);
      await settle(harness);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(list.scrollTop).toBe(12);

      animation!.currentTime = 90;
      paintedHeight = 106;
      harness.emit('onWorkspaceState', { ...grown, revision: 3 });
      await settle(harness);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animation!.currentTime).toBe(90);
      expect(animation!.playState).toBe('running');

      harness.emit('onWorkspaceState', {
        ...appendConversation(grown, 'session-3', '第三个对话'),
        revision: 4,
      });
      await settle(harness);
      expect(animate).toHaveBeenCalledTimes(2);
      expect(animate.mock.calls.at(-1)?.[0]).toEqual([{ height: '106px' }, { height: '140px' }]);
    });
  });

  it.each(['conversation', 'folder'] as const)(
    'keeps %s archive controls disabled across workspace pushes and restores them on failure',
    async (kind) => {
      const pending = deferred<WorkspaceResult>();
      const workspace = { ...terminalWorkspace(), revision: 2 };
      await withTerminalRenderer(
        {
          getWorkspace: async () => workspace,
          closeProject: () => pending.promise,
          closeProjectFolder: () => pending.promise,
        },
        async (harness) => {
          const selector =
            kind === 'folder'
              ? '.project-folder__action--close'
              : '.conversation-item__action--close';
          harness.click(selector);
          harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
          await settle(harness);
          expect(harness.query('.conversation-item__phase').textContent).toBe('正在关闭并归档…');
          expect(harness.query('.conversation-item').getAttribute('aria-busy')).toBe('true');
          expect(harness.query('.terminal-mask').textContent).toContain('正在关闭并归档');

          harness.emit('onWorkspaceState', { ...workspace, revision: 3 });
          await settle(harness);
          for (const button of harness.document.querySelectorAll<HTMLButtonElement>(
            '.conversation-item button',
          )) {
            expect(button.disabled).toBe(true);
          }
          expect(harness.query<HTMLButtonElement>('.project-folder__action--close').disabled).toBe(
            true,
          );
          expect(
            harness.query<HTMLButtonElement>(
              '.project-folder__action:not(.project-folder__action--close)',
            ).disabled,
          ).toBe(kind === 'folder');
          harness.click(selector);
          expect(
            harness.method(kind === 'folder' ? 'closeProjectFolder' : 'closeProject'),
          ).toHaveBeenCalledTimes(1);

          pending.resolve({
            error: '终端关闭失败，请重试',
            ok: false,
            state: { ...workspace, revision: 4 },
          });
          await settle(harness);
          expect(harness.query<HTMLButtonElement>(selector).disabled).toBe(false);
          expect(harness.query('.conversation-item').getAttribute('aria-busy')).toBe('false');
          expect(harness.document.body.textContent).toContain('终端关闭失败，请重试');
          harness.click(selector);
          expect(harness.query<HTMLDialogElement>('#confirmation-dialog').open).toBe(true);
          harness.query<HTMLDialogElement>('#confirmation-dialog').close('cancel');
          await settle(harness);
          expect(harness.query<HTMLButtonElement>(selector).disabled).toBe(false);
        },
      );
    },
  );

  it('keeps all ten rapid new-conversation clicks through background and out-of-order launch completion', async () => {
    let workspace = { ...terminalWorkspace(), revision: 1 };
    const launches = new Map<string, ReturnType<typeof deferred<ClaudeLaunchOutcome>>>();
    let sequence = 1;
    await withTerminalRenderer(
      {
        getWorkspace: async () => workspace,
        getClaudeProjectState: async (sessionId) => claudeProjectState({ sessionId }),
        openConversation: async () => {
          const id = `session-${++sequence}`;
          workspace = appendConversation(workspace, id, `对话 ${sequence}`) as typeof workspace;
          return { createdSessionId: id, ok: true, runtime: 'claude', state: workspace };
        },
        launchClaude: (sessionId) => {
          const pending = deferred<ClaudeLaunchOutcome>();
          launches.set(sessionId, pending);
          return pending.promise;
        },
      },
      async (harness) => {
        for (let click = 0; click < 10; click += 1) harness.click('.project-folder__action');
        await settle(harness);
        expect(harness.document.querySelectorAll('.conversation-item')).toHaveLength(11);
        expect(launches.size).toBeGreaterThan(0);
        const completed = new Set<string>();
        for (let round = 0; round < 10 && completed.size < 10; round += 1) {
          for (const [sessionId, pending] of [...launches].reverse()) {
            if (completed.has(sessionId)) continue;
            completed.add(sessionId);
            workspace = {
              ...workspace,
              revision: workspace.revision + 1,
              sessions: workspace.sessions.map((status) =>
                status.id === sessionId ? { ...status, ptyGeneration: 2 } : status,
              ),
            };
            harness.emit('onWorkspaceState', workspace);
            pending.resolve({
              status: 'completed',
              result: {
                ok: true,
                state: claudeProjectState({
                  sessionId,
                  active: true,
                  ptyGeneration: 2,
                  stateRevision: 2,
                }),
              },
            });
          }
          await settle(harness);
        }
        expect(completed.size).toBe(10);
        expect(harness.method('closeProject')).not.toHaveBeenCalled();
        expect(harness.document.querySelectorAll('.conversation-item')).toHaveLength(11);
        expect(harness.document.querySelectorAll('.conversation-item--pending')).toHaveLength(0);
        expect(
          harness.query<HTMLElement>('.conversation-item[data-session-id="session-11"]').dataset
            .active,
        ).toBe('true');
      },
    );
  });

  it('queues competing history model choices and resumes each exact conversation independently', async () => {
    let workspace: WorkspaceState = { ...terminalWorkspace(), revision: 1 };
    let sequence = 1;
    let historyReads = 0;
    const history = ['A', 'B'].map((label) => ({
      conversationId: `history-${label}`,
      sessionId: `history-${label}`,
      sessionName: `历史 ${label}`,
      lastActiveAt: 1,
      messageCount: 2,
    }));
    const identity: ClaudeConversationModelResolution['conversation'] = {
      accountDetail: 'API 已配置',
      authModeLabel: 'Bearer',
      credentialConfigured: true,
      mainModel: 'old-model',
      smallModel: 'old-fast',
      networkPresentation: 'domestic',
      protocolLabel: 'Anthropic Messages',
      providerLabel: 'DeepSeek',
      source: 'bound',
    };
    await withTerminalRenderer(
      {
        getWorkspace: async () => workspace,
        getClaudeProjectState: async (sessionId) => claudeProjectState({ sessionId }),
        getClaudeSessionsForPath: async () => (++historyReads === 1 ? [] : history),
        openStoredConversation: async (_projectPath, conversationId) => {
          const sessionId = `session-${++sequence}`;
          workspace = appendConversation(workspace, sessionId, conversationId);
          return {
            createdSessionId: sessionId,
            ok: true,
            reused: false,
            runtime: 'claude',
            state: workspace,
          };
        },
        inspectClaudeConversationModel: async () => ({
          conversation: identity,
          current: { ...identity, source: 'current', mainModel: 'new-model' },
          differences: ['main-model'],
          mismatch: true,
          preference: 'ask',
          restorable: true,
        }),
        applyClaudeConversationModel: async (sessionId, _conversationId, choice) => ({
          choice,
          ok: true,
          state: claudeProjectState({ sessionId }),
        }),
        launchClaudeWithSession: async (sessionId) => ({
          status: 'completed',
          result: { ok: true, state: claudeProjectState({ sessionId, active: true }) },
        }),
      },
      async (harness) => {
        harness.click('.project-folder__disclosure');
        await settle(harness);
        const buttons =
          harness.document.querySelectorAll<HTMLButtonElement>('.history-item__select');
        expect(buttons).toHaveLength(2);
        buttons[0]!.click();
        buttons[1]!.click();
        await settle(harness);
        expect(harness.query('#conversation-model-dialog-title').textContent).toContain('历史 A');
        expect(harness.method('closeProject')).not.toHaveBeenCalled();
        harness.click('#conversation-model-dialog-current');
        await settle(harness);
        expect(harness.query<HTMLDialogElement>('#conversation-model-dialog').open).toBe(true);
        expect(harness.query('#conversation-model-dialog-title').textContent).toContain('历史 B');
        harness.click('#conversation-model-dialog-original');
        await settle(harness);
        expect(harness.method('launchClaudeWithSession')).toHaveBeenCalledWith(
          'session-2',
          'history-A',
        );
        expect(harness.method('launchClaudeWithSession')).toHaveBeenCalledWith(
          'session-3',
          'history-B',
        );
        expect(harness.method('closeProject')).not.toHaveBeenCalled();
        expect(harness.document.querySelectorAll('.history-item')).toHaveLength(0);
      },
    );
  });

  it('ignores an older workspace snapshot after a concurrent session was already rendered', async () => {
    const first = terminalStatus(1, { id: 'session-1', title: 'First' });
    const second = terminalStatus(1, { id: 'session-2', title: 'Second' });
    const newest = {
      activeSessionId: 'session-2',
      projects: [
        {
          lastActiveAt: 2,
          missing: false,
          name: 'Project',
          open: true,
          path: 'D:\\Project',
          remembered: true,
          sessionIds: ['session-1', 'session-2'],
        },
      ],
      revision: 12,
      sessions: [first, second],
    };
    await withTerminalRenderer({ getWorkspace: async () => newest }, async (harness) => {
      harness.click('[data-rail-tab="projects"]');
      await settle(harness);
      expect(harness.document.querySelector('[data-session-id="session-2"]')).not.toBeNull();

      harness.emit('onWorkspaceState', {
        ...newest,
        activeSessionId: 'session-1',
        revision: 11,
        sessions: [first],
      });
      await settle(harness);

      expect(harness.document.querySelector('[data-session-id="session-2"]')).not.toBeNull();
      expect(harness.query<HTMLElement>('[data-session-id="session-2"]').dataset.active).toBe(
        'true',
      );
    });
  });

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
      let historyReads = 0;
      await withTerminalRenderer(
        {
          applyClaudeConversationModel: () => apply.promise,
          getClaudeSessionsForPath: async () =>
            ++historyReads === 1
              ? []
              : [
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
