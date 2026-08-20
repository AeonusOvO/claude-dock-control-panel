import { CHANNELS } from '../../shared/ipc/channels';
import { app } from 'electron';
import type { ChatService } from '../chat/service';
import type { PendingPermissionModeProbe } from '../claude/permission-mode-probe';
import type { NativeAttachmentStore } from '../conversation/attachment-store';
import { runQuitContributions, type QuitContribution } from '../infra/contributions';
import { mainLogger } from '../infra/logger';
import type { Registry } from '../infra/registry';
import {
  APPLICATION_PROXY_STORE,
  BUSY_REGISTRY,
  CLAUDE_PERMISSION_BRIDGE,
  CLAUDE_RUNTIME,
  CODEX_RUNTIME,
  DOWNLOAD_ENGINE,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  NATIVE_CONVERSATION_SERVICE,
  RUNTIME_PROCESS_REGISTRY,
} from '../infra/service-tokens';
import type { MainState } from '../ipc/context';
import type { TerminalOutputBatcher } from '../terminal/output-batcher';
import { terminateSpawnedPowershells } from '../terminal/session';
import type { TerminalWorkspace } from '../terminal/workspace';
import type { RuntimeEffects } from './profile';

/** Upper bound for the whole conversation/process cleanup phase of a controlled quit. */
const QUIT_CLEANUP_BUDGET_MS = 15_000;
/** Upper bound between the final `before-quit` and the process actually leaving. */
const QUIT_WATCHDOG_MS = 8_000;

export interface QuitControllerDependencies {
  chatService: ChatService;
  nativeAttachmentStore: NativeAttachmentStore;
  services: Registry;
  /* The confirmation is a renderer dialog, so asking requires the window to be up and focused. */
  showMainWindow: () => void;
  state: MainState;
  workspace: TerminalWorkspace;
  /* Fire-and-forget sweep that force-kills the PowerShell trees ConPTY's kill() cannot reach. */
  sweepPowershellTrees?: () => void;
}

/** The three stages of shutdown: ask, drain, then release the runtimes that hold OS resources. */
export interface QuitController {
  beginControlledQuit: (forceWithResidualProcesses: boolean) => Promise<void>;
  requestQuit: () => void;
  shutdownRuntimeForQuit: () => void;
}

export const createQuitController = ({
  chatService,
  nativeAttachmentStore,
  services,
  showMainWindow,
  state,
  sweepPowershellTrees = terminateSpawnedPowershells,
  workspace,
}: QuitControllerDependencies): QuitController => {
  function shutdownRuntimeForQuit(): void {
    if (state.runtimeShutdownForQuitDone) return;
    state.runtimeShutdownForQuitDone = true;
    services.resolve(CLAUDE_PERMISSION_BRIDGE).shutdown();
    chatService.shutdown();
    services.resolve(CLAUDE_RUNTIME).shutdown();
    services.resolve(MANAGED_CHATGPT_GATEWAY).shutdown();
    services.resolve(CODEX_RUNTIME).dispose();
    workspace.shutdown();
    sweepPowershellTrees();
  }

  const runQuitCleanup = async (forceWithResidualProcesses: boolean): Promise<'asked' | 'done'> => {
    const nativeConversationService = services.resolve(NATIVE_CONVERSATION_SERVICE);
    const nativeAttachmentOwners = nativeConversationService.activeIds();
    await nativeConversationService.closeAll();
    await Promise.all(
      nativeAttachmentOwners.map((conversationId) =>
        nativeAttachmentStore.releaseConversation(conversationId),
      ),
    );
    const runtimeProcessRegistry = services.resolve(RUNTIME_PROCESS_REGISTRY);
    let processCleanupFailed = false;
    try {
      await runtimeProcessRegistry.terminateAll();
    } catch (error) {
      processCleanupFailed = true;
      mainLogger.error('lifecycle', '退出前无法完成派生进程清理。', error, 'environment');
    }
    const residual = runtimeProcessRegistry.list();
    if ((processCleanupFailed || residual.length > 0) && !forceWithResidualProcesses) {
      const target = services.resolve(MAIN_WINDOW).current?.webContents;
      // `state.isQuitting` guards a cleanup that outlived its budget: it must not surface a
      // dialog whose window the quit has already destroyed.
      if (target && !target.isDestroyed() && !target.isCrashed() && !state.isQuitting) {
        state.quitResidualConfirmationPending = true;
        state.quitConfirmationPending = true;
        showMainWindow();
        target.send(CHANNELS.APP_QUIT_REQUESTED, {
          hasBlocking: true,
          leases: [
            ...residual.map(({ sessionId, view }) => ({
              cancellable: false,
              id: `runtime-process:${view.processKey}`,
              kind: 'conversation' as const,
              label: `${view.name}（PID ${view.pid}，会话 ${sessionId}）仍在运行`,
              severity: 'blocking' as const,
            })),
            ...(processCleanupFailed
              ? [
                  {
                    cancellable: false,
                    id: 'runtime-process:scan-failed',
                    kind: 'conversation' as const,
                    label: '无法复查当前终端的派生 Web 进程；默认退出已阻止',
                    severity: 'blocking' as const,
                  },
                ]
              : []),
          ],
          runtimeCleanupFailed: true,
        });
        return 'asked';
      }
    }
    return 'done';
  };

  async function beginControlledQuit(forceWithResidualProcesses: boolean): Promise<void> {
    if (state.isQuitting || state.quitCleanupInProgress) return;
    state.quitCleanupInProgress = true;
    // Closing the per-launch pipe endpoints both releases existing requests to Claude's native
    // prompt and prevents a new permission request from entering while the quit barrier runs.
    services.resolve(CLAUDE_PERMISSION_BRIDGE).shutdown();
    try {
      /*
       * A hung conversation close or process sweep would otherwise stall the quit forever with no
       * window left to explain it, so the whole cleanup runs under one budget. On a miss the
       * cleanup keeps running detached, the residual re-confirmation is skipped, and the quit
       * proceeds; the before-quit watchdog below still bounds the very last stretch.
       */
      let budgetTimer: NodeJS.Timeout | undefined;
      const budgetElapsed = new Promise<'timed-out'>((resolve) => {
        budgetTimer = setTimeout(() => resolve('timed-out'), QUIT_CLEANUP_BUDGET_MS);
        budgetTimer.unref();
      });
      const outcome = await Promise.race([
        runQuitCleanup(forceWithResidualProcesses),
        budgetElapsed,
      ]);
      clearTimeout(budgetTimer);
      if (outcome === 'asked') {
        return;
      }
      if (outcome === 'timed-out') {
        mainLogger.error(
          'lifecycle',
          '退出清理未在预算内完成，跳过剩余清理继续退出。',
          undefined,
          'internal',
        );
      }
      shutdownRuntimeForQuit();
      services.resolve(RUNTIME_PROCESS_REGISTRY).stop();
      state.isQuitting = true;
      app.quit();
    } finally {
      state.quitCleanupInProgress = false;
    }
  }

  /**
   * Starts a quit. An explicit quit is always confirmed when the renderer can answer. Busy operations
   * and live terminals are included so the decision explains exactly what will be interrupted.
   */
  const requestQuit = (): void => {
    if (state.isQuitting) {
      return;
    }
    const window = services.resolve(MAIN_WINDOW).current;
    const terminalLeases = workspace
      .getState()
      .sessions.filter(({ phase }) => phase === 'running' || phase === 'starting')
      .map(({ id, phase, title }) => ({
        cancellable: false,
        id: `terminal:${id}`,
        kind: 'conversation' as const,
        label: `终端“${title}”仍在${phase === 'starting' ? '启动' : '运行'}`,
        severity: 'blocking' as const,
      }));
    const leases = [...services.resolve(BUSY_REGISTRY).list(), ...terminalLeases];
    const canAsk =
      window !== null &&
      !window.isDestroyed() &&
      !window.webContents.isLoading() &&
      !window.webContents.isCrashed();
    /*
     * A second quit attempt while the question is outstanding forces the issue. The short timer below
     * only covers delivery to the renderer; preload acknowledges receipt before the themed dialog is
     * shown, so it never quits out from under someone who is reading that dialog.
     */
    if (!canAsk || state.quitConfirmationPending) {
      if (state.quitConfirmationTimer) {
        clearTimeout(state.quitConfirmationTimer);
        state.quitConfirmationTimer = undefined;
      }
      state.quitConfirmationPending = false;
      void beginControlledQuit(true);
      return;
    }
    state.quitConfirmationPending = true;
    showMainWindow();
    window.webContents.send(CHANNELS.APP_QUIT_REQUESTED, {
      hasBlocking: leases.some(({ severity }) => severity === 'blocking'),
      leases,
    });
    state.quitConfirmationTimer = setTimeout(() => {
      if (!state.quitConfirmationPending) {
        return;
      }
      state.quitConfirmationPending = false;
      state.quitConfirmationTimer = undefined;
      void beginControlledQuit(true);
    }, 3_000);
    state.quitConfirmationTimer.unref();
  };

  return { beginControlledQuit, requestQuit, shutdownRuntimeForQuit };
};

export interface AppLifecycleDependencies {
  effects: RuntimeEffects;
  /* Runs once Electron is ready and the single-instance lock is held; builds every runtime service. */
  onReady: () => Promise<void>;
  pendingPermissionModeProbes: Map<number, PendingPermissionModeProbe>;
  quit: QuitController;
  services: Registry;
  showMainWindow: () => void;
  state: MainState;
  terminalOutputBatcher: TerminalOutputBatcher;
}

/**
 * Installs the process-level handlers. Electron's default handler turns any stray main-process
 * rejection into a modal "A JavaScript error occurred in the main process" dialog, which is a far
 * worse outcome than a degraded feature. Background work (tray balloons, journal writes, sidecar
 * teardown) is logged and swallowed instead; a genuinely fatal failure still takes the app down
 * through the normal paths.
 */
export const registerProcessErrorHandlers = (): void => {
  process.on('uncaughtException', (error) => {
    mainLogger.error('main', '未捕获异常。', error, 'internal');
  });
  process.on('unhandledRejection', (reason) => {
    mainLogger.error('main', '未处理的 Promise 拒绝。', reason, 'internal');
  });
};

export const registerAppLifecycle = ({
  effects,
  onReady,
  pendingPermissionModeProbes,
  quit,
  services,
  showMainWindow,
  state,
  terminalOutputBatcher,
}: AppLifecycleDependencies): void => {
  const hasSingleInstanceLock = !effects.singleInstanceLock || app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    // A duplicate launch has nothing to protect and no window to ask through: leave immediately.
    state.isQuitting = true;
    app.quit();
    return;
  }

  const finalQuitContributions = [
    () => services.resolve(DOWNLOAD_ENGINE).flushJournal(),
    () => terminalOutputBatcher.dispose(),
    () => {
      for (const pending of pendingPermissionModeProbes.values()) {
        clearTimeout(pending.timer);
        pending.resolve(undefined);
      }
      pendingPermissionModeProbes.clear();
    },
    () => services.resolve(CLAUDE_PERMISSION_BRIDGE).shutdown(),
    () => services.resolve(RUNTIME_PROCESS_REGISTRY).stop(),
    () => quit.shutdownRuntimeForQuit(),
  ] as const satisfies readonly QuitContribution[];

  /*
   * node-pty keeps its ConPTY pipe sockets referenced even after the shells exit, so a quit that
   * ever spawned a terminal can stall in libuv's loop drain indefinitely. The watchdog bounds
   * that stretch with a hard exit; `unref` keeps it from slowing down a normal exit.
   */
  const armQuitWatchdog = (): void => {
    if (state.quitWatchdogTimer) return;
    const timer = setTimeout(() => {
      mainLogger.error('lifecycle', '优雅退出超时，强制结束进程。', undefined, 'internal');
      app.exit(0);
    }, QUIT_WATCHDOG_MS);
    timer.unref();
    state.quitWatchdogTimer = timer;
  };

  app.on('second-instance', showMainWindow);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  });
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    const applicationProxyStore = services.resolve(APPLICATION_PROXY_STORE);
    const config = applicationProxyStore.getView();
    const credentials = applicationProxyStore.getCredentials();
    if (
      !config.enabled ||
      !credentials ||
      authInfo.host.toLowerCase() !== config.host.toLowerCase() ||
      authInfo.port !== config.port
    ) {
      return;
    }
    event.preventDefault();
    callback(credentials.username, credentials.password);
  });
  void app.whenReady().then(onReady);

  app.on('activate', showMainWindow);
  app.on('before-quit', (event) => {
    /*
     * Anything that can reach here without going through `requestQuit` — Alt+F4 on a visible window,
     * `Cmd/Ctrl+Q`, an installer restart — is bounced back through the same confirmation. `isQuitting`
     * is the one-way latch that lets the real quit through on the second pass.
     */
    if (!state.isQuitting) {
      event.preventDefault();
      quit.requestQuit();
      return;
    }
    runQuitContributions(finalQuitContributions);
    armQuitWatchdog();
  });
};
