import { describe, expect, it, vi } from 'vitest';
import type {
  CodexProjectState,
  ControlPanelApi,
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

describe('renderer Codex operation ownership', () => {
  it('owns the global next-conversation preference and restores it on save failure', async () => {
    const preferenceSave = deferred<'claude' | 'codex'>();
    await withTerminalRenderer(
      { setNextDevelopmentRuntime: () => preferenceSave.promise },
      async (harness) => {
        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);

        const picker = harness.query<HTMLFieldSetElement>('#runtime-picker');
        expect(harness.query('#runtime-picker-label').textContent).toContain(
          '正在保存下次新建使用的引擎…',
        );
        expect(picker.disabled).toBe(true);
        expect(picker.getAttribute('aria-busy')).toBe('true');

        harness.emit('onWorkspaceState', terminalWorkspace());
        await harness.flush();
        expect(harness.query('#runtime-picker-label').textContent).toContain(
          '正在保存下次新建使用的引擎…',
        );
        expect(picker.disabled).toBe(true);
        expect(codex.checked).toBe(true);

        preferenceSave.reject(new Error('synthetic preference save failure'));
        await settle(harness);
        expect(harness.query('#runtime-picker-label').textContent).toContain('新建项目开发引擎');
        expect(picker.disabled).toBe(false);
        expect(picker.getAttribute('aria-busy')).toBe('false');
        expect(harness.query<HTMLInputElement>('#runtime-claude').checked).toBe(true);
      },
    );
  });

  it('keeps the next-conversation engine global when the active project changes', async () => {
    const preferenceSave = deferred<'claude' | 'codex'>();
    await withTerminalRenderer(
      {
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: sessionId === 'session-a' ? 'D:\\ProjectA' : 'D:\\ProjectB',
          runtime: 'claude',
          sessionId,
        }),
        getWorkspace: async () => twoSessionWorkspace('session-a'),
        setNextDevelopmentRuntime: () => preferenceSave.promise,
      },
      async (harness) => {
        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);
        harness.emit('onWorkspaceState', twoSessionWorkspace('session-b'));
        await settle(harness);
        expect(harness.method('setNextDevelopmentRuntime')).toHaveBeenCalledWith('codex');
        harness.clearCalls();

        preferenceSave.resolve('codex');
        await settle(harness);

        expect(harness.method('getCodexProjectState')).not.toHaveBeenCalled();
        expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
        expect(harness.query<HTMLInputElement>('#runtime-codex').checked).toBe(true);
        expect(harness.document.body.dataset.agentRuntime).toBe('claude');
      },
    );
  });

  it('offers the next-conversation engine even when no project is active', async () => {
    await withTerminalRenderer(
      {
        getNextDevelopmentRuntime: async () => 'codex',
        getWorkspace: async () => ({ activeSessionId: '', projects: [], sessions: [] }),
      },
      async (harness) => {
        await settle(harness);
        const picker = harness.query<HTMLFieldSetElement>('#runtime-picker');
        expect(picker.disabled).toBe(false);
        expect(harness.query<HTMLInputElement>('#runtime-codex').checked).toBe(true);
        expect(harness.query('#runtime-summary-value').textContent).toContain('下一个对话');
      },
    );
  });

  it('does not let a legacy project switch operation overwrite the global next preference', async () => {
    await withTerminalRenderer(
      {
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'claude',
          sessionId,
          switchOperation: { attempt: 41, runtime: 'codex' },
        }),
        getNextDevelopmentRuntime: async () => 'claude',
      },
      async (harness) => {
        await settle(harness);
        const picker = harness.query<HTMLFieldSetElement>('#runtime-picker');
        expect(picker.disabled).toBe(false);
        expect(harness.query<HTMLInputElement>('#runtime-claude').checked).toBe(true);
        expect(harness.query('#runtime-picker-label').textContent).toContain('新建项目开发引擎');
      },
    );
  });

  it('continues Codex preparation for its owning session after another project becomes active', async () => {
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

        expect(startCodexLogin).toHaveBeenCalledExactlyOnceWith('session-a', 'browser');
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
        await harness.flush();
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
