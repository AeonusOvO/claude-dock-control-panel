/* eslint-disable max-lines */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeLaunchAttemptRegistry } from '../../src/renderer/platform/claude-launch-attempt';
import { FolderHistoryLoadCoordinator } from '../../src/renderer/features/projects/folder-history-load';
import {
  orchestrateSessionOperation,
  SessionGenerationRegistry,
} from '../../src/renderer/platform/session-generation';
import { claudeStateOwnershipIsCurrent } from '../../src/shared/claude/state-ownership';
import type {
  CodexProjectState,
  ControlPanelApi,
  OperationResult,
  WorkspaceState,
} from '../../src/shared/contracts';
import {
  expectCss,
  settle,
  withRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import { launchPauseDiagnostics } from '../helpers/renderer-preflight-fixture';
import {
  claudeProjectState,
  terminalStatus,
  terminalWorkspace,
} from '../helpers/renderer-terminal-fixture';

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} => {
  let reject = (_error: unknown): void => undefined;
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const codexProjectState = (overrides: Partial<CodexProjectState> = {}): CodexProjectState => ({
  active: false,
  cwd: 'D:\\Project',
  installation: {
    installed: true,
    message: 'Codex CLI 已就绪。',
    updateAvailable: false,
    version: '1.0.0',
  },
  login: { phase: 'idle' },
  revision: 1,
  requiresOpenaiAuth: false,
  sessionId: 'session-1',
  ...overrides,
});

const twoSessionWorkspace = (activeSessionId: 'session-a' | 'session-b'): WorkspaceState => {
  const sessionA = terminalStatus(1, {
    cwd: 'D:\\ProjectA',
    id: 'session-a',
    title: 'Project A',
  });
  const sessionB = terminalStatus(1, {
    cwd: 'D:\\ProjectB',
    id: 'session-b',
    title: 'Project B',
  });
  return {
    activeSessionId,
    projects: [
      {
        lastActiveAt: 2,
        missing: false,
        name: 'Project A',
        open: true,
        path: sessionA.cwd,
        remembered: true,
        sessionIds: [sessionA.id],
      },
      {
        lastActiveAt: 1,
        missing: false,
        name: 'Project B',
        open: true,
        path: sessionB.cwd,
        remembered: true,
        sessionIds: [sessionB.id],
      },
    ],
    sessions: [sessionA, sessionB],
  };
};

describe('renderer interaction lifecycle behavior', () => {
  it('always releases resize pointer capture across interrupted window lifecycles', async () => {
    await withRenderer({}, async (harness) => {
      const event = new harness.dom.window.MouseEvent('pointerdown', { button: 0, clientX: 100 });
      Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 } });
      harness.query('#panel-resizer').dispatchEvent(event);
      expect(harness.document.body.classList.contains('is-resizing')).toBe(true);
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('blur'));
      expect(harness.document.body.classList.contains('is-resizing')).toBe(false);
    });
  });

  it('opens the active xterm visibly, retries cold fits and coalesces live resizes per frame', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      expect(harness.query<HTMLElement>('.project-terminal--active').hidden).toBe(false);
      expect(control.terminals[0]?.options).toMatchObject({ allowProposedApi: true });
      expect(harness.method('resizeTerminal')).toHaveBeenCalledWith('session-1', 1, 1, 100, 30);
      expectCss(/\.project-terminal--active:focus-within\s*\{[^}]*--accent/u);
    });
  });

  it('opens background replacement views at their PTY size before accepting any output', async () => {
    const workspace = twoSessionWorkspace('session-a');
    const size = { cols: 159, rows: 39 };
    workspace.sessions = workspace.sessions.map((status) => ({ ...status, size }));
    await withTerminalRenderer(
      { getWorkspace: async () => workspace },
      async (harness, control) => {
        expect(control.terminals[1]?.options).toMatchObject(size);
        control.proposedDimensions = size;
        harness.clearCalls();
        const replacement = {
          ...workspace,
          sessions: workspace.sessions.map((status) => ({ ...status, ptyGeneration: 2 })),
        };
        harness.emit('onWorkspaceState', replacement);
        harness.emit('onTerminalData', 'session-b', 2, 'background full-screen output');
        expect(control.terminals.at(-1)?.options).toMatchObject(size);
        await settle(harness);
        for (const status of replacement.sessions) {
          expect(harness.method('resizeTerminal')).toHaveBeenCalledWith(status.id, 2, 1, 159, 39);
        }
        expect(control.terminals.at(-1)?.writes).toContain('background full-screen output');
      },
    );
  });

  it('does not let a delayed size echo overwrite a newer viewport measurement', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      const terminal = control.terminals[0]!;
      control.proposedDimensions = { cols: 159, rows: 39 };
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('resize'));
      await settle(harness);
      expect(terminal.cols).toBe(159);
      harness.emit('onTerminalSize', 'session-1', 1, 1, 100, 30);
      expect(terminal.cols).toBe(159);
      expect(terminal.rows).toBe(39);
    });
  });

  it('owns xterm views and asynchronous terminal work by exact PTY generation', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      const first = control.terminals[0]!;
      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
      await settle(harness);
      expect(first.disposed).toBe(true);
      harness.emit('onTerminalData', 'session-1', 1, 'stale');
      harness.emit('onTerminalData', 'session-1', 2, 'fresh');
      await settle(harness);
      expect(first.writes).not.toContain('stale');
      expect(control.terminals[1]?.writes).toContain('fresh');
    });
  });

  it('fences terminal interaction and permission probes after generation replacement', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
      await settle(harness);
      harness.clearCalls();
      harness.emit('onClaudePermissionModeProbe', 'session-1', 1, 8);
      expect(harness.method('reportClaudePermissionModeProbe')).toHaveBeenCalledWith(
        'session-1',
        1,
        8,
      );
      expect(harness.method('observeClaudePermissionMode')).not.toHaveBeenCalled();
    });
  });

  it('defers composer focus until the matching terminal is running', async () => {
    const stopped = terminalStatus(1, { phase: 'stopped' });
    const running = terminalStatus(1);
    type StartResult = Awaited<ReturnType<ControlPanelApi['startTerminal']>>;
    let resolveStart: ((result: StartResult) => void) | undefined;
    const pendingStart = new Promise<StartResult>((resolve) => {
      resolveStart = resolve;
    });
    await withTerminalRenderer(
      {
        getWorkspace: async () => terminalWorkspace(stopped),
        startTerminal: () => pendingStart,
      },
      async (harness) => {
        harness.query<HTMLButtonElement>('#clear-terminal').focus();
        expect(harness.document.activeElement).toBe(harness.query('#clear-terminal'));
        resolveStart?.({ ok: true, status: running });
        await settle(harness);
        expect(harness.document.activeElement).toBe(harness.query('#composer-input'));
      },
    );
  });

  it('keeps a running replacement owned until launch IPC settles and then handles success', async () => {
    type LaunchResult = Awaited<ReturnType<ControlPanelApi['launchClaude']>>;
    const launch = deferred<LaunchResult>();
    await withTerminalRenderer({ launchClaude: () => launch.promise }, async (harness) => {
      harness.click('#run-claude');
      const run = harness.query<HTMLButtonElement>('#run-claude');
      expect(harness.query('#run-agent-label').textContent).toContain('正在准备 Claude Code 终端…');
      expect(run.disabled).toBe(true);
      expect(run.getAttribute('aria-busy')).toBe('true');

      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2, { phase: 'starting' })));
      await harness.flush();
      expect(harness.query('#run-agent-label').textContent).toContain('正在准备网络访问…');
      expect(harness.query('#launch-new').textContent).toContain('正在准备网络访问…');

      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
      await settle(harness);
      expect(harness.query('#run-agent-label').textContent).toContain('正在准备网络访问…');
      expect(run.disabled).toBe(true);
      expect(run.getAttribute('aria-busy')).toBe('true');
      expect(harness.query('#toast').textContent).not.toContain('启动新会话');

      launch.resolve({
        result: {
          ok: true,
          state: claudeProjectState({ active: true, ptyGeneration: 2, stateRevision: 2 }),
        },
        status: 'completed',
      });
      await settle(harness);
      expect(run.disabled).toBe(false);
      expect(run.getAttribute('aria-busy')).toBe('false');
      expect(harness.query('#toast').textContent).toContain('启动新会话');
    });
  });

  it('handles a failed launch result after the replacement reported running first', async () => {
    type LaunchResult = Awaited<ReturnType<ControlPanelApi['launchClaude']>>;
    const launch = deferred<LaunchResult>();
    await withTerminalRenderer({ launchClaude: () => launch.promise }, async (harness) => {
      harness.click('#run-claude');
      const run = harness.query<HTMLButtonElement>('#run-claude');

      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
      await settle(harness);
      expect(run.disabled).toBe(true);
      expect(run.getAttribute('aria-busy')).toBe('true');

      launch.resolve({
        result: {
          error: 'synthetic launch failure',
          ok: false,
          state: claudeProjectState({ active: false, ptyGeneration: 2, stateRevision: 2 }),
        },
        status: 'completed',
      });
      await settle(harness);
      expect(run.disabled).toBe(false);
      expect(run.getAttribute('aria-busy')).toBe('false');
      expect(harness.query('#toast').textContent).toContain('操作失败');
    });
  });

  it('advances a paused terminal relaunch from preflight to waiting presentation', async () => {
    await withTerminalRenderer(
      {
        getClaudeModelOptions: async () => ({
          activeModel: 'claude-sonnet-5',
          options: [
            {
              entryId: 'history-next',
              id: 'next',
              label: 'Next',
              model: 'claude-opus-5',
              providerLabel: 'Anthropic',
              relaunchReason: 'connection',
              requiresRelaunch: true,
              sameEndpoint: false,
            },
          ],
        }),
        relaunchClaudeSession: async () => ({
          decisionId: 'decision-terminal-relaunch',
          diagnostics: launchPauseDiagnostics(),
          status: 'paused',
        }),
      },
      async (harness) => {
        harness.click('#footer-model');
        await settle(harness);
        harness.query<HTMLButtonElement>('#footer-model-menu button').click();
        harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
        await settle(harness);

        expect(harness.method('relaunchClaudeSession')).toHaveBeenCalledWith('session-1', {
          compactFirst: true,
          entryId: 'history-next',
        });
        expect(harness.query('#run-agent-label').textContent).toContain('等待网络确认…');
        expect(harness.query('#launch-new').textContent).toContain('等待网络确认…');
        expect(harness.query<HTMLDialogElement>('#claude-launch-preflight-dialog').open).toBe(true);
      },
    );
  });

  it('keeps restart feedback owned through workspace renders and restores it on settlement', async () => {
    type RestartResult = Awaited<ReturnType<ControlPanelApi['restartTerminal']>>;
    const restart = deferred<RestartResult>();
    await withTerminalRenderer({ restartTerminal: () => restart.promise }, async (harness) => {
      harness.click('#restart-terminal');
      const button = harness.query<HTMLButtonElement>('#restart-terminal');
      expect(harness.query('#restart-terminal-label').textContent).toBe('正在重启…');
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');

      harness.emit('onWorkspaceState', terminalWorkspace());
      await harness.flush();
      expect(harness.query('#restart-terminal-label').textContent).toBe('正在重启…');
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');

      restart.resolve({ ok: true, status: terminalStatus(2) });
      await settle(harness);
      expect(harness.query('#restart-terminal-label').textContent).toBe('重启');
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-busy')).toBe('false');
    });
  });

  it('labels terminal stop and start operations and restores only their owner', async () => {
    type StopResult = Awaited<ReturnType<ControlPanelApi['stopTerminal']>>;
    type StartResult = Awaited<ReturnType<ControlPanelApi['startTerminal']>>;
    const stop = deferred<StopResult>();
    const start = deferred<StartResult>();
    await withTerminalRenderer(
      {
        startTerminal: () => start.promise,
        stopTerminal: () => stop.promise,
      },
      async (harness) => {
        harness.click('#toggle-terminal');
        const button = harness.query<HTMLButtonElement>('#toggle-terminal');
        expect(harness.query('#toggle-terminal-label').textContent).toBe('正在停止…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        stop.reject(new Error('synthetic stop failure'));
        await settle(harness);
        expect(harness.query('#toggle-terminal-label').textContent).toBe('停止');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');

        harness.emit(
          'onWorkspaceState',
          terminalWorkspace(terminalStatus(1, { phase: 'stopped' })),
        );
        await harness.flush();
        harness.click('#toggle-terminal');
        expect(harness.query('#toggle-terminal-label').textContent).toBe('正在启动…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        start.resolve({ ok: true, status: terminalStatus(2) });
        await settle(harness);
        expect(harness.query('#toggle-terminal-label').textContent).toBe('停止');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it.each(['restart', 'start', 'stop'] as const)(
    'drops a removed session before a late %s settlement can toast or queue focus',
    async (operation) => {
      const request = deferred<OperationResult>();
      const initialStatus = terminalStatus(1, {
        phase: operation === 'start' ? 'stopped' : 'running',
      });
      const overrides: Partial<ControlPanelApi> = {
        getWorkspace: async () => terminalWorkspace(initialStatus),
      };
      if (operation === 'restart') overrides.restartTerminal = () => request.promise;
      if (operation === 'start') overrides.startTerminal = () => request.promise;
      if (operation === 'stop') overrides.stopTerminal = () => request.promise;

      await withTerminalRenderer(overrides, async (harness) => {
        if (operation === 'restart') harness.click('#restart-terminal');
        if (operation === 'stop') harness.click('#toggle-terminal');

        harness.emit('onWorkspaceState', { activeSessionId: '', projects: [], sessions: [] });
        await harness.flush();
        const clear = harness.query<HTMLButtonElement>('#clear-terminal');
        clear.focus();
        const toastBeforeSettlement = harness.query('#toast').textContent;

        request.resolve({ ok: true, status: terminalStatus(2) });
        await settle(harness);
        expect(harness.query('#toast').textContent).toBe(toastBeforeSettlement);

        harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(3)));
        await settle(harness);
        expect(harness.document.activeElement).toBe(clear);
      });
    },
  );

  it('keeps the shell interactive while a real connection test runs in the background', async () => {
    const pending = new Promise<never>(() => undefined);
    await withTerminalRenderer({ testClaudeConnection: () => pending }, async (harness) => {
      harness.click('#footer-connection');
      await harness.flush();
      expect(harness.query('#footer-connection').getAttribute('aria-busy')).toBe('true');
      harness.click('#clear-terminal');
      expect(harness.query<HTMLButtonElement>('#clear-terminal').disabled).toBe(false);
    });
  });

  it('keeps managed gateway operations behind the isolated main-process bridge', async () => {
    await withRenderer({}, async (harness) => {
      await harness.api.setupManagedChatGptGateway(undefined);
      await harness.api.setManagedChatGptGatewayModel('session-1', 'gpt-5.6-sol');
      expect(harness.method('setupManagedChatGptGateway')).toHaveBeenCalledWith(undefined);
      expect(harness.method('setManagedChatGptGatewayModel')).toHaveBeenCalledWith(
        'session-1',
        'gpt-5.6-sol',
      );
    });
  });

  it('generation-fences folder history refreshes across forget and re-add', () => {
    const coordinator = new FolderHistoryLoadCoordinator();
    const stale = coordinator.request('d:/project', false)!;
    coordinator.invalidate('d:/project');
    const current = coordinator.request('d:/project', false)!;
    expect(coordinator.finish(stale)).toEqual({ current: false, reloadRequested: false });
    expect(coordinator.finish(current)).toEqual({ current: true, reloadRequested: false });
  });

  it('keeps official preflight separate while the footer runs the saved real connection test', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.clearCalls();
      harness.click('#footer-connection');
      await settle(harness);
      expect(harness.method('testClaudeConnection')).toHaveBeenCalled();
      expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
    });
  });

  it('runs one real test for the active saved Claude connection on each app opening', async () => {
    await withTerminalRenderer({}, async (harness) => {
      await settle(harness);
      const initial = harness.method('testClaudeConnection').mock.calls.length;
      harness.emit('onAppWindowRestored');
      await settle(harness);
      expect(harness.method('testClaudeConnection').mock.calls.length).toBe(initial + 1);
    });
  });

  it('shows the correlation code returned by a failed connection test', async () => {
    await withTerminalRenderer(
      {
        testClaudeConnection: async () => ({
          authMode: 'apiKey',
          code: 'CD-CLAUDECONNECTION-TEST-1',
          detail: 'connect ECONNREFUSED',
          failureKind: 'network',
          kind: 'external-service',
          latencyMs: 25,
          message: '无法建立网络连接。',
          ok: false,
          stages: [
            {
              detail: '接口尚未连通。',
              id: 'endpoint',
              label: '接口地址',
              status: 'failed',
            },
          ],
          testedAt: 1,
          tone: 'error',
        }),
      },
      async (harness) => {
        expect(harness.query('#connection-test-summary').textContent).toContain(
          '无法建立网络连接。（诊断码：CD-CLAUDECONNECTION-TEST-1）',
        );
      },
    );
  });

  it('turns the footer model, speed, mode and effort readouts into real menu triggers', async () => {
    await withTerminalRenderer({}, async (harness) => {
      for (const id of ['model', 'speed', 'mode', 'effort']) {
        harness.click(`#footer-${id}`);
        await settle(harness);
        expect(harness.query(`#footer-${id}-menu`).hasAttribute('hidden')).toBe(false);
        harness.dom.window.dispatchEvent(new harness.dom.window.Event('blur'));
        expect(harness.query(`#footer-${id}-menu`).hasAttribute('hidden')).toBe(true);
      }
    });
  });

  it('keeps serving speed model-specific and truthful across Claude, GPT and native Codex', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit(
        'onClaudeState',
        claudeProjectState({
          active: true,
          speed: {
            availability: 'available',
            canSelectFast: true,
            detail: '上游已确认。',
            mechanism: 'claude-native-fast',
            model: 'claude-sonnet-5',
            preference: 'fast',
            status: 'active',
          },
        }),
      );
      expect(harness.query('#footer-speed').textContent).toContain('Claude Fast');
    });
  });

  it('always releases the model switch trigger after the IPC operation settles', async () => {
    await withTerminalRenderer(
      {
        getClaudeModelOptions: async () => ({
          activeModel: 'claude-sonnet-5',
          currentOptionId: 'current',
          options: [
            {
              id: 'next',
              label: 'Next',
              model: 'claude-opus-5',
              providerLabel: 'Anthropic',
              requiresRelaunch: false,
              sameEndpoint: true,
            },
          ],
        }),
        switchClaudeModel: async () => {
          throw new Error('synthetic failure');
        },
      },
      async (harness) => {
        harness.click('#footer-model');
        await settle(harness);
        harness.query<HTMLButtonElement>('#footer-model-menu button').click();
        await settle(harness);
        expect(harness.method('switchClaudeModel')).toHaveBeenCalledWith('session-1', 'next');
        expect(harness.query<HTMLButtonElement>('#footer-model').disabled).toBe(false);
      },
    );
  });

  it('settles an active Claude speed switch after the replacement PTY starts', async () => {
    type SpeedResult = Awaited<ReturnType<ControlPanelApi['setClaudeModelSpeed']>>;
    const speed = deferred<SpeedResult>();
    await withTerminalRenderer(
      {
        setClaudeModelSpeed: () => speed.promise,
      },
      async (harness, control) => {
        harness.click('#footer-speed');
        const speedOptions = harness
          .query<HTMLDivElement>('#footer-speed-menu')
          .querySelectorAll<HTMLButtonElement>('button');
        speedOptions[1]?.click();
        harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
        await harness.flush();

        expect(harness.method('setClaudeModelSpeed')).toHaveBeenCalledWith('session-1', 'fast');
        expect(harness.document.body.dataset.conversationTransition).toBe('busy');
        expect(harness.query('#terminal-composer').inert).toBe(true);
        expect(control.terminals[0]?.options.disableStdin).toBe(true);

        harness.emit(
          'onWorkspaceState',
          terminalWorkspace(terminalStatus(2, { phase: 'starting' })),
        );
        await harness.flush();
        harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
        await settle(harness);

        speed.resolve({
          ok: true,
          state: claudeProjectState({
            active: true,
            ptyGeneration: 2,
            speed: {
              availability: 'available',
              canSelectFast: true,
              detail: '可切换 Claude Fast。',
              mechanism: 'claude-native-fast',
              model: 'claude-sonnet-5',
              preference: 'fast',
              status: 'active',
            },
            stateRevision: 2,
          }),
        });
        await settle(harness);
        const composerInput = harness.query<HTMLTextAreaElement>('#composer-input');
        composerInput.value = 'echo ready';
        composerInput.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
        harness.query<HTMLFormElement>('#terminal-composer').requestSubmit();
        await settle(harness);

        expect(harness.document.body.dataset.conversationTransition).toBe('idle');
        expect(harness.query('#terminal-composer').inert).toBe(false);
        expect(control.terminals.at(-1)?.options.disableStdin).toBe(false);
        expect(harness.query<HTMLTextAreaElement>('#composer-input').disabled).toBe(false);
        expect(harness.query('#toast').textContent).toContain('已请求 Claude Fast');
        expect(harness.method('writeTerminal')).toHaveBeenCalledWith(
          'session-1',
          2,
          expect.any(String),
        );
      },
    );
  });

  it('keeps Claude launch locks and speed settlement under independent generations', () => {
    const launches = new ClaudeLaunchAttemptRegistry();
    const speeds = new SessionGenerationRegistry();
    const launch = launches.begin('session-1', { terminalPtyGeneration: 1 });
    const speed = speeds.begin('session-1');
    expect(launches.observeTerminal(terminalStatus(2))).toBeUndefined();
    expect(speeds.isCurrent(speed)).toBe(true);
    expect(launches.isCurrent(launch)).toBe(true);
    expect(launches.acceptResult(launch, 'success')).toBe(true);
    expect(launches.isCurrent(launch)).toBe(false);
  });

  it.each([
    ['#codex-login', 'browser', '正在启动浏览器登录…'],
    ['#codex-device-login-action', 'device-code', '正在启动设备码登录…'],
  ] as const)(
    'keeps %s feedback owned while a Codex login request is pending',
    async (selector, method, label) => {
      const state = codexProjectState({ requiresOpenaiAuth: true });
      type LoginResult = Awaited<ReturnType<ControlPanelApi['startCodexLogin']>>;
      const login = deferred<LoginResult>();
      await withTerminalRenderer(
        {
          getCodexProjectState: async () => state,
          getDevelopmentRuntime: async (sessionId) => ({
            cwd: 'D:\\Project',
            runtime: 'codex',
            sessionId,
          }),
          startCodexLogin: (_sessionId, requestedMethod) => {
            expect(requestedMethod).toBe(method);
            return login.promise;
          },
        },
        async (harness) => {
          harness.click(selector);
          const button = harness.query<HTMLButtonElement>(selector);
          expect(button.textContent).toBe(label);
          expect(button.disabled).toBe(true);
          expect(button.getAttribute('aria-busy')).toBe('true');

          harness.emit('onCodexState', state);
          expect(button.textContent).toBe(label);
          expect(button.disabled).toBe(true);
          expect(button.getAttribute('aria-busy')).toBe('true');

          login.reject(new Error('synthetic login failure'));
          await settle(harness);
          expect(button.getAttribute('aria-busy')).toBe('false');
        },
      );
    },
  );

  it('rejects a delayed login-start snapshot after a newer account event', async () => {
    const initial = codexProjectState({ requiresOpenaiAuth: true, revision: 1 });
    type LoginResult = Awaited<ReturnType<ControlPanelApi['startCodexLogin']>>;
    const login = deferred<LoginResult>();
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => initial,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: initial.cwd,
          runtime: 'codex',
          sessionId,
        }),
        startCodexLogin: () => login.promise,
      },
      async (harness) => {
        harness.click('#codex-login');
        harness.emit(
          'onCodexState',
          codexProjectState({
            account: { email: 'member@example.test', planType: 'plus', type: 'chatgpt' },
            requiresOpenaiAuth: true,
            revision: 3,
          }),
        );
        login.resolve({
          ok: true,
          openedBrowser: true,
          state: codexProjectState({
            login: { loginId: 'stale-login', method: 'browser', phase: 'waiting' },
            requiresOpenaiAuth: true,
            revision: 2,
          }),
        });
        await settle(harness);

        expect(harness.query('#codex-account-title').textContent).toBe('ChatGPT 账号已连接');
        expect(harness.query<HTMLButtonElement>('#codex-login').hidden).toBe(true);
        expect(harness.query<HTMLButtonElement>('#codex-cancel-login').hidden).toBe(true);
      },
    );
  });

  it('keeps Codex launch feedback owned across account-state renders', async () => {
    const state = codexProjectState();
    type LaunchResult = Awaited<ReturnType<ControlPanelApi['launchCodex']>>;
    const launch = deferred<LaunchResult>();
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => state,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
        launchCodex: () => launch.promise,
      },
      async (harness) => {
        harness.click('#codex-launch-new');
        const button = harness.query<HTMLButtonElement>('#codex-launch-new');
        expect(button.textContent).toBe('正在启动…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(harness.query('#run-agent-label').textContent).toContain('正在启动 Codex…');

        harness.emit('onCodexState', state);
        expect(button.textContent).toBe('正在启动…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        launch.reject(new Error('synthetic launch failure'));
        await settle(harness);
        expect(button.textContent).toBe('启动当前对话');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it('labels Codex login cancellation and restores only the owning operation', async () => {
    const state = codexProjectState({
      login: { method: 'browser', phase: 'waiting' },
      requiresOpenaiAuth: true,
    });
    type CancelResult = Awaited<ReturnType<ControlPanelApi['cancelCodexLogin']>>;
    const cancellation = deferred<CancelResult>();
    await withTerminalRenderer(
      {
        cancelCodexLogin: () => cancellation.promise,
        getCodexProjectState: async () => state,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
      },
      async (harness) => {
        harness.click('#codex-cancel-login');
        const button = harness.query<HTMLButtonElement>('#codex-cancel-login');
        expect(button.textContent).toBe('正在取消登录…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        const completed = codexProjectState({ requiresOpenaiAuth: true });
        cancellation.resolve({ ok: true, state: completed });
        await settle(harness);
        expect(button.textContent).toBe('取消登录');
        expect(button.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it('restores the active project after a global Codex login cancellation settles elsewhere', async () => {
    const stateA = codexProjectState({
      cwd: 'D:\\ProjectA',
      login: { method: 'browser', phase: 'waiting' },
      requiresOpenaiAuth: true,
      sessionId: 'session-a',
    });
    const stateB = codexProjectState({
      cwd: 'D:\\ProjectB',
      login: { method: 'browser', phase: 'waiting' },
      requiresOpenaiAuth: true,
      sessionId: 'session-b',
    });
    type CancelResult = Awaited<ReturnType<ControlPanelApi['cancelCodexLogin']>>;
    const cancellation = deferred<CancelResult>();
    await withTerminalRenderer(
      {
        cancelCodexLogin: () => cancellation.promise,
        getCodexProjectState: async (sessionId) => (sessionId === 'session-a' ? stateA : stateB),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? stateA.cwd : stateB.cwd,
          runtime: 'codex',
          sessionId,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
      },
      async (harness) => {
        harness.click('#codex-cancel-login');
        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);

        const activeButton = harness.query<HTMLButtonElement>('#codex-cancel-login');
        expect(activeButton.textContent).toBe('正在取消登录…');
        expect(activeButton.disabled).toBe(true);
        expect(activeButton.getAttribute('aria-busy')).toBe('true');

        const completionRevision = 2;
        const completedB = codexProjectState({
          ...stateB,
          login: { phase: 'idle' },
          revision: completionRevision,
        });
        harness.emit('onCodexState', completedB);
        cancellation.resolve({
          ok: true,
          state: codexProjectState({
            ...stateA,
            login: { phase: 'idle' },
            revision: completionRevision,
          }),
        });
        await settle(harness);

        expect(activeButton.textContent).toBe('取消登录');
        expect(activeButton.disabled).toBe(false);
        expect(activeButton.getAttribute('aria-busy')).toBe('false');
        expect(activeButton.hidden).toBe(true);
        expect(harness.query<HTMLButtonElement>('#codex-login').hidden).toBe(false);
      },
    );
  });

  it('continues the exact login-and-launch owner after the user switches projects', async () => {
    const stateA = codexProjectState({
      cwd: 'D:\\ProjectA',
      requiresOpenaiAuth: true,
      revision: 1,
      sessionId: 'session-a',
    });
    const stateB = codexProjectState({
      cwd: 'D:\\ProjectB',
      requiresOpenaiAuth: true,
      revision: 1,
      sessionId: 'session-b',
    });
    const launchCodex = vi.fn(async () => ({ ok: true, state: stateA }));
    await withTerminalRenderer(
      {
        getCodexProjectState: async (sessionId) => (sessionId === 'session-a' ? stateA : stateB),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? stateA.cwd : stateB.cwd,
          runtime: 'codex',
          sessionId,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
        launchCodex,
        startCodexLogin: async () => ({
          ok: true,
          openedBrowser: true,
          state: codexProjectState({
            ...stateA,
            login: { loginId: 'login-a', method: 'browser', phase: 'waiting' },
            revision: 2,
          }),
        }),
      },
      async (harness) => {
        harness.click('#codex-primary-action');
        await settle(harness);
        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);

        const authenticatedA = codexProjectState({
          ...stateA,
          account: { email: 'member@example.test', planType: 'plus', type: 'chatgpt' },
          revision: 3,
        });
        harness.emit('onCodexState', authenticatedA);
        harness.emit('onWorkspaceState', twoSessionWorkspace('session-a'));
        await settle(harness);
        harness.emit('onCodexState', { ...authenticatedA, revision: 4 });
        await settle(harness);

        expect(launchCodex).toHaveBeenCalledOnce();
        expect(launchCodex).toHaveBeenCalledWith('session-a', 'new');
      },
    );
  });

  it('labels Codex logout after confirmation and fences its final restoration', async () => {
    const state = codexProjectState({
      account: {
        email: 'synthetic@example.test',
        planType: 'test',
        type: 'chatgpt',
      },
      requiresOpenaiAuth: true,
    });
    type LogoutResult = Awaited<ReturnType<ControlPanelApi['logoutCodex']>>;
    const logout = deferred<LogoutResult>();
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => state,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
        logoutCodex: () => logout.promise,
      },
      async (harness) => {
        harness.click('#codex-logout');
        harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
        await harness.flush();

        const button = harness.query<HTMLButtonElement>('#codex-logout');
        expect(button.textContent).toBe('正在退出账号…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        logout.reject(new Error('synthetic logout failure'));
        await settle(harness);
        expect(button.textContent).toBe('退出 Codex 账号');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it('fences state loads and Codex launches with per-session generations', async () => {
    const registry = new SessionGenerationRegistry();
    const stale = registry.begin('session-1');
    const current = registry.begin('session-1');
    const outcome = await orchestrateSessionOperation({
      applyResult: () => true,
      registry,
      start: async () => 'late',
      token: stale,
    });
    expect(outcome).toEqual({ status: 'stale' });
    expect(registry.isCurrent(current)).toBe(true);
  });

  it('rejects delayed Claude state across runtime and PTY generations', () => {
    expect(claudeStateOwnershipIsCurrent({ ptyGeneration: 1, stateRevision: 3 }, 2, 2)).toBe(false);
    expect(claudeStateOwnershipIsCurrent({ ptyGeneration: 2, stateRevision: 3 }, 2, 2)).toBe(true);
  });

  it('lists every permission mode and routes the un-cyclable one through a relaunch', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.click('#footer-mode');
      const labels = harness.query('#footer-mode-menu').textContent ?? '';
      for (const label of [
        '手动确认',
        '自动接受编辑',
        '计划模式',
        '自动选择',
        '完全允许',
        '仅预批准',
      ]) {
        expect(labels).toContain(label);
      }
    });
  });

  it('forwards Shift+Tab from the composer so the shortcut does not depend on terminal focus', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.clearCalls();
      harness.query('#composer-input').dispatchEvent(
        new harness.dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          key: 'Tab',
          shiftKey: true,
        }),
      );
      expect(harness.method('writeTerminal')).toHaveBeenCalledWith('session-1', 1, '\u001b[Z');
    });
  });

  it('does not let an official-network preflight overwrite Claude gateway launch controls', async () => {
    const gatewayState = claudeProjectState();
    gatewayState.config = {
      ...gatewayState.config,
      baseUrl: 'https://gateway.example.test',
      provider: 'gateway',
    };
    await withTerminalRenderer(
      {
        getClaudeProjectState: async () => gatewayState,
      },
      async (harness) => {
        const run = harness.query<HTMLButtonElement>('#run-claude');
        const before = run.disabled;
        harness.emit('onNetworkPreflight', {
          checkedAt: 1,
          featureAccess: [],
          paths: [],
          probes: [],
          provider: 'anthropic-claude',
          providerLabel: 'Anthropic Claude Code',
          reasons: ['synthetic offline result'],
          riskLevel: 'high',
          riskScore: 90,
          signals: [],
          startedAt: 1,
          status: 'blocked',
          summary: 'synthetic offline result',
        });
        expect(run.disabled).toBe(before);
      },
    );
  });

  it('types Claude-generated titles in place and skips the animation for manual renames', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit(
        'onWorkspaceState',
        terminalWorkspace(terminalStatus(1, { title: 'Generated title' })),
      );
      await harness.flush();
      const label = harness.query<HTMLElement>('.conversation-item__label');
      expect(label.dataset.titleTyping).toBe('true');
    });
  });

  it('reads permission badges from xterm after screen deltas have been applied', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      control.autoAcknowledgeWrites = false;
      control.terminals[0]!.setScreen(['Claude Code', 'accept edits on']);
      harness.emit('onTerminalData', 'session-1', 1, 'delta');
      await settle(harness);
      harness.emit('onClaudePermissionModeProbe', 'session-1', 1, 9);
      expect(harness.method('reportClaudePermissionModeProbe')).not.toHaveBeenCalledWith(
        'session-1',
        1,
        9,
        expect.anything(),
      );
      control.acknowledgeNextWrite();
      await harness.flush();
      expect(harness.method('reportClaudePermissionModeProbe')).toHaveBeenCalledWith(
        'session-1',
        1,
        9,
        'acceptEdits',
      );
    });
  });

  it('answers every quit request and only questions the ones that would lose work', async () => {
    await withRenderer({}, async (harness) => {
      harness.emit('onAppQuitRequested', {
        hasBlocking: false,
        leases: [],
        requestId: 'quit-request-1',
      });
      harness.click('#quit-cancel');
      expect(harness.method('confirmQuit')).toHaveBeenLastCalledWith({
        decision: false,
        requestId: 'quit-request-1',
      });
      harness.emit('onAppQuitRequested', {
        hasBlocking: false,
        leases: [],
        requestId: 'quit-request-2',
      });
      harness.click('#quit-force');
      expect(harness.method('confirmQuit')).toHaveBeenLastCalledWith({
        decision: true,
        requestId: 'quit-request-2',
      });
      harness.emit('onAppQuitRequested', {
        hasBlocking: false,
        leases: [],
        requestId: 'quit-request-3',
      });
      harness.click('#quit-minimize');
      expect(harness.method('confirmQuit')).toHaveBeenLastCalledWith({
        decision: 'minimize',
        requestId: 'quit-request-3',
      });
    });
  });
});
