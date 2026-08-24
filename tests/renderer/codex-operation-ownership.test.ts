import { describe, expect, it, vi } from 'vitest';
import type {
  CodexProjectState,
  ControlPanelApi,
  DevelopmentRuntimeState,
  WorkspaceState,
} from '../../src/shared/contracts';
import { change, settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import { terminalStatus, terminalWorkspace } from '../helpers/renderer-terminal-fixture';

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

const siblingSessionWorkspace = (activeSessionId: 'session-a' | 'session-b'): WorkspaceState => {
  const sessionA = terminalStatus(1, {
    cwd: 'D:\\Project',
    id: 'session-a',
    title: 'Conversation A',
  });
  const sessionB = terminalStatus(1, {
    cwd: sessionA.cwd,
    id: 'session-b',
    title: 'Conversation B',
  });
  return {
    activeSessionId,
    projects: [
      {
        lastActiveAt: 2,
        missing: false,
        name: 'Project',
        open: true,
        path: sessionA.cwd,
        remembered: true,
        sessionIds: [sessionA.id, sessionB.id],
      },
    ],
    sessions: [sessionA, sessionB],
  };
};

describe('renderer Codex operation ownership', () => {
  it('keeps runtime switching owned across session renders and restores on failure', async () => {
    const runtimeSwitch = deferred<DevelopmentRuntimeState>();
    await withTerminalRenderer(
      { setDevelopmentRuntime: () => runtimeSwitch.promise },
      async (harness) => {
        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);

        const picker = harness.query<HTMLFieldSetElement>('#runtime-picker');
        expect(harness.query('#runtime-picker-label').textContent).toContain('正在切换并检查网络…');
        expect(picker.disabled).toBe(true);
        expect(picker.getAttribute('aria-busy')).toBe('true');

        harness.emit('onWorkspaceState', terminalWorkspace());
        await harness.flush();
        expect(harness.query('#runtime-picker-label').textContent).toContain('正在切换并检查网络…');
        expect(picker.disabled).toBe(true);
        expect(codex.checked).toBe(true);

        runtimeSwitch.reject(new Error('synthetic runtime switch failure'));
        await settle(harness);
        expect(harness.query('#runtime-picker-label').textContent).toContain('当前项目开发引擎');
        expect(picker.disabled).toBe(false);
        expect(picker.getAttribute('aria-busy')).toBe('false');
        expect(harness.query<HTMLInputElement>('#runtime-claude').checked).toBe(true);
      },
    );
  });

  it('does not apply a completed runtime switch to a newly active project', async () => {
    const runtimeSwitch = deferred<DevelopmentRuntimeState>();
    await withTerminalRenderer(
      {
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? 'D:\\ProjectA' : 'D:\\ProjectB',
          runtime: 'claude',
          sessionId,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
        setDevelopmentRuntime: () => runtimeSwitch.promise,
      },
      async (harness) => {
        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);
        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);
        harness.clearCalls();

        runtimeSwitch.resolve({
          cwd: 'D:\\ProjectA',
          runtime: 'codex',
          sessionId: 'session-a',
        });
        await settle(harness);

        expect(harness.method('getCodexProjectState')).not.toHaveBeenCalled();
        expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
        expect(harness.query<HTMLInputElement>('#runtime-claude').checked).toBe(true);
      },
    );
  });

  it('applies a completed runtime switch to the active sibling session in the same project', async () => {
    const runtimeSwitch = deferred<DevelopmentRuntimeState>();
    const stateB = codexProjectState({
      cwd: 'D:\\Project',
      sessionId: 'session-b',
    });
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => stateB,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'claude',
          sessionId,
        }),
        getWorkspace: async () => siblingSessionWorkspace('session-a'),
        setDevelopmentRuntime: () => runtimeSwitch.promise,
      },
      async (harness) => {
        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);
        harness.emit('onWorkspaceState', siblingSessionWorkspace('session-b'));
        await settle(harness);

        const siblingPicker = harness.query<HTMLFieldSetElement>('#runtime-picker');
        expect(harness.query('#runtime-picker-label').textContent).toContain('正在切换并检查网络…');
        expect(siblingPicker.disabled).toBe(true);
        expect(siblingPicker.getAttribute('aria-busy')).toBe('true');
        harness.clearCalls();
        const claude = harness.query<HTMLInputElement>('#runtime-claude');
        claude.checked = true;
        change(claude);
        expect(harness.method('setDevelopmentRuntime')).not.toHaveBeenCalled();
        expect(codex.checked).toBe(true);

        runtimeSwitch.resolve({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId: 'session-a',
        });
        await settle(harness);

        expect(harness.query<HTMLInputElement>('#runtime-codex').checked).toBe(true);
        expect(harness.method('getCodexProjectState')).toHaveBeenCalledWith('session-b');
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalled();
      },
    );
  });

  it('reconstructs a reserved switch after renderer reload and polls to the committed runtime', async () => {
    let runtimeReads = 0;
    await withTerminalRenderer(
      {
        getDevelopmentRuntime: async (sessionId) => {
          runtimeReads += 1;
          return runtimeReads < 3
            ? {
                cwd: 'D:\\Project',
                runtime: 'claude' as const,
                sessionId,
                switchOperation: { attempt: 41, runtime: 'codex' as const },
              }
            : {
                cwd: 'D:\\Project',
                runtime: 'codex' as const,
                sessionId,
              };
        },
      },
      async (harness) => {
        const picker = harness.query<HTMLFieldSetElement>('#runtime-picker');
        expect(harness.query('#runtime-picker-label').textContent).toContain('正在切换并检查网络…');
        expect(picker.disabled).toBe(true);
        expect(picker.getAttribute('aria-busy')).toBe('true');
        expect(harness.query<HTMLInputElement>('#runtime-codex').checked).toBe(true);
        expect(harness.document.body.dataset.agentRuntime).toBe('claude');
        harness.clearCalls();

        await new Promise((resolve) => setTimeout(resolve, 650));
        await settle(harness);

        expect(harness.method('getDevelopmentRuntime')).toHaveBeenCalledTimes(2);
        expect(harness.query('#runtime-picker-label').textContent).toContain('当前项目开发引擎');
        expect(picker.disabled).toBe(false);
        expect(picker.getAttribute('aria-busy')).toBe('false');
        expect(harness.query<HTMLInputElement>('#runtime-codex').checked).toBe(true);
        expect(harness.document.body.dataset.agentRuntime).toBe('codex');
      },
    );
  });

  it('does not project a pending runtime switch onto an unrelated project', async () => {
    await withTerminalRenderer(
      {
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? 'D:\\ProjectA' : 'D:\\ProjectB',
          runtime: 'claude',
          sessionId,
          switchOperation:
            sessionId === 'session-a' ? { attempt: 9, runtime: 'codex' as const } : undefined,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
        setDevelopmentRuntime: async (sessionId, runtime) => ({
          cwd: 'D:\\ProjectB',
          runtime,
          sessionId,
        }),
      },
      async (harness) => {
        expect(harness.query<HTMLFieldSetElement>('#runtime-picker').disabled).toBe(true);

        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);
        const picker = harness.query<HTMLFieldSetElement>('#runtime-picker');
        expect(picker.disabled).toBe(false);
        expect(picker.getAttribute('aria-busy')).toBe('false');
        expect(harness.query('#runtime-picker-label').textContent).toContain('当前项目开发引擎');
        harness.clearCalls();

        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);
        await settle(harness);

        expect(harness.method('setDevelopmentRuntime')).toHaveBeenCalledExactlyOnceWith(
          'session-b',
          'codex',
        );
      },
    );
  });

  it('does not continue Codex preparation in a different active project', async () => {
    const stateA = codexProjectState({
      cwd: 'D:\\ProjectA',
      installation: {
        installed: false,
        message: '需要安装 Codex CLI。',
        updateAvailable: false,
      },
      requiresOpenaiAuth: true,
      sessionId: 'session-a',
    });
    const stateB = codexProjectState({
      cwd: 'D:\\ProjectB',
      requiresOpenaiAuth: true,
      sessionId: 'session-b',
    });
    type InstallResult = Awaited<ReturnType<ControlPanelApi['installOrUpdateCodex']>>;
    const install = deferred<InstallResult>();
    const launchCodex = vi.fn(async () => ({ ok: true, state: stateB }));
    const startCodexLogin = vi.fn(async () => ({
      ok: true,
      openedBrowser: true,
      state: stateB,
    }));
    await withTerminalRenderer(
      {
        getCodexProjectState: async (sessionId) => (sessionId === 'session-a' ? stateA : stateB),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? stateA.cwd : stateB.cwd,
          runtime: 'codex',
          sessionId,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
        installOrUpdateCodex: () => install.promise,
        launchCodex,
        startCodexLogin,
      },
      async (harness) => {
        harness.click('#codex-primary-action');
        await harness.flush();
        expect(harness.method('installOrUpdateCodex')).toHaveBeenCalledWith('session-a', 'install');

        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);
        install.resolve({
          ok: true,
          state: codexProjectState({
            ...stateA,
            installation: {
              installed: true,
              message: 'Codex CLI 已就绪。',
              updateAvailable: false,
              version: '1.0.0',
            },
            revision: 2,
          }),
        });
        await settle(harness);

        expect(startCodexLogin).not.toHaveBeenCalled();
        expect(launchCodex).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps Codex install feedback owned across state events', async () => {
    const state = codexProjectState({
      installation: {
        installed: false,
        message: '需要安装 Codex CLI。',
        updateAvailable: false,
      },
    });
    type InstallResult = Awaited<ReturnType<ControlPanelApi['installOrUpdateCodex']>>;
    const install = deferred<InstallResult>();
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => state,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
        installOrUpdateCodex: () => install.promise,
      },
      async (harness) => {
        harness.click('#codex-install');
        const button = harness.query<HTMLButtonElement>('#codex-install');
        expect(button.textContent).toBe('正在安装…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        harness.emit('onCodexState', state);
        expect(button.textContent).toBe('正在安装…');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        install.reject(new Error('synthetic install failure'));
        await settle(harness);
        expect(button.textContent).toBe('安装');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it('locks application-global Codex installation across projects and repaints the active owner', async () => {
    const stateA = codexProjectState({
      cwd: 'D:\\ProjectA',
      installation: {
        installed: false,
        message: '需要安装 Codex CLI。',
        updateAvailable: false,
      },
      sessionId: 'session-a',
    });
    const stateB = codexProjectState({
      cwd: 'D:\\ProjectB',
      installation: {
        installed: false,
        message: '需要安装 Codex CLI。',
        updateAvailable: false,
      },
      sessionId: 'session-b',
    });
    type InstallResult = Awaited<ReturnType<ControlPanelApi['installOrUpdateCodex']>>;
    const install = deferred<InstallResult>();
    const installOrUpdateCodex = vi.fn(() => install.promise);
    await withTerminalRenderer(
      {
        getCodexProjectState: async (sessionId) => (sessionId === 'session-a' ? stateA : stateB),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? stateA.cwd : stateB.cwd,
          runtime: 'codex',
          sessionId,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
        installOrUpdateCodex,
      },
      async (harness) => {
        harness.click('#codex-install');
        expect(installOrUpdateCodex).toHaveBeenCalledOnce();

        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);
        const activeButton = harness.query<HTMLButtonElement>('#codex-install');
        expect(activeButton.textContent).toBe('正在安装…');
        expect(activeButton.disabled).toBe(true);
        expect(activeButton.getAttribute('aria-busy')).toBe('true');

        harness.click('#codex-install');
        expect(installOrUpdateCodex).toHaveBeenCalledOnce();

        install.resolve({
          ok: true,
          state: codexProjectState({
            ...stateA,
            installation: {
              installed: true,
              message: 'Codex CLI 已就绪。',
              updateAvailable: false,
              version: '1.0.0',
            },
          }),
        });
        await settle(harness);

        expect(activeButton.textContent).toBe('安装');
        expect(activeButton.disabled).toBe(false);
        expect(activeButton.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it('clears prior-project Codex busy controls when the active state load fails', async () => {
    const stateA = codexProjectState({
      cwd: 'D:\\ProjectA',
      installation: {
        installed: false,
        message: '需要安装 Codex CLI。',
        updateAvailable: false,
      },
      sessionId: 'session-a',
    });
    type InstallResult = Awaited<ReturnType<ControlPanelApi['installOrUpdateCodex']>>;
    const install = deferred<InstallResult>();
    await withTerminalRenderer(
      {
        getCodexProjectState: async (sessionId) => {
          if (sessionId === 'session-b') throw new Error('synthetic B load failure');
          return stateA;
        },
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? 'D:\\ProjectA' : 'D:\\ProjectB',
          runtime: 'codex',
          sessionId,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
        installOrUpdateCodex: () => install.promise,
      },
      async (harness) => {
        harness.click('#codex-install');
        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);
        install.reject(new Error('synthetic install failure'));
        await settle(harness);

        const button = harness.query<HTMLButtonElement>('#codex-install');
        expect(button.textContent).toBe('安装');
        expect(button.getAttribute('aria-busy')).toBe('false');
        expect(harness.query('#run-agent-label').textContent).not.toContain('正在安装');
        expect(harness.query<HTMLButtonElement>('#run-claude').getAttribute('aria-busy')).toBe(
          'false',
        );
      },
    );
  });

  it.each([
    ['install', '#codex-install', '正在安装…'],
    ['update', '#codex-install', '正在更新…'],
    ['login-browser', '#codex-login', '正在启动浏览器登录…'],
    ['login-device', '#codex-device-login-action', '正在启动设备码登录…'],
    ['cancel-login', '#codex-cancel-login', '正在取消登录…'],
    ['logout', '#codex-logout', '正在退出账号…'],
  ] as const)(
    'reconstructs the main-owned %s presentation after renderer startup',
    async (kind, ownerSelector, label) => {
      const state = codexProjectState({
        account: kind === 'logout' ? { email: 'member@example.com', type: 'chatgpt' } : undefined,
        activeOperation: { attempt: 17, kind },
        installation: {
          installed: kind !== 'install',
          message: kind === 'install' ? '需要安装 Codex CLI。' : 'Codex CLI 已就绪。',
          updateAvailable: kind === 'update',
          version: kind === 'install' ? undefined : '1.0.0',
        },
        login:
          kind === 'cancel-login'
            ? { loginId: 'login-1', method: 'browser', phase: 'waiting' }
            : { phase: 'idle' },
        requiresOpenaiAuth: ['login-browser', 'login-device', 'cancel-login'].includes(kind),
        revision: 17,
      });
      await withTerminalRenderer(
        {
          getCodexProjectState: async () => state,
          getDevelopmentRuntime: async (sessionId) => ({
            cwd: state.cwd,
            runtime: 'codex',
            sessionId,
          }),
        },
        async (harness) => {
          const operationControls = [
            '#codex-install',
            '#codex-login',
            '#codex-device-login-action',
            '#codex-cancel-login',
            '#codex-logout',
          ];
          for (const selector of operationControls) {
            const button = harness.query<HTMLButtonElement>(selector);
            expect(button.disabled).toBe(true);
            expect(button.getAttribute('aria-busy')).toBe(String(selector === ownerSelector));
          }
          expect(harness.query(ownerSelector).textContent).toBe(label);
          expect(harness.query('#codex-primary-action').textContent).toBe(label);
          expect(
            harness.query<HTMLButtonElement>('#codex-primary-action').getAttribute('aria-busy'),
          ).toBe('false');
          expect(harness.query<HTMLButtonElement>('#run-claude').getAttribute('aria-busy')).toBe(
            'false',
          );
        },
      );
    },
  );

  it('restores local ownership after newer main ownership clears before IPC settlement', async () => {
    const initial = codexProjectState({
      installation: {
        installed: false,
        message: '需要安装 Codex CLI。',
        updateAvailable: false,
      },
      requiresOpenaiAuth: true,
    });
    type InstallResult = Awaited<ReturnType<ControlPanelApi['installOrUpdateCodex']>>;
    const install = deferred<InstallResult>();
    const installOrUpdateCodex = vi.fn(() => install.promise);
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => initial,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: initial.cwd,
          runtime: 'codex',
          sessionId,
        }),
        installOrUpdateCodex,
      },
      async (harness) => {
        harness.click('#codex-install');
        expect(harness.query('#codex-install').textContent).toBe('正在安装…');

        const mainOwned = codexProjectState({
          account: { email: 'member@example.com', type: 'chatgpt' },
          activeOperation: { attempt: 21, kind: 'logout' },
          revision: 2,
        });
        harness.emit('onCodexState', mainOwned);
        const logout = harness.query<HTMLButtonElement>('#codex-logout');
        expect(logout.textContent).toBe('正在退出账号…');
        expect(logout.disabled).toBe(true);
        expect(logout.getAttribute('aria-busy')).toBe('true');
        expect(harness.query('#codex-install').textContent).toBe('安装');
        expect(harness.query<HTMLButtonElement>('#codex-install').getAttribute('aria-busy')).toBe(
          'false',
        );

        const completed = codexProjectState({
          ...mainOwned,
          activeOperation: undefined,
          revision: 3,
        });
        harness.emit('onCodexState', completed);
        const installButton = harness.query<HTMLButtonElement>('#codex-install');
        expect(installButton.textContent).toBe('正在安装…');
        expect(installButton.disabled).toBe(true);
        expect(installButton.getAttribute('aria-busy')).toBe('true');

        installButton.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true }));
        await harness.flush();
        expect(installOrUpdateCodex).toHaveBeenCalledOnce();

        harness.emit('onCodexState', mainOwned);
        expect(installButton.textContent).toBe('正在安装…');
        expect(installButton.disabled).toBe(true);
        expect(installButton.getAttribute('aria-busy')).toBe('true');

        install.reject(new Error('synthetic local install failure'));
        await settle(harness);
        expect(installButton.textContent).toBe('安装');
        expect(installButton.disabled).toBe(false);
        expect(installButton.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it('preserves queued login auto-launch and blocks duplicate interaction until IPC settlement', async () => {
    const initial = codexProjectState({ requiresOpenaiAuth: true, revision: 1 });
    const signedIn = codexProjectState({
      account: { email: 'member@example.com', type: 'chatgpt' },
      requiresOpenaiAuth: true,
      revision: 3,
    });
    type LoginResult = Awaited<ReturnType<ControlPanelApi['startCodexLogin']>>;
    const login = deferred<LoginResult>();
    const startCodexLogin = vi.fn(() => login.promise);
    const launchCodex = vi.fn(async () => ({
      ok: true,
      state: codexProjectState({ ...signedIn, active: true, revision: 4 }),
    }));
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => initial,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: initial.cwd,
          runtime: 'codex',
          sessionId,
        }),
        launchCodex,
        startCodexLogin,
      },
      async (harness) => {
        harness.click('#codex-primary-action');
        expect(startCodexLogin).toHaveBeenCalledOnce();

        harness.emit('onCodexState', signedIn);
        const primary = harness.query<HTMLButtonElement>('#codex-primary-action');
        expect(primary.textContent).toBe('正在启动浏览器登录…');
        expect(primary.disabled).toBe(true);

        primary.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true }));
        await harness.flush();
        expect(startCodexLogin).toHaveBeenCalledOnce();
        expect(launchCodex).not.toHaveBeenCalled();

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

        expect(launchCodex).toHaveBeenCalledExactlyOnceWith('session-1', 'new');
      },
    );
  });

  it('keeps a waiting main login from being superseded by a hidden second login action', async () => {
    const initial = codexProjectState({ requiresOpenaiAuth: true });
    const waiting = codexProjectState({
      login: {
        loginId: 'login-1',
        method: 'device-code',
        phase: 'waiting',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'https://auth.openai.com/device',
      },
      requiresOpenaiAuth: true,
      revision: 2,
    });
    const signedIn = codexProjectState({
      account: { email: 'member@example.com', type: 'chatgpt' },
      requiresOpenaiAuth: true,
      revision: 3,
    });
    type LoginResult = Awaited<ReturnType<ControlPanelApi['startCodexLogin']>>;
    const firstLogin = deferred<LoginResult>();
    const startCodexLogin = vi.fn(() => firstLogin.promise);
    const launchCodex = vi.fn(async () => ({ ok: true, state: signedIn }));
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => initial,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: initial.cwd,
          runtime: 'codex',
          sessionId,
        }),
        launchCodex,
        startCodexLogin,
      },
      async (harness) => {
        harness.click('#codex-device-login-action');
        expect(startCodexLogin).toHaveBeenCalledOnce();

        harness.emit('onCodexState', waiting);
        const hiddenLoginAction = harness.query<HTMLButtonElement>('#codex-device-login-action');
        expect(hiddenLoginAction.hidden).toBe(true);
        hiddenLoginAction.click();
        await harness.flush();
        expect(startCodexLogin).toHaveBeenCalledOnce();

        harness.emit('onCodexState', signedIn);
        await settle(harness);
        expect(launchCodex).not.toHaveBeenCalled();

        firstLogin.resolve({ ok: true, openedBrowser: true, state: waiting });
        await settle(harness);
        expect(launchCodex).toHaveBeenCalledExactlyOnceWith('session-1', 'new');
      },
    );
  });

  it('rejects a conflicting Codex snapshot with the same revision', async () => {
    const signedOut = codexProjectState({ requiresOpenaiAuth: true, revision: 9 });
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => signedOut,
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: signedOut.cwd,
          runtime: 'codex',
          sessionId,
        }),
      },
      async (harness) => {
        expect(harness.query('#codex-account-title').textContent).toBe('尚未登录 ChatGPT');
        expect(harness.query<HTMLElement>('#codex-logout').hidden).toBe(true);

        harness.emit(
          'onCodexState',
          codexProjectState({
            account: { email: 'stale@example.com', type: 'chatgpt' },
            requiresOpenaiAuth: true,
            revision: signedOut.revision,
          }),
        );

        expect(harness.query('#codex-account-title').textContent).toBe('尚未登录 ChatGPT');
        expect(harness.query<HTMLElement>('#codex-logout').hidden).toBe(true);
      },
    );
  });
});
