import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { Registry } from '../../src/main/infra/registry';
import { createMainState } from '../../src/main/ipc/context';
import { CHANNELS } from '../../src/shared/ipc/channels';
import type { WorkspaceState } from '../../src/shared/contracts';
import { createIpcHarness } from '../helpers/ipc-harness';
import {
  createTestMainServiceRegistry,
  registerTestService,
} from '../helpers/main-service-registry';
import { createQuitServices, installQuitElectronMock } from '../helpers/quit-confirmation';

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
  for (let i = 0; i < 16; i += 1) {
    await Promise.resolve();
  }
};

const setMainWindow = async (services: Registry, window: Electron.BrowserWindow): Promise<void> => {
  const { MAIN_WINDOW } = await import('../../src/main/infra/service-tokens');
  services.resolve(MAIN_WINDOW).current = window;
};

const setHealthyMainWindow = (
  services: Registry,
  webContents: Electron.WebContents,
): Promise<void> =>
  setMainWindow(services, { isDestroyed: () => false, webContents } as Electron.BrowserWindow);

const createQuitDependencies = (services: Registry) => {
  const state = createMainState();
  const workspace = {
    getState: vi.fn(() => emptyWorkspace),
    shutdown: vi.fn(),
  };
  const chatService = { shutdown: vi.fn() };
  const invalidateLaunchPreflightDecisions = vi.fn();
  const nativeAttachmentStore = {
    releaseConversation: vi.fn(async (_conversationId: string): Promise<void> => undefined),
  };
  const showMainWindow = vi.fn();
  const sweepPowershellTrees = vi.fn();
  return {
    chatService,
    invalidateLaunchPreflightDecisions,
    nativeAttachmentStore,
    services,
    showMainWindow,
    state,
    sweepPowershellTrees,
    workspace,
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('quit confirmation handshake', () => {
  it('bounces an unlatched before-quit through one controller and tears down only after latching', async () => {
    const { appListeners } = installQuitElectronMock();
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

  it('resolves proxy authentication through the transaction coordinator', async () => {
    const { appListeners } = installQuitElectronMock();
    const services = await createQuitServices();
    const credentialsForProxy = vi.fn(() => ({
      password: 'candidate-secret',
      username: 'proxy-user',
    }));
    const { APPLICATION_PROXY_COORDINATOR } = await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_COORDINATOR, {
      credentialsForProxy,
    } as never);
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
      services,
      showMainWindow: vi.fn(),
      state: createMainState(),
      terminalOutputBatcher: { dispose: vi.fn() } as never,
    });
    const login = appListeners.get('login');
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    const requestingSession = {};

    login?.(
      event,
      { session: requestingSession },
      undefined,
      {
        host: '127.0.0.1',
        isProxy: true,
        port: 7890,
      },
      callback,
    );

    expect(credentialsForProxy).toHaveBeenCalledWith(requestingSession, '127.0.0.1', 7890);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith('proxy-user', 'candidate-secret');
  });

  it('leaves non-proxy origin authentication untouched', async () => {
    const { appListeners } = installQuitElectronMock();
    const services = await createQuitServices();
    const credentialsForProxy = vi.fn();
    const { APPLICATION_PROXY_COORDINATOR } = await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_COORDINATOR, {
      credentialsForProxy,
    } as never);
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
      services,
      showMainWindow: vi.fn(),
      state: createMainState(),
      terminalOutputBatcher: { dispose: vi.fn() } as never,
    });
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();

    appListeners.get('login')?.(
      event,
      { session: {} },
      { url: 'https://example.test/private' },
      { host: 'example.test', isProxy: false, port: 443 },
      callback,
    );

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(credentialsForProxy).not.toHaveBeenCalled();
  });

  it('cancels proxy login challenges without WebContents instead of throwing', async () => {
    const { appListeners } = installQuitElectronMock();
    const services = await createQuitServices();
    const credentialsForProxy = vi.fn();
    const { APPLICATION_PROXY_COORDINATOR } = await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_COORDINATOR, {
      credentialsForProxy,
    } as never);
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
      services,
      showMainWindow: vi.fn(),
      state: createMainState(),
      terminalOutputBatcher: { dispose: vi.fn() } as never,
    });
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();

    expect(() =>
      appListeners.get('login')?.(
        event,
        undefined,
        { url: 'https://example.test/' },
        { host: '127.0.0.1', isProxy: true, port: 7890 },
        callback,
      ),
    ).not.toThrow();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith();
    expect(credentialsForProxy).not.toHaveBeenCalled();
  });

  it('keeps WebContents proxy credentials scoped to the exact application or conversation Session', async () => {
    const { appListeners } = installQuitElectronMock();
    const services = await createQuitServices();
    const applicationSession = {};
    const conversationSession = {};
    const unrelatedTestSession = {};
    const credentialsForProxy = vi.fn((requestingSession: unknown) =>
      requestingSession === applicationSession
        ? { password: 'application-secret', username: 'application-user' }
        : requestingSession === conversationSession
          ? { password: 'conversation-secret', username: 'conversation-user' }
          : undefined,
    );
    const { APPLICATION_PROXY_COORDINATOR } = await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_COORDINATOR, {
      credentialsForProxy,
    } as never);
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
      services,
      showMainWindow: vi.fn(),
      state: createMainState(),
      terminalOutputBatcher: { dispose: vi.fn() } as never,
    });
    const login = appListeners.get('login');
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const events = callbacks.map(() => ({ preventDefault: vi.fn() }));
    const challenge = { host: 'proxy.example.com', isProxy: true, port: 7890 };

    login?.(events[0], { session: applicationSession }, undefined, challenge, callbacks[0]);
    login?.(events[1], { session: conversationSession }, undefined, challenge, callbacks[1]);
    login?.(events[2], { session: unrelatedTestSession }, undefined, challenge, callbacks[2]);
    login?.(
      events[3],
      { session: applicationSession },
      undefined,
      { ...challenge, isProxy: false },
      callbacks[3],
    );

    expect(callbacks[0]).toHaveBeenCalledWith('application-user', 'application-secret');
    expect(callbacks[1]).toHaveBeenCalledWith('conversation-user', 'conversation-secret');
    expect(callbacks[2]).toHaveBeenCalledWith();
    expect(callbacks[3]).not.toHaveBeenCalled();
    expect(
      events.slice(0, 3).every(({ preventDefault }) => preventDefault.mock.calls.length === 1),
    ).toBe(true);
    expect(events[3]?.preventDefault).not.toHaveBeenCalled();
    expect(credentialsForProxy).toHaveBeenCalledTimes(3);
    expect(credentialsForProxy).toHaveBeenNthCalledWith(
      3,
      unrelatedTestSession,
      'proxy.example.com',
      7890,
    );
  });

  it('sweeps spawned PowerShell trees and force-exits through the watchdog if the quit stalls', async () => {
    vi.useFakeTimers();
    const { app, appListeners } = installQuitElectronMock();
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

  it('blocks on failed conversation cleanup and isolates runtime shutdown after explicit force', async () => {
    vi.useFakeTimers();
    const { app, dialog } = installQuitElectronMock();
    let chooseNativeAction: ((result: Electron.MessageBoxReturnValue) => void) | undefined;
    dialog.showMessageBox.mockReturnValueOnce(
      new Promise((resolve) => {
        chooseNativeAction = resolve;
      }),
    );
    const terminateAll = vi.fn(async () => undefined);
    const claudeRuntime = {
      setTheme: vi.fn(),
      shutdown: vi.fn(() => {
        throw new Error('runtime shutdown failed');
      }),
    };
    const codexRuntime = { dispose: vi.fn() };
    const managedChatGptGateway = {
      shutdown: vi.fn(),
      shutdownForQuit: vi.fn(async () => true),
    };
    const services = await createQuitServices({
      claudeRuntime,
      codexRuntime,
      managedChatGptGateway,
      nativeConversationService: {
        activeIds: vi.fn(() => ['conversation-1', 'conversation-2']),
        closeAll: vi.fn(async () => {
          throw new Error('conversation close failed');
        }),
      },
      runtimeProcessRegistry: {
        list: vi.fn(() => []),
        stop: vi.fn(),
        terminateAll,
      },
    });
    const dependencies = createQuitDependencies(services);
    dependencies.nativeAttachmentStore.releaseConversation.mockImplementation(
      async (conversationId: string) => {
        if (conversationId === 'conversation-1') {
          throw new Error('attachment release failed');
        }
      },
    );
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    await quit.beginControlledQuit(false);

    expect(dependencies.nativeAttachmentStore.releaseConversation).not.toHaveBeenCalled();
    expect(terminateAll).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(dependencies.state.isQuitting).toBe(false);

    chooseNativeAction?.({ checkboxChecked: false, response: 1 });
    await flushPromises();

    expect(terminateAll).toHaveBeenCalledTimes(2);
    expect(claudeRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(managedChatGptGateway.shutdown).toHaveBeenCalledTimes(1);
    expect(codexRuntime.dispose).toHaveBeenCalledTimes(1);
    expect(dependencies.workspace.shutdown).toHaveBeenCalledTimes(1);
    expect(dependencies.sweepPowershellTrees).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
    expect(dependencies.state.isQuitting).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not turn attachment cleanup failures into a false residual-process prompt', async () => {
    const { app, ipc } = installQuitElectronMock();
    const runtimeProcessRegistry = {
      list: vi.fn(() => []),
      stop: vi.fn(),
      terminateAll: vi.fn(async () => undefined),
    };
    const services = await createQuitServices({
      nativeConversationService: {
        activeIds: vi.fn().mockReturnValueOnce(['conversation-1']).mockReturnValue([]),
        closeAll: vi.fn(async () => undefined),
      },
      runtimeProcessRegistry,
    });
    await setHealthyMainWindow(services, ipc.webContents as never);
    const dependencies = createQuitDependencies(services);
    dependencies.nativeAttachmentStore.releaseConversation.mockRejectedValue(
      new Error('attachment release failed'),
    );
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    await quit.beginControlledQuit(false);

    expect(runtimeProcessRegistry.terminateAll).toHaveBeenCalledTimes(1);
    expect(dependencies.nativeAttachmentStore.releaseConversation).toHaveBeenCalledTimes(1);
    expect(dependencies.state.quitConfirmation).toBeUndefined();
    expect(ipc.messages).toEqual([]);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dependencies.state.isQuitting).toBe(true);
  });

  it('starts independent cleanup before a hung conversation close consumes the total budget', async () => {
    vi.useFakeTimers();
    const { app } = installQuitElectronMock();
    let finishConversationClose: (() => void) | undefined;
    const closeAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConversationClose = resolve;
        }),
    );
    const terminateAll = vi.fn(async () => undefined);
    const services = await createQuitServices({
      nativeConversationService: {
        activeIds: vi.fn(() => []),
        closeAll,
      },
      runtimeProcessRegistry: {
        list: vi.fn(() => []),
        stop: vi.fn(),
        terminateAll,
      },
    });
    const dependencies = createQuitDependencies(services);
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    const pendingQuit = quit.beginControlledQuit(false);
    await flushPromises();
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(terminateAll).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    await pendingQuit;
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dependencies.state.isQuitting).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    finishConversationClose?.();
    await flushPromises();
    expect(dependencies.showMainWindow).not.toHaveBeenCalled();
  });

  it('leaves immediately when a duplicate launch cannot own the single-instance lock', async () => {
    const { app } = installQuitElectronMock();
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
    const { ipc } = installQuitElectronMock();
    const busyRegistry = new BusyRegistry();
    const services = await createQuitServices({ busyRegistry });
    await setHealthyMainWindow(services, ipc.webContents as never);
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
    expect(dependencies.state.quitConfirmation).toMatchObject({
      mode: 'ordinary',
      owner: 'renderer',
    });
    expect(ipc.messages.at(-1)).toEqual({
      args: [
        {
          hasBlocking: true,
          leases: [
            expect.objectContaining({ id: 'install:active' }),
            expect.objectContaining({ id: 'terminal:session-1', severity: 'blocking' }),
          ],
          requestId: expect.any(String),
        },
      ],
      channel: CHANNELS.APP_QUIT_REQUESTED,
      direction: 'main-to-renderer',
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('invalidates superseded renderer prompts before safe cleanup starts', async () => {
    vi.useFakeTimers();
    const { app, ipc } = installQuitElectronMock();
    const runtimeProcessRegistry = {
      list: vi.fn(() => []),
      stop: vi.fn(),
      terminateAll: vi.fn(async () => undefined),
    };
    const services = await createQuitServices({ runtimeProcessRegistry });
    await setHealthyMainWindow(services, ipc.webContents as never);
    const first = createQuitDependencies(services);
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(first as never);

    quit.requestQuit();
    const firstRequestId = first.state.quitConfirmation?.id;
    quit.requestQuit();
    await flushPromises();
    expect(ipc.messages).toContainEqual({
      args: [firstRequestId],
      channel: CHANNELS.APP_QUIT_REQUEST_INVALIDATED,
      direction: 'main-to-renderer',
    });
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(first.state.isQuitting).toBe(true);

    const timeoutServices = await createQuitServices({ runtimeProcessRegistry });
    await setHealthyMainWindow(timeoutServices, ipc.webContents as never);
    const timed = createQuitDependencies(timeoutServices);
    const timedQuit = createQuitController(timed as never);
    timedQuit.requestQuit();
    const timedRequestId = timed.state.quitConfirmation?.id;
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();
    expect(ipc.messages).toContainEqual({
      args: [timedRequestId],
      channel: CHANNELS.APP_QUIT_REQUEST_INVALIDATED,
      direction: 'main-to-renderer',
    });
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(timed.state.isQuitting).toBe(true);
  });

  it('does not show a contradictory second prompt while controlled cleanup is running', async () => {
    const { app, ipc } = installQuitElectronMock();
    let finishConversationClose: (() => void) | undefined;
    const services = await createQuitServices({
      nativeConversationService: {
        activeIds: vi.fn(() => []),
        closeAll: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishConversationClose = resolve;
            }),
        ),
      },
    });
    await setHealthyMainWindow(services, ipc.webContents as never);
    const dependencies = createQuitDependencies(services);
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    const pendingQuit = quit.beginControlledQuit(false);
    await flushPromises();
    quit.requestQuit();

    expect(ipc.messages).toEqual([]);
    expect(app.quit).not.toHaveBeenCalled();

    finishConversationClose?.();
    await pendingQuit;
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('uses native residual confirmation when initial renderer delivery is unavailable or throws', async () => {
    const { app, dialog } = installQuitElectronMock();
    const runtimeProcessRegistry = {
      list: vi.fn(() => []),
      stop: vi.fn(),
      terminateAll: vi.fn(async () => {
        throw new Error('scan failed');
      }),
    };
    const { createQuitController } = await import('../../src/main/app/lifecycle');

    const missingWindowServices = await createQuitServices({ runtimeProcessRegistry });
    const missingWindowDependencies = createQuitDependencies(missingWindowServices);
    createQuitController(missingWindowDependencies as never).requestQuit();
    await flushPromises();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(missingWindowDependencies.state.quitConfirmation).toMatchObject({
      mode: 'residual',
      owner: 'native',
    });

    const throwingWindowServices = await createQuitServices({ runtimeProcessRegistry });
    const throwingWebContents = {
      isCrashed: vi.fn(() => false),
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => false),
      send: vi.fn(() => {
        throw new Error('renderer send failed');
      }),
    };
    await setHealthyMainWindow(throwingWindowServices, throwingWebContents as never);
    const throwingWindowDependencies = createQuitDependencies(throwingWindowServices);
    createQuitController(throwingWindowDependencies as never).requestQuit();
    await flushPromises();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(app.quit).not.toHaveBeenCalled();
    expect(throwingWindowDependencies.state.quitConfirmation).toMatchObject({
      mode: 'residual',
      owner: 'native',
    });
  });

  it('asks for retry when process cleanup cannot prove a safe shutdown', async () => {
    const { app, ipc } = installQuitElectronMock();
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
    await setHealthyMainWindow(services, ipc.webContents as never);
    const dependencies = createQuitDependencies(services);
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    await quit.beginControlledQuit(false);
    expect(app.quit).not.toHaveBeenCalled();
    expect(dependencies.state.quitConfirmation).toMatchObject({
      mode: 'residual',
      owner: 'renderer',
    });
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
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: 'retry',
      requestId: dependencies.state.quitConfirmation?.id,
    });
    await flushPromises();

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dependencies.state.isQuitting).toBe(true);
  });

  it('falls back to native confirmation when the residual renderer prompt is not acknowledged', async () => {
    vi.useFakeTimers();
    const { app, dialog, ipc } = installQuitElectronMock();
    let chooseNativeAction: ((result: Electron.MessageBoxReturnValue) => void) | undefined;
    dialog.showMessageBox.mockReturnValueOnce(
      new Promise((resolve) => {
        chooseNativeAction = resolve;
      }),
    );
    const runtimeProcessRegistry = {
      list: vi.fn(() => []),
      stop: vi.fn(),
      terminateAll: vi
        .fn()
        .mockRejectedValueOnce(new Error('scan failed'))
        .mockResolvedValue(undefined),
    };
    const services = await createQuitServices({ runtimeProcessRegistry });
    await setHealthyMainWindow(services, ipc.webContents as never);
    const dependencies = createQuitDependencies(services);
    const { createQuitController } = await import('../../src/main/app/lifecycle');
    const quit = createQuitController(dependencies as never);

    await quit.beginControlledQuit(false);

    expect(app.quit).not.toHaveBeenCalled();
    expect(dependencies.state.quitConfirmation).toMatchObject({
      mode: 'residual',
      owner: 'renderer',
    });
    expect(dependencies.state.quitConfirmationTimer).toBeDefined();

    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();

    expect(runtimeProcessRegistry.terminateAll).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(dependencies.state.isQuitting).toBe(false);
    expect(dependencies.state.quitConfirmation).toMatchObject({
      mode: 'residual',
      owner: 'native',
    });
    expect(dependencies.state.quitConfirmationTimer).toBeUndefined();

    chooseNativeAction?.({ checkboxChecked: false, response: 0 });
    await flushPromises();

    expect(runtimeProcessRegistry.terminateAll).toHaveBeenCalledTimes(2);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(dependencies.state.isQuitting).toBe(true);
    expect(dependencies.state.quitConfirmation).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts only the current renderer acknowledgement and one-shot mode-valid decision', async () => {
    vi.useFakeTimers();
    const { ipc } = installQuitElectronMock();
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

    state.quitConfirmation = { id: 'quit-request-1', mode: 'ordinary', owner: 'renderer' };
    state.quitConfirmationTimer = setTimeout(() => undefined, 3_000);
    ipc.sendFromRenderer(CHANNELS.APP_QUIT_REQUEST_RECEIVED, 'stale-request');
    expect(state.quitConfirmationTimer).toBeDefined();
    ipc.sendFromRenderer(CHANNELS.APP_QUIT_REQUEST_RECEIVED, 'quit-request-1');
    expect(state.quitConfirmationTimer).toBeUndefined();

    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: true,
      requestId: 'stale-request',
    });
    expect(state.quitConfirmation?.id).toBe('quit-request-1');
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: false,
      requestId: 'quit-request-1',
    });
    expect(state.quitConfirmation).toBeUndefined();
    expect(beginControlledQuit).not.toHaveBeenCalled();

    state.quitConfirmation = { id: 'quit-request-2', mode: 'ordinary', owner: 'renderer' };
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: 'retry',
      requestId: 'quit-request-2',
    });
    expect(state.quitConfirmation?.id).toBe('quit-request-2');
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: true,
      requestId: 'quit-request-2',
    });
    expect(beginControlledQuit).toHaveBeenCalledWith(false);

    state.quitConfirmation = { id: 'quit-request-3', mode: 'residual', owner: 'renderer' };
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: true,
      requestId: 'quit-request-2',
    });
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: false,
      requestId: 'quit-request-3',
    });
    expect(state.quitConfirmation?.id).toBe('quit-request-3');
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: true,
      requestId: 'quit-request-3',
    });
    expect(beginControlledQuit).toHaveBeenLastCalledWith(true);

    state.quitConfirmation = { id: 'quit-request-4', mode: 'residual', owner: 'native' };
    ipc.sendFromRenderer(CHANNELS.APP_CONFIRM_QUIT, {
      decision: true,
      requestId: 'quit-request-4',
    });
    expect(state.quitConfirmation?.id).toBe('quit-request-4');
    expect(beginControlledQuit).toHaveBeenCalledTimes(2);

    ipc.sendFromRenderer(CHANNELS.APP_MINIMIZE_TO_TRAY);
    expect(hideMainWindowToTray).toHaveBeenCalledTimes(1);
    expect(validateSender).toHaveBeenCalledTimes(11);
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
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
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
    state.quitConfirmation = { id: 'quit-request-1', mode: 'ordinary', owner: 'renderer' };
    state.quitConfirmationTimer = setTimeout(() => undefined, 60_000);
    const requestQuit = vi.fn();
    const preferences = { closeBehavior: 'exit' };
    const { createWindowController } = await import('../../src/main/app/window');
    const controller = createWindowController({
      appPreferencesStore: { get: vi.fn(() => preferences), set: vi.fn() } as never,
      invalidateLaunchPreflightDecisions: vi.fn(),
      requestQuit,
      services,
      state,
      workspaceStore: { getTheme: vi.fn(() => undefined) } as never,
    });
    await controller.createWindow();

    webContentsListeners.get('render-process-gone')?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestQuit).toHaveBeenCalledTimes(1);

    windowListeners.get('session-end')?.();
    expect(downloadEngine.flushJournal).toHaveBeenCalledTimes(1);
    expect(state.isQuitting).toBe(true);
    expect(state.quitConfirmation).toBeUndefined();
    expect(state.quitConfirmationTimer).toBeUndefined();

    state.isQuitting = false;
    const closeEvent = { preventDefault: vi.fn() };
    windowListeners.get('close')?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestQuit).toHaveBeenCalledTimes(2);

    preferences.closeBehavior = 'tray';
    windowListeners.get('close')?.({ preventDefault: vi.fn() });
    expect(fakeWindow.hide).toHaveBeenCalledTimes(1);
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
});
