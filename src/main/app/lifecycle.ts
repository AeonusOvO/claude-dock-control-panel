import { randomUUID } from 'node:crypto';
import { CHANNELS } from '../../shared/ipc/channels';
import { app, dialog } from 'electron';
import type { ChatService } from '../chat/service';
import type { PendingPermissionModeProbe } from '../claude/permission-mode-probe';
import type { NativeAttachmentStore } from '../conversation/attachment-store';
import type { NativeConversationService } from '../conversation/service';
import { runQuitContributions, type QuitContribution } from '../infra/contributions';
import { mainLogger } from '../infra/logger';
import type { Registry } from '../infra/registry';
import {
  APPLICATION_PROXY_COORDINATOR,
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
import type { RuntimeProcessRegistry } from '../runtime/process-registry';
import type { TerminalOutputBatcher } from '../terminal/output-batcher';
import { terminateSpawnedPowershells } from '../terminal/session';
import type { TerminalWorkspace } from '../terminal/workspace';
import type { RuntimeEffects } from './profile';

/** Upper bound for the whole conversation/process cleanup phase of a controlled quit. */
const QUIT_CLEANUP_BUDGET_MS = 15_000;
/** Upper bound between sending a quit prompt and preload acknowledging receipt. */
const QUIT_CONFIRMATION_DELIVERY_TIMEOUT_MS = 3_000;
/** Upper bound between the final `before-quit` and the process actually leaving. */
const QUIT_WATCHDOG_MS = 8_000;

export interface QuitControllerDependencies {
  chatService: ChatService;
  invalidateLaunchPreflightDecisions: () => void;
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

type ResolvedQuitControllerDependencies = Omit<
  QuitControllerDependencies,
  'sweepPowershellTrees'
> & {
  sweepPowershellTrees: () => void;
};

type ResidualRuntimeProcesses = ReturnType<RuntimeProcessRegistry['list']>;

type QuitCleanupConfirmationCallbacks = {
  force: () => void;
  retry: () => void;
};

const clearQuitConfirmationTimer = (state: MainState): void => {
  if (!state.quitConfirmationTimer) return;
  clearTimeout(state.quitConfirmationTimer);
  state.quitConfirmationTimer = undefined;
};

const invalidateQuitConfirmation = (
  { services, state }: ResolvedQuitControllerDependencies,
  expectedId?: string,
): boolean => {
  const confirmation = state.quitConfirmation;
  if (!confirmation || (expectedId !== undefined && confirmation.id !== expectedId)) return false;
  clearQuitConfirmationTimer(state);
  state.quitConfirmation = undefined;
  if (confirmation.owner !== 'renderer') return true;
  try {
    const target = services.resolve(MAIN_WINDOW).current?.webContents;
    if (target && !target.isDestroyed() && !target.isCrashed()) {
      target.send(CHANNELS.APP_QUIT_REQUEST_INVALIDATED, confirmation.id);
    }
  } catch (error) {
    reportQuitFailure('无法撤销已过期的退出确认。', error);
  }
  return true;
};

const createQuitConfirmation = (
  state: MainState,
  mode: 'ordinary' | 'residual',
  owner: 'native' | 'renderer',
) => {
  const confirmation = { id: randomUUID(), mode, owner } as const;
  state.quitConfirmation = confirmation;
  return confirmation;
};

const reportQuitFailure = (message: string, error: unknown): void => {
  try {
    mainLogger.error('lifecycle', message, error, 'environment');
  } catch {
    // Logging must not become another shutdown barrier.
  }
};

const isolateQuitCleanup = async (
  operation: () => void | Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    onFailure(error);
  }
};

const shutdownRuntimeForControlledQuit = ({
  chatService,
  services,
  state,
  sweepPowershellTrees,
  workspace,
}: ResolvedQuitControllerDependencies): void => {
  if (state.runtimeShutdownForQuitDone) return;
  state.runtimeShutdownForQuitDone = true;
  const failures = runQuitContributions([
    () => services.resolve(CLAUDE_PERMISSION_BRIDGE).shutdown(),
    () => chatService.shutdown(),
    () => services.resolve(CLAUDE_RUNTIME).shutdown(),
    () => services.resolve(MANAGED_CHATGPT_GATEWAY).shutdown(),
    () => services.resolve(CODEX_RUNTIME).dispose(),
    () => workspace.shutdown(),
    () => sweepPowershellTrees(),
  ]);
  for (const failure of failures) {
    reportQuitFailure('退出运行时清理步骤失败。', failure);
  }
};

const showNativeQuitCleanupConfirmation = (
  { services, state }: ResolvedQuitControllerDependencies,
  callbacks: QuitCleanupConfirmationCallbacks,
): void => {
  const confirmation = createQuitConfirmation(state, 'residual', 'native');
  const options = {
    buttons: ['重试安全清理', '仍要退出'],
    cancelId: 0,
    defaultId: 0,
    detail: '请选择重新执行安全清理，或明确确认带着列出的会话或进程退出。',
    message: '仍有会话或派生进程未能安全结束。',
    noLink: true,
    title: '安全清理尚未完成',
    type: 'warning',
  } as const satisfies Electron.MessageBoxOptions;
  try {
    const owner = services.resolve(MAIN_WINDOW).current;
    const response =
      owner && !owner.isDestroyed()
        ? dialog.showMessageBox(owner, options)
        : dialog.showMessageBox(options);
    void response
      .then(({ response: selected }) => {
        const current = state.quitConfirmation;
        if (
          state.isQuitting ||
          current?.id !== confirmation.id ||
          current.owner !== 'native' ||
          current.mode !== 'residual'
        ) {
          return;
        }
        state.quitConfirmation = undefined;
        if (selected === 1) callbacks.force();
        else callbacks.retry();
      })
      .catch((error: unknown) => {
        if (state.quitConfirmation?.id === confirmation.id) {
          state.quitConfirmation = undefined;
        }
        reportQuitFailure('无法显示系统退出确认。', error);
      });
  } catch (error) {
    if (state.quitConfirmation?.id === confirmation.id) {
      state.quitConfirmation = undefined;
    }
    reportQuitFailure('无法显示系统退出确认。', error);
  }
};

const sendQuitCleanupConfirmation = (
  dependencies: ResolvedQuitControllerDependencies,
  residual: ResidualRuntimeProcesses,
  processCleanupFailed: boolean,
  conversationCleanupFailed: boolean,
  callbacks: QuitCleanupConfirmationCallbacks,
): boolean => {
  const { services, showMainWindow, state } = dependencies;
  const showNativeFallback = (): boolean => {
    if (state.isQuitting) return false;
    invalidateQuitConfirmation(dependencies);
    showNativeQuitCleanupConfirmation(dependencies, callbacks);
    return true;
  };
  try {
    const target = services.resolve(MAIN_WINDOW).current?.webContents;
    // `state.isQuitting` guards cleanup that outlived its budget: it must not surface a dialog whose
    // window the quit has already destroyed.
    if (
      !target ||
      target.isDestroyed() ||
      target.isCrashed() ||
      target.isLoading() ||
      state.isQuitting
    ) {
      return showNativeFallback();
    }
    const confirmation = createQuitConfirmation(state, 'residual', 'renderer');
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
        ...(conversationCleanupFailed
          ? [
              {
                cancellable: false,
                id: 'conversation:close-failed',
                kind: 'conversation' as const,
                label: '一个或多个原生会话未能关闭；默认退出已阻止',
                severity: 'blocking' as const,
              },
            ]
          : []),
      ],
      requestId: confirmation.id,
      runtimeCleanupFailed: true,
    });
    state.quitConfirmationTimer = setTimeout(() => {
      if (state.quitConfirmation?.id !== confirmation.id) return;
      invalidateQuitConfirmation(dependencies, confirmation.id);
      showNativeFallback();
    }, QUIT_CONFIRMATION_DELIVERY_TIMEOUT_MS);
    state.quitConfirmationTimer.unref();
    return true;
  } catch (error) {
    invalidateQuitConfirmation(dependencies);
    reportQuitFailure('无法显示退出清理结果，改用系统确认。', error);
    return showNativeFallback();
  }
};

const runControlledQuitCleanup = async (
  dependencies: ResolvedQuitControllerDependencies,
  forceWithResidualProcesses: boolean,
  confirmationCallbacks: QuitCleanupConfirmationCallbacks,
): Promise<'asked' | 'done'> => {
  const { nativeAttachmentStore, services } = dependencies;
  let conversationCleanupFailed = false;
  let processCleanupFailed = false;
  let nativeConversationService: NativeConversationService | undefined;
  let nativeAttachmentOwners: readonly string[] = [];
  let runtimeProcessRegistry: RuntimeProcessRegistry | undefined;

  try {
    nativeConversationService = services.resolve(NATIVE_CONVERSATION_SERVICE);
    nativeAttachmentOwners = nativeConversationService.activeIds();
  } catch (error) {
    conversationCleanupFailed = true;
    reportQuitFailure('退出前无法读取原生会话状态。', error);
  }
  try {
    runtimeProcessRegistry = services.resolve(RUNTIME_PROCESS_REGISTRY);
  } catch (error) {
    processCleanupFailed = true;
    reportQuitFailure('退出前无法读取派生进程状态。', error);
  }

  const cleanupOperations: Promise<void>[] = [];
  if (nativeConversationService) {
    cleanupOperations.push(
      (async () => {
        await isolateQuitCleanup(
          () => nativeConversationService.closeAll(),
          (error) => {
            conversationCleanupFailed = true;
            reportQuitFailure('退出前无法关闭原生会话。', error);
          },
        );
        let remainingOwners: ReadonlySet<string>;
        try {
          remainingOwners = new Set(nativeConversationService.activeIds());
        } catch (error) {
          conversationCleanupFailed = true;
          reportQuitFailure('退出前无法复查原生会话状态。', error);
          return;
        }
        await Promise.all(
          nativeAttachmentOwners
            .filter((conversationId) => !remainingOwners.has(conversationId))
            .map((conversationId) =>
              isolateQuitCleanup(
                () => nativeAttachmentStore.releaseConversation(conversationId),
                (error) => {
                  reportQuitFailure('退出前无法释放会话附件。', error);
                },
              ),
            ),
        );
      })(),
    );
  }
  cleanupOperations.push(
    isolateQuitCleanup(
      async () => {
        if (!(await services.resolve(MANAGED_CHATGPT_GATEWAY).shutdownForQuit())) {
          processCleanupFailed = true;
        }
      },
      (error) => {
        processCleanupFailed = true;
        reportQuitFailure('退出前无法完成 ChatGPT 托管网关清理。', error);
      },
    ),
  );
  if (runtimeProcessRegistry) {
    cleanupOperations.push(
      isolateQuitCleanup(
        () => runtimeProcessRegistry.terminateAll(),
        (error) => {
          processCleanupFailed = true;
          reportQuitFailure('退出前无法完成派生进程清理。', error);
        },
      ),
    );
  }
  await Promise.all(cleanupOperations);

  let residual: ResidualRuntimeProcesses = [];
  if (runtimeProcessRegistry) {
    try {
      residual = runtimeProcessRegistry.list();
    } catch (error) {
      processCleanupFailed = true;
      reportQuitFailure('退出前无法复查派生进程状态。', error);
    }
  }
  if (
    !forceWithResidualProcesses &&
    (conversationCleanupFailed || processCleanupFailed || residual.length > 0) &&
    sendQuitCleanupConfirmation(
      dependencies,
      residual,
      processCleanupFailed,
      conversationCleanupFailed,
      confirmationCallbacks,
    )
  ) {
    return 'asked';
  }
  return 'done';
};

const finishControlledQuit = (
  dependencies: ResolvedQuitControllerDependencies,
  shutdownRuntimeForQuit: () => void,
): void => {
  const { services, state } = dependencies;
  if (state.isQuitting) return;
  shutdownRuntimeForQuit();
  for (const failure of runQuitContributions([
    () => services.resolve(RUNTIME_PROCESS_REGISTRY).stop(),
  ])) {
    reportQuitFailure('退出前无法停止派生进程观察。', failure);
  }
  state.isQuitting = true;
  try {
    app.quit();
  } catch (error) {
    reportQuitFailure('无法请求应用退出，改为直接结束。', error);
    try {
      app.exit(0);
    } catch (exitError) {
      reportQuitFailure('无法直接结束应用进程。', exitError);
    }
  }
};

const beginControlledQuit = async (
  dependencies: ResolvedQuitControllerDependencies,
  shutdownRuntimeForQuit: () => void,
  forceWithResidualProcesses: boolean,
): Promise<void> => {
  const { invalidateLaunchPreflightDecisions, services, state } = dependencies;
  if (state.isQuitting || state.quitCleanupInProgress) return;
  invalidateQuitConfirmation(dependencies);
  state.quitCleanupInProgress = true;
  let budgetTimer: NodeJS.Timeout | undefined;
  try {
    for (const failure of runQuitContributions([
      () => invalidateLaunchPreflightDecisions(),
      // Closing the per-launch pipe endpoints both releases existing requests to Claude's native
      // prompt and prevents a new permission request from entering while the quit barrier runs.
      () => services.resolve(CLAUDE_PERMISSION_BRIDGE).shutdown(),
    ])) {
      reportQuitFailure('退出屏障初始化失败。', failure);
    }
    /*
     * A hung conversation close or process sweep would otherwise stall the quit forever with no
     * window left to explain it, so the whole cleanup runs under one budget. On a miss the cleanup
     * keeps running detached, the residual re-confirmation is skipped, and the quit proceeds; the
     * before-quit watchdog below still bounds the very last stretch.
     */
    const budgetElapsed = new Promise<'timed-out'>((resolve) => {
      budgetTimer = setTimeout(() => resolve('timed-out'), QUIT_CLEANUP_BUDGET_MS);
      budgetTimer.unref();
    });
    const cleanup = Promise.resolve()
      .then(() =>
        runControlledQuitCleanup(dependencies, forceWithResidualProcesses, {
          force: () => {
            void beginControlledQuit(dependencies, shutdownRuntimeForQuit, true);
          },
          retry: () => {
            void beginControlledQuit(dependencies, shutdownRuntimeForQuit, false);
          },
        }),
      )
      .catch((error: unknown) => {
        reportQuitFailure('退出清理流程失败，继续退出。', error);
        return 'done' as const;
      });
    let outcome: 'asked' | 'done' | 'timed-out';
    try {
      outcome = await Promise.race([cleanup, budgetElapsed]);
    } finally {
      if (budgetTimer) {
        clearTimeout(budgetTimer);
        budgetTimer = undefined;
      }
    }
    if (outcome === 'asked') return;
    if (outcome === 'timed-out') {
      reportQuitFailure('退出清理未在预算内完成，跳过剩余清理继续退出。', undefined);
    }
    finishControlledQuit(dependencies, shutdownRuntimeForQuit);
  } catch (error) {
    reportQuitFailure('退出流程发生错误，继续退出。', error);
    finishControlledQuit(dependencies, shutdownRuntimeForQuit);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    state.quitCleanupInProgress = false;
  }
};

export const createQuitController = ({
  chatService,
  invalidateLaunchPreflightDecisions,
  nativeAttachmentStore,
  services,
  showMainWindow,
  state,
  sweepPowershellTrees = terminateSpawnedPowershells,
  workspace,
}: QuitControllerDependencies): QuitController => {
  const dependencies: ResolvedQuitControllerDependencies = {
    chatService,
    invalidateLaunchPreflightDecisions,
    nativeAttachmentStore,
    services,
    showMainWindow,
    state,
    sweepPowershellTrees,
    workspace,
  };
  const shutdownRuntimeForQuit = (): void => shutdownRuntimeForControlledQuit(dependencies);
  const runControlledQuit = (forceWithResidualProcesses: boolean): Promise<void> =>
    beginControlledQuit(dependencies, shutdownRuntimeForQuit, forceWithResidualProcesses);

  /**
   * Starts a quit. An explicit quit is always confirmed when the renderer can answer. Busy operations
   * and live terminals are included so the decision explains exactly what will be interrupted.
   */
  const requestQuit = (): void => {
    if (state.isQuitting || state.quitCleanupInProgress) return;
    try {
      invalidateLaunchPreflightDecisions();
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
       * A second quit attempt supersedes the old prompt and enters the same non-forced cleanup path.
       * The short timer covers delivery through the preload listener; acknowledgements and decisions
       * must echo the exact main-issued request id, so a delayed renderer cannot authorize a newer prompt.
       */
      if (!canAsk || state.quitConfirmation) {
        invalidateQuitConfirmation(dependencies);
        void runControlledQuit(false);
        return;
      }
      const confirmation = createQuitConfirmation(state, 'ordinary', 'renderer');
      showMainWindow();
      window.webContents.send(CHANNELS.APP_QUIT_REQUESTED, {
        hasBlocking: leases.some(({ severity }) => severity === 'blocking'),
        leases,
        requestId: confirmation.id,
      });
      state.quitConfirmationTimer = setTimeout(() => {
        if (state.quitConfirmation?.id !== confirmation.id) return;
        invalidateQuitConfirmation(dependencies, confirmation.id);
        void runControlledQuit(false);
      }, QUIT_CONFIRMATION_DELIVERY_TIMEOUT_MS);
      state.quitConfirmationTimer.unref();
    } catch (error) {
      invalidateQuitConfirmation(dependencies);
      reportQuitFailure('无法显示退出确认，继续执行安全清理。', error);
      void runControlledQuit(false);
    }
  };

  return {
    beginControlledQuit: runControlledQuit,
    requestQuit,
    shutdownRuntimeForQuit,
  };
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
  app.on('login', (event, webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) {
      return;
    }
    event.preventDefault();
    if (!webContents) {
      callback();
      return;
    }
    const credentials = services
      .resolve(APPLICATION_PROXY_COORDINATOR)
      .credentialsForProxy(webContents.session, authInfo.host, authInfo.port);
    if (!credentials) {
      callback();
      return;
    }
    callback(credentials.username, credentials.password);
  });
  /*
   * A startup failure has to be visible. `runStartupContributions` awaits its steps in order, so one
   * throwing contribution skips every later one — and with the global `unhandledRejection` handler
   * swallowing the result, the app would sit there as a launched process with no window and no
   * services, looking merely slow. Saying so and leaving is far better than a permanent silent
   * no-op, and the log line keeps the original cause.
   */
  void app
    .whenReady()
    .then(onReady)
    .catch((error: unknown) => {
      mainLogger.error('lifecycle', '启动失败，应用无法继续。', error, 'internal');
      const detail = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        'ClaudeDock 启动失败',
        `控制面板初始化时出错，应用即将退出。\n\n${detail}`,
      );
      state.isQuitting = true;
      app.exit(1);
    });

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
    for (const failure of runQuitContributions(finalQuitContributions)) {
      mainLogger.error('lifecycle', '退出清理步骤失败。', failure, 'internal');
    }
    armQuitWatchdog();
  });
};
