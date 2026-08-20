import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { Registry } from '../../src/main/infra/registry';
import { createMainState } from '../../src/main/ipc/context';
import { CHANNELS } from '../../src/shared/ipc/channels';
import type { WorkspaceState } from '../../src/shared/contracts';
import { rendererStyles } from '../helpers/renderer-css';
import { createIpcHarness } from '../helpers/ipc-harness';
import {
  createTestMainServiceRegistry,
  registerTestService,
} from '../helpers/main-service-registry';
import { createRendererHarness, type RendererHarness } from '../helpers/renderer-harness';

const renderers: RendererHarness[] = [];

const emptyWorkspace: WorkspaceState = {
  activeSessionId: '',
  projects: [],
  sessions: [],
};

/*
 * Each `await Promise.resolve()` lets the queue drain one link; the quit cleanup chain (close →
 * release → terminate → budget race → quit) needs more links than two rounds can cover.
 */
const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

const installElectronMock = () => {
  const ipc = createIpcHarness();
  const appListeners = new Map<string, (...args: unknown[]) => void>();
  const app = {
    exit: vi.fn(),
    getAppPath: vi.fn(() => 'C:\\claudedock-test'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      appListeners.set(event, listener);
    }),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setLoginItemSettings: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  };
  const electron = {
    app,
    BrowserWindow: {
      fromWebContents: vi.fn(() => undefined),
    },
    clipboard: {
      readText: vi.fn(() => ''),
      writeText: vi.fn(),
    },
    ipcMain: ipc.ipcMain,
    shell: { openExternal: vi.fn(async () => undefined) },
  };
  vi.doMock('electron', () => electron);
  return { app, appListeners, electron, ipc };
};

type QuitServiceOverrides = Partial<
  Record<
    | 'busyRegistry'
    | 'claudePermissionBridge'
    | 'claudeRuntime'
    | 'codexRuntime'
    | 'downloadEngine'
    | 'managedChatGptGateway'
    | 'nativeConversationService'
    | 'runtimeProcessRegistry',
    unknown
  >
>;

const createQuitServices = async (overrides: QuitServiceOverrides = {}): Promise<Registry> => {
  const services = await createTestMainServiceRegistry();
  const {
    BUSY_REGISTRY,
    CLAUDE_PERMISSION_BRIDGE,
    CLAUDE_RUNTIME,
    CODEX_RUNTIME,
    DOWNLOAD_ENGINE,
    MANAGED_CHATGPT_GATEWAY,
    NATIVE_CONVERSATION_SERVICE,
    RUNTIME_PROCESS_REGISTRY,
  } = await import('../../src/main/infra/service-tokens');
  registerTestService(
    services,
    BUSY_REGISTRY,
    (overrides.busyRegistry ?? new BusyRegistry()) as never,
  );
  registerTestService(
    services,
    CLAUDE_PERMISSION_BRIDGE,
    (overrides.claudePermissionBridge ?? { fallbackPending: vi.fn(), shutdown: vi.fn() }) as never,
  );
  registerTestService(
    services,
    CLAUDE_RUNTIME,
    (overrides.claudeRuntime ?? { setTheme: vi.fn(), shutdown: vi.fn() }) as never,
  );
  registerTestService(
    services,
    CODEX_RUNTIME,
    (overrides.codexRuntime ?? { dispose: vi.fn() }) as never,
  );
  registerTestService(
    services,
    DOWNLOAD_ENGINE,
    (overrides.downloadEngine ?? { flushJournal: vi.fn() }) as never,
  );
  registerTestService(
    services,
    MANAGED_CHATGPT_GATEWAY,
    (overrides.managedChatGptGateway ?? { shutdown: vi.fn() }) as never,
  );
  registerTestService(
    services,
    NATIVE_CONVERSATION_SERVICE,
    (overrides.nativeConversationService ?? {
      activeIds: vi.fn(() => []),
      closeAll: vi.fn(async () => undefined),
    }) as never,
  );
  registerTestService(
    services,
    RUNTIME_PROCESS_REGISTRY,
    (overrides.runtimeProcessRegistry ?? {
      list: vi.fn(() => []),
      stop: vi.fn(),
      terminateAll: vi.fn(async () => undefined),
    }) as never,
  );
  return services;
};

const setMainWindow = async (services: Registry, window: Electron.BrowserWindow): Promise<void> => {
  const { MAIN_WINDOW } = await import('../../src/main/infra/service-tokens');
  services.resolve(MAIN_WINDOW).current = window;
};

const createQuitDependencies = (services: Registry) => {
  const state = createMainState();
  const workspace = {
    getState: vi.fn(() => emptyWorkspace),
    shutdown: vi.fn(),
  };
  const chatService = { shutdown: vi.fn() };
  const nativeAttachmentStore = { releaseConversation: vi.fn(async () => undefined) };
  const showMainWindow = vi.fn();
  const sweepPowershellTrees = vi.fn();
  return {
    chatService,
    nativeAttachmentStore,
    services,
    showMainWindow,
    state,
    sweepPowershellTrees,
    workspace,
  };
};

afterEach(async () => {
  await Promise.all(renderers.splice(0).map((renderer) => renderer.cleanup()));
  vi.useRealTimers();
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('quit confirmation handshake', () => {
  it('bounces an unlatched before-quit through one controller and tears down only after latching', async () => {
    const { appListeners } = installElectronMock();
    const downloadEngine = { flushJournal: vi.fn() };
    const services = await createQuitServices({
      claudePermissionBridge: { shutdown: vi.fn() },
      downloadEngine,
      runtimeProcessRegistry: { stop: vi.fn() },
    });
    const state = createMainState();
    const quit = {
      requestQuit: vi.fn(),
      shutdownRuntimeForQuit: vi.fn(),
    };
    const terminalOutputBatcher = { dispose: vi.fn() };
    const pending = new Map([
      [
        1,
        {
          ptyGeneration: 1,
          resolve: vi.fn(),
          sessionId: 'session-1',
          timer: setTimeout(() => undefined, 60_000),
        },
      ],
    ]);
    const { registerAppLifecycle } = await import('../../src/main/app/lifecycle');

    registerAppLifecycle({
      effects: {
        allowApplicationUpdates: false,
        allowExternalRoutingWrites: false,
        allowPluginMutations: false,
        allowRealRuntimes: false,
        restoreWorkspace: false,
        singleInstanceLock: true,
        tray: false,
      },
      onReady: vi.fn(async () => undefined),
      pendingPermissionModeProbes: pending,
      quit: quit as never,
      services,
      showMainWindow: vi.fn(),
      state,
      terminalOutputBatcher: terminalOutputBatcher as never,
    });

    const beforeQuit = appListeners.get('before-quit');
    const firstEvent = { preventDefault: vi.fn() };
    beforeQuit?.(firstEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(quit.requestQuit).toHaveBeenCalledTimes(1);
    expect(quit.shutdownRuntimeForQuit).not.toHaveBeenCalled();

    state.isQuitting = true;
    const latchedEvent = { preventDefault: vi.fn() };
    beforeQuit?.(latchedEvent);
    expect(latchedEvent.preventDefault).not.toHaveBeenCalled();
    expect(downloadEngine.flushJournal).toHaveBeenCalledTimes(1);
    expect(terminalOutputBatcher.dispose).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    expect(quit.shutdownRuntimeForQuit).toHaveBeenCalledTimes(1);
  });

  it('sweeps spawned PowerShell trees and force-exits through the watchdog if the quit stalls', async () => {
    vi.useFakeTimers();
    const { app, appListeners } = installElectronMock();
    const services = await createQuitServices();
    const dependencies = createQuitDependencies(services);
    const sweepPowershellTrees = vi.fn();
    const { createQuitController, registerAppLifecycle } =
      await import('../../src/main/app/lifecycle');
    const quit = createQuitController({ ...dependencies, sweepPowershellTrees } as never);
    registerAppLifecycle({
      effects: {
        allowApplicationUpdates: false,
        allowExternalRoutingWrites: false,
        allowPluginMutations: false,
        allowRealRuntimes: false,
        restoreWorkspace: false,
        singleInstanceLock: true,
        tray: false,
      },
      onReady: vi.fn(async () => undefined),
      pendingPermissionModeProbes: new Map(),
      quit,
      services,
      showMainWindow: vi.fn(),
      state: dependencies.state,
      terminalOutputBatcher: { dispose: vi.fn() } as never,
    });

    await quit.beginControlledQuit(false);

    expect(sweepPowershellTrees).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dependencies.state.isQuitting).toBe(true);

    const beforeQuit = appListeners.get('before-quit');
    beforeQuit?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it('leaves immediately when a duplicate launch cannot own the single-instance lock', async () => {
    const { app } = installElectronMock();
    app.requestSingleInstanceLock.mockReturnValue(false);
    const state = createMainState();
    const { registerAppLifecycle } = await import('../../src/main/app/lifecycle');

    registerAppLifecycle({
      effects: {
        allowApplicationUpdates: false,
        allowExternalRoutingWrites: false,
        allowPluginMutations: false,
        allowRealRuntimes: false,
        restoreWorkspace: false,
        singleInstanceLock: true,
        tray: false,
      },
      onReady: vi.fn(async () => undefined),
      pendingPermissionModeProbes: new Map(),
      quit: { requestQuit: vi.fn(), shutdownRuntimeForQuit: vi.fn() } as never,
      services: await createTestMainServiceRegistry(),
      showMainWindow: vi.fn(),
      state,
      terminalOutputBatcher: { dispose: vi.fn() } as never,
    });

    expect(state.isQuitting).toBe(true);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('asks a healthy renderer with both registry and live-terminal leases', async () => {
    vi.useFakeTimers();
    const { ipc } = installElectronMock();
    const busyRegistry = new BusyRegistry();
    const services = await createQuitServices({ busyRegistry });
    await setMainWindow(services, {
      isDestroyed: () => false,
      webContents: ipc.webContents,
    } as Electron.BrowserWindow);
    busyRegistry.acquire({
      cancellable: false,
      id: 'install:active',
      kind: 'install',
      label: '正在安装',
      severity: 'blocking',
    });
    const dependencies = createQuitDependencies(services);
    dependencies.workspace.getState.mockReturnValue({
      activeSessionId: 'session-1',
      projects: [],
      sessions: [
        {
          cwd: 'C:\\project',
          id: 'session-1',
          phase: 'running',
          ptyGeneration: 1,
          shell: 'powershell.exe',
          title: '开发终端',
        },
      ],
    });
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    quit.requestQuit();

    expect(dependencies.showMainWindow).toHaveBeenCalledTimes(1);
    expect(dependencies.state.quitConfirmationPending).toBe(true);
    expect(ipc.messages.at(-1)).toEqual({
      args: [
        {
          hasBlocking: true,
          leases: [
            expect.objectContaining({ id: 'install:active' }),
            expect.objectContaining({ id: 'terminal:session-1', severity: 'blocking' }),
          ],
        },
      ],
      channel: CHANNELS.APP_QUIT_REQUESTED,
      direction: 'main-to-renderer',
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('forces cleanup on a second request or after an unacknowledged delivery timeout', async () => {
    vi.useFakeTimers();
    const { app, ipc } = installElectronMock();
    const runtimeProcessRegistry = {
      list: vi.fn(() => []),
      stop: vi.fn(),
      terminateAll: vi.fn(async () => undefined),
    };
    const services = await createQuitServices({ runtimeProcessRegistry });
    await setMainWindow(services, {
      isDestroyed: () => false,
      webContents: ipc.webContents,
    } as Electron.BrowserWindow);
    const first = createQuitDependencies(services);
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(first as never);

    quit.requestQuit();
    quit.requestQuit();
    await flushPromises();
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(first.state.isQuitting).toBe(true);

    const timeoutServices = await createQuitServices({ runtimeProcessRegistry });
    await setMainWindow(timeoutServices, {
      isDestroyed: () => false,
      webContents: ipc.webContents,
    } as Electron.BrowserWindow);
    const timed = createQuitDependencies(timeoutServices);
    const timedQuit = createQuitController(timed as never);
    timedQuit.requestQuit();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(timed.state.isQuitting).toBe(true);
  });

  it('asks for retry when process cleanup cannot prove a safe shutdown', async () => {
    const { app, ipc } = installElectronMock();
    const runtimeProcessRegistry = {
      list: vi
        .fn()
        .mockReturnValueOnce([
          {
            sessionId: 'session-1',
            view: { name: 'node.exe', pid: 4242, processKey: '4242:1' },
          },
        ])
        .mockReturnValue([]),
      stop: vi.fn(),
      terminateAll: vi
        .fn()
        .mockRejectedValueOnce(new Error('scan failed'))
        .mockResolvedValue(undefined),
    };
    const services = await createQuitServices({ runtimeProcessRegistry });
    await setMainWindow(services, {
      isDestroyed: () => false,
      webContents: ipc.webContents,
    } as Electron.BrowserWindow);
    const dependencies = createQuitDependencies(services);
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    await quit.beginControlledQuit(false);
    expect(app.quit).not.toHaveBeenCalled();
    expect(dependencies.state.quitResidualConfirmationPending).toBe(true);
    expect(ipc.messages.at(-1)).toEqual({
      args: [
        expect.objectContaining({
          hasBlocking: true,
          runtimeCleanupFailed: true,
        }),
      ],
      channel: CHANNELS.APP_QUIT_REQUESTED,
      direction: 'main-to-renderer',
    });

    const { registerAppIpc } = await import('../../src/main/ipc/app');
    registerAppIpc({
      advancedSettingsStore: { get: vi.fn() } as never,
      appPreferencesStore: { get: vi.fn(), set: vi.fn() } as never,
      applyWindowTheme: vi.fn(),
      artifactService: { getState: vi.fn(() => ({ allowed: true })) } as never,
      beginControlledQuit: quit.beginControlledQuit,
      chooseDirectory: vi.fn(),
      guards: { validateSender: vi.fn() },
      hideMainWindowToTray: vi.fn(),
      services,
      state: dependencies.state,
      workspace: {} as never,
      workspaceStore: { getTheme: vi.fn() } as never,
    });
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, 'retry');
    await flushPromises();

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dependencies.state.isQuitting).toBe(true);
  });

  it('accepts only affirmative IPC decisions, clears delivery timers, and validates minimize', async () => {
    vi.useFakeTimers();
    const { ipc } = installElectronMock();
    const state = createMainState();
    const services = await createQuitServices();
    const beginControlledQuit = vi.fn(async () => undefined);
    const hideMainWindowToTray = vi.fn();
    const validateSender = vi.fn();
    const { registerAppIpc } = await import('../../src/main/ipc/app');
    registerAppIpc({
      advancedSettingsStore: { get: vi.fn() } as never,
      appPreferencesStore: { get: vi.fn(), set: vi.fn() } as never,
      applyWindowTheme: vi.fn(),
      artifactService: { getState: vi.fn(() => ({ allowed: true })) } as never,
      beginControlledQuit,
      chooseDirectory: vi.fn(),
      guards: { validateSender },
      hideMainWindowToTray,
      services,
      state,
      workspace: {} as never,
      workspaceStore: { getTheme: vi.fn() } as never,
    });

    state.quitConfirmationPending = true;
    state.quitConfirmationTimer = setTimeout(() => undefined, 3_000);
    ipc.sendFromRenderer(CHANNELS.APP_QUIT_REQUEST_RECEIVED);
    expect(state.quitConfirmationTimer).toBeUndefined();

    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, false);
    expect(state.quitConfirmationPending).toBe(false);
    expect(beginControlledQuit).not.toHaveBeenCalled();

    state.quitConfirmationPending = true;
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, true);
    expect(beginControlledQuit).toHaveBeenCalledWith(false);

    state.quitResidualConfirmationPending = true;
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, true);
    expect(beginControlledQuit).toHaveBeenLastCalledWith(true);

    ipc.sendFromRenderer(CHANNELS.APP_MINIMIZE_TO_TRAY);
    expect(hideMainWindowToTray).toHaveBeenCalledTimes(1);
    expect(validateSender).toHaveBeenCalledTimes(5);
  });

  it('latches an OS session end and routes window close through the selected policy', async () => {
    const windowListeners = new Map<string, (...args: unknown[]) => void>();
    const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
    const fakeWindow = {
      focus: vi.fn(),
      hide: vi.fn(),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      loadFile: vi.fn(async () => undefined),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        windowListeners.set(event, listener);
      }),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        windowListeners.set(event, listener);
      }),
      restore: vi.fn(),
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn(),
      show: vi.fn(),
      webContents: {
        getURL: vi.fn(() => 'file:///renderer/index.html'),
        isLoading: vi.fn(() => false),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          webContentsListeners.set(event, listener);
        }),
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
    };
    const BrowserWindow = vi.fn(function () {
      return fakeWindow;
    });
    vi.doMock('electron', () => ({
      app: { getAppPath: vi.fn(() => 'C:\\claudedock-test') },
      BrowserWindow,
    }));
    const downloadEngine = { flushJournal: vi.fn() };
    const services = await createQuitServices({ downloadEngine });
    const state = createMainState();
    state.quitConfirmationPending = true;
    state.quitConfirmationTimer = setTimeout(() => undefined, 60_000);
    const requestQuit = vi.fn();
    const preferences = { closeBehavior: 'exit' };
    const { createWindowController } = await import('../../src/main/app/window');
    const controller = createWindowController({
      appPreferencesStore: { get: vi.fn(() => preferences), set: vi.fn() } as never,
      requestQuit,
      services,
      state,
      workspaceStore: { getTheme: vi.fn(() => undefined) } as never,
    });
    await controller.createWindow();

    windowListeners.get('session-end')?.();
    expect(downloadEngine.flushJournal).toHaveBeenCalledTimes(1);
    expect(state.isQuitting).toBe(true);
    expect(state.quitConfirmationPending).toBe(false);
    expect(state.quitConfirmationTimer).toBeUndefined();

    state.isQuitting = false;
    const closeEvent = { preventDefault: vi.fn() };
    windowListeners.get('close')?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestQuit).toHaveBeenCalledTimes(1);

    preferences.closeBehavior = 'tray';
    windowListeners.get('close')?.({ preventDefault: vi.fn() });
    expect(fakeWindow.hide).toHaveBeenCalledTimes(1);
  });

  it('acknowledges preload delivery before notifying, and sends every decision through IPC', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcRenderer: ipc.ipcRenderer,
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const { appBridge } = await import('../../src/preload/bridges/app');
    const observedMessageCounts: number[] = [];
    const unsubscribe = appBridge.onAppQuitRequested(() => {
      observedMessageCounts.push(ipc.messages.length);
    });

    ipc.emitFromMain(CHANNELS.APP_QUIT_REQUESTED, { hasBlocking: false, leases: [] });
    expect(observedMessageCounts).toEqual([2]);
    expect(ipc.messages[1]).toEqual({
      args: [],
      channel: CHANNELS.APP_QUIT_REQUEST_RECEIVED,
      direction: 'renderer-to-main',
    });

    appBridge.confirmQuit(false);
    appBridge.confirmQuit('retry');
    appBridge.confirmQuit(true);
    appBridge.minimizeToTray();
    expect(ipc.messages.slice(2).map(({ args, channel }) => ({ args, channel }))).toEqual([
      { args: [false], channel: CHANNELS.APP_CONFIRM_QUIT },
      { args: ['retry'], channel: CHANNELS.APP_CONFIRM_QUIT },
      { args: [true], channel: CHANNELS.APP_CONFIRM_QUIT },
      { args: [], channel: CHANNELS.APP_MINIMIZE_TO_TRAY },
    ]);

    unsubscribe();
    ipc.emitFromMain(CHANNELS.APP_QUIT_REQUESTED, { hasBlocking: false, leases: [] });
    expect(observedMessageCounts).toEqual([2]);
  });

  it('registers renderer conversation work as one idempotently released blocking lease', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const services = await createQuitServices({
      busyRegistry: new BusyRegistry(),
    });
    const state = createMainState();
    const validateSender = vi.fn();
    const { registerBusyIpc } = await import('../../src/main/ipc/busy');
    registerBusyIpc({ guards: { validateSender }, services, state });

    const first = await ipc.invoke(CHANNELS.BUSY_SET_CONVERSATION, true);
    const second = await ipc.invoke(CHANNELS.BUSY_SET_CONVERSATION, true);
    expect(first).toEqual([
      expect.objectContaining({
        id: 'conversation:renderer',
        kind: 'conversation',
        severity: 'blocking',
      }),
    ]);
    expect(second).toHaveLength(1);

    expect(await ipc.invoke(CHANNELS.BUSY_SET_CONVERSATION, false)).toEqual([]);
    expect(await ipc.invoke(CHANNELS.BUSY_LIST)).toEqual([]);
    expect(validateSender).toHaveBeenCalledTimes(4);
  });

  it('renders a task-aware keyboard-safe dialog and returns safe, retry, and force actions', async () => {
    const renderer = await createRendererHarness();
    renderers.push(renderer);
    renderer.clearCalls();
    const dialog = renderer.query<HTMLDialogElement>('#quit-confirmation-dialog');
    const minimize = renderer.query<HTMLButtonElement>('#quit-minimize');
    const force = renderer.query<HTMLButtonElement>('#quit-force');
    const cancel = renderer.query<HTMLButtonElement>('#quit-cancel');

    expect(minimize.autofocus).toBe(true);
    expect(
      [minimize, force, cancel].map((button) =>
        Array.from(button.parentElement?.children ?? []).indexOf(button),
      ),
    ).toEqual([0, 1, 2]);

    renderer.emit('onAppQuitRequested', {
      hasBlocking: true,
      leases: [
        {
          cancellable: false,
          id: 'install:critical',
          kind: 'install',
          label: '关键安装正在提交',
          severity: 'blocking',
        },
      ],
    });
    expect(dialog.open).toBe(true);
    expect(renderer.query('#quit-confirmation-title').textContent).toBe(
      '有操作正在进行，不建议退出',
    );
    expect(renderer.query('#quit-confirmation-list').textContent).toContain('关键安装正在提交');
    expect(renderer.query('#quit-confirmation-list').textContent).toContain('中断会留下不完整状态');
    expect(renderer.document.activeElement).toBe(minimize);

    minimize.click();
    expect(renderer.method('confirmQuit')).toHaveBeenLastCalledWith(false);
    expect(renderer.method('minimizeToTray')).toHaveBeenCalledTimes(1);

    renderer.emit('onAppQuitRequested', {
      hasBlocking: true,
      leases: [],
      runtimeCleanupFailed: true,
    });
    expect(minimize.textContent).toBe('重试安全清理');
    expect(cancel.hidden).toBe(true);
    minimize.click();
    expect(renderer.method('confirmQuit')).toHaveBeenLastCalledWith('retry');
    expect(renderer.method('minimizeToTray')).toHaveBeenCalledTimes(1);

    renderer.emit('onAppQuitRequested', { hasBlocking: false, leases: [] });
    force.click();
    expect(renderer.method('confirmQuit')).toHaveBeenLastCalledWith(true);

    renderer.emit('onAppQuitRequested', { hasBlocking: false, leases: [] });
    const cancelEvent = new renderer.dom.window.Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(renderer.method('confirmQuit')).toHaveBeenLastCalledWith(false);

    expect(dialog.classList.contains('popover')).toBe(true);
    expect(rendererStyles).toContain('.quit-confirmation-dialog');
    expect(rendererStyles).toMatch(
      /dialog\.popover::backdrop \{[^}]*?overlay var\(--dur-exit\) allow-discrete,[^}]*?display var\(--dur-exit\) allow-discrete;/,
    );
    expect(rendererStyles).toMatch(
      /@starting-style \{[\s\S]*?dialog\.popover\[open\][\s\S]*?dialog\.popover\[open\]::backdrop/,
    );
  });
});
