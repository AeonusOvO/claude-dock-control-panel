import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
  Session,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import path from 'node:path';
import type {
  AdvancedSettings,
  ApplicationProxyCandidate,
  ApplicationProxyState,
  AppSettingsView,
  ClaudeConfigResult,
  ClaudeConnectionTestResult,
  ClaudeConnectionHistoryResult,
  ClaudeEffortRequest,
  ClaudeLaunchMode,
  ClaudeOperationResult,
  ClaudePermissionDecision,
  ClaudePermissionMode,
  ClaudePluginCatalog,
  ClaudePluginOperationResult,
  ClaudeProjectState,
  ClaudeRelaunchInput,
  ClaudeRouterOperationResult,
  ClaudeRouterInstallSource,
  ClaudeSessionDeleteResult,
  RouterKernelOperationResult,
  RouterKernelState,
  ChatAttachmentBytesImportInput,
  ChatAttachmentImportInput,
  ChatMessage,
  ChatStartInput,
  CloseBehavior,
  CodexLaunchMode,
  CodexLoginMethod,
  CodexLoginStartResult,
  CodexOperationResult,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
  ModelSpeedMode,
  NetworkPreflightAction,
  NetworkPreflightRunInput,
  NetworkProviderId,
  McpCatalog,
  McpBackupView,
  McpInstallInput,
  McpOperationResult,
  McpRemoveInput,
  McpScope,
  McpTogglePreview,
  ManagedChatGptGatewayOperationResult,
  ManagedChatGptSetupStage,
  ClaudeProviderModelDiscoveryInput,
  ClaudeProviderModelDiscoveryResult,
  SoftwareUpdateOperationResult,
  DirectoryChoiceResult,
  OperationResult,
  PtyGeneration,
  RuntimeActivitySnapshot,
  SaveApplicationProxyInput,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
  SaveChatConfigInput,
  SaveChatConversationInput,
  TerminalStatus,
  TerminalWorkspaceState,
  WorkspaceProjectView,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';
import type {
  ConversationControlUpdate,
  ConversationInteractionResponse,
  ConversationSubmitInput,
  NativeAttachmentBytesInput,
  NativeConversationLaunchRequest,
} from '../shared/native-conversation';
import { claudeStateOwnershipIsCurrent } from '../shared/claude-state-ownership';
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../shared/terminal-themes';
import {
  CLAUDE_PROVIDER_EXTERNAL_HOSTS,
  claudeProviderIdSet,
  officialNetworkProviderForClaudePreset,
} from '../shared/claude-providers';
import { selectRouterKernelState } from '../shared/router-kernel';
import { CLAUDE_EFFORT_REQUESTS } from '../shared/claude-effort';
import { claudeRunnableCommands } from '../shared/cli-command-catalog';
import { RuntimeActivityRegistry } from './runtime-activity-registry';
import { ClaudePermissionBridge } from './claude-permission-bridge';
import { ClaudeStreamDiagnosticsStore } from './claude-stream-diagnostics-store';
import { RuntimeProcessRegistry } from './runtime-process-registry';
import {
  ClaudePluginManager,
  isValidMarketplaceName,
  isValidMarketplaceSource,
  isValidPluginId,
} from './claude-plugin-manager';
import {
  ClaudeRuntime,
  type PreparedClaudeConfigSave,
  type PreparedNativeClaudeConversation,
} from './claude-runtime';
import type { SavedRouterProvider } from './claude-router-manager';
import { CodexRuntime } from './codex-runtime';
import { AgentRuntimeStore } from './agent-runtime-store';
import {
  ClaudeSessionManager,
  isValidClaudeSessionId,
  normalizeClaudeSessionTitle,
} from './claude-session-manager';
import { ChatConfigStore } from './chat-config-store';
import { ChatAttachmentStore, isChatAttachmentId } from './chat-attachment-store';
import { ChatHistoryStore } from './chat-history-store';
import { ChatService } from './chat-service';
import { ArtifactService, registerArtifactScheme } from './artifact-service';
import { resolveDirectory } from './directory';
import { directoryDialogDefaultPath, directoryDialogError } from './directory-picker';
import {
  cleanupFailedRuntimeLaunch,
  enteredTerminalFailure,
  TerminalTransitionCoordinator,
} from './terminal-lifecycle';
import { TerminalOutputBatcher } from './terminal-output-batcher';
import {
  ProjectDirectoryLifecycleCoordinator,
  runOwnedProjectDirectoryClosure,
} from './project-directory-lifecycle';
import {
  ClaudeConversationLifecycleCoordinator,
  runOwnedClaudeConversationDeletion,
} from './claude-conversation-lifecycle';
import { sameDirectory, TerminalWorkspace } from './terminal-workspace';
import { WorkspaceStore } from './workspace-store';
import { AdvancedSettingsStore } from './advanced-settings-store';
import { NetworkDiagnosticsStore } from './network-diagnostics-store';
import { NetworkPreflightService } from './network-preflight-service';
import { ProviderAccessGuard } from './provider-access-guard';
import { createElectronApplicationRequest } from './electron-application-request';
import { ProviderConnectivityProbe } from './provider-connectivity-probe';
import {
  OwnedConfigTransactionError,
  ProjectRuntimeSwitchCoordinator,
  runOwnedConfigTransaction,
  SessionConfigTransactionCoordinator,
} from './main-process-operation-coordinator';
import { SessionOperationCoordinator } from './session-operation-coordinator';
import { BusyRegistry } from './busy-registry';
import { DownloadEngine, type DownloadSession } from './download-engine';
import { CcSwitchAdapter } from './cc-switch-adapter';
import {
  ManagedChatGptGateway,
  type ManagedChatGptGatewayProjectConfig,
} from './managed-chatgpt-gateway';
import { McpManager } from './mcp-manager';
import { AppPreferencesStore } from './app-preferences-store';
import { resolveRuntimeProfile } from './runtime-profile';
import { ClaudeAgentAdapter } from './claude-agent-adapter';
import { FakeConversationAdapter } from './fake-conversation-adapter';
import { ConversationOwnerRegistry, type ConversationOwner } from './conversation-owner-registry';
import { ConversationRecoveryStore } from './conversation-recovery-store';
import { NativeConversationService } from './native-conversation-service';
import { IsolatedTerminal } from './isolated-terminal';
import { NativeAttachmentStore } from './native-attachment-store';
import {
  applicationProxyRules,
  applicationProxyUrl,
  buildApplicationProxyEnvironment,
  parseApplicationProxyCandidate,
} from './proxy/application-proxy';
import { ApplicationProxyStore } from './proxy/application-proxy-store';
import { ApplicationUpdaterService, type ApplicationUpdaterDriver } from './application-updater';
import {
  isApplicationUpdateRequestAllowed,
  loadApplicationUpdateSources,
  selectApplicationUpdateSource,
  type ApplicationUpdateSourceSelection,
} from './application-update-sources';
import {
  readHighestTrustedVersion,
  recordHighestTrustedVersion,
  updateVersionFloorPath,
} from './application-update-manifest';

const runtimeProfile = resolveRuntimeProfile({
  defaultHome: homedir(),
  defaultUserData: app.getPath('userData'),
});
if (runtimeProfile.id === 'isolated') {
  for (const directory of Object.values(runtimeProfile.paths)) {
    mkdirSync(directory, { recursive: true });
  }
  app.setPath('home', runtimeProfile.paths.home);
  app.setPath('userData', runtimeProfile.paths.userData);
  app.setPath('sessionData', runtimeProfile.paths.sessionData);
}
app.enableSandbox();
registerArtifactScheme();

/*
 * Electron's default handler turns any stray main-process rejection into a modal
 * "A JavaScript error occurred in the main process" dialog, which is a far worse outcome than a
 * degraded feature. Background work (tray balloons, journal writes, sidecar teardown) is logged and
 * swallowed instead; a genuinely fatal failure still takes the app down through the normal paths.
 */
process.on('uncaughtException', (error) => {
  console.error('[main] 未捕获异常。', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝。', reason);
});

let isQuitting = false;
/*
 * Quitting is a two-step handshake when work is in flight. `before-quit` cannot wait on a promise, so
 * instead of blocking there we cancel the quit, ask the renderer to raise its own themed
 * confirmation, and quit for real only when it answers yes. `quitConfirmationPending` keeps a second
 * quit attempt (tray menu clicked twice, Alt+F4 while the dialog is up) from stacking dialogs.
 */
let quitConfirmationPending = false;
let quitConfirmationTimer: NodeJS.Timeout | undefined;
let quitCleanupInProgress = false;
let quitResidualConfirmationPending = false;
let runtimeShutdownForQuitDone = false;
let claudeRuntime: ClaudeRuntime | null = null;
let codexRuntime: CodexRuntime | null = null;
let networkPreflightService: NetworkPreflightService | null = null;
let providerAccessGuard: ProviderAccessGuard | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let busyRegistry: BusyRegistry | null = null;
let mcpManager: McpManager | null = null;
let downloadEngine: DownloadEngine | null = null;
let ccSwitchAdapter: CcSwitchAdapter | null = null;
let managedChatGptGateway: ManagedChatGptGateway | null = null;
let applicationProxyStore: ApplicationProxyStore | null = null;
let applicationProxyState: ApplicationProxyState | undefined;
let conversationNetworkSession: Session | null = null;
let applicationProxyTestSession: Session | null = null;
let chatFetch: typeof fetch = fetch;
let releaseConversationBusy: (() => void) | undefined;
let applicationUpdaterService: ApplicationUpdaterService | null = null;
let claudePermissionBridge: ClaudePermissionBridge | null = null;
let claudeStreamDiagnosticsStore: ClaudeStreamDiagnosticsStore | null = null;
let runtimeProcessRegistry: RuntimeProcessRegistry | null = null;
let nativeConversationService: NativeConversationService | null = null;
const conversationOwnerRegistry = new ConversationOwnerRegistry();
const terminalConversationOwners = new Map<string, ConversationOwner>();
const terminalTransferSessions = new Set<string>();
const nativeLaunches = new Map<
  string,
  { ownerId: string; prepared: PreparedNativeClaudeConversation }
>();

const releaseTerminalConversationOwner = (sessionId: string): void => {
  const owner = terminalConversationOwners.get(sessionId);
  if (!owner) return;
  conversationOwnerRegistry.release(owner, owner.ownerId, owner.generation);
  terminalConversationOwners.delete(sessionId);
};
const runtimeActivityRegistry = new RuntimeActivityRegistry((state) => {
  mainWindow?.webContents.send('runtime:activity-changed', state);
});

interface PendingPermissionModeProbe {
  ptyGeneration: PtyGeneration;
  resolve: (mode: ClaudePermissionMode | undefined) => void;
  sessionId: string;
  timer: NodeJS.Timeout;
}

const PERMISSION_MODE_PROBE_TIMEOUT_MS = 300;
let nextPermissionModeProbeId = 1;
const pendingPermissionModeProbes = new Map<number, PendingPermissionModeProbe>();

const resolvePendingPermissionModeProbes = (
  sessionId: string,
  ptyGeneration?: PtyGeneration,
): void => {
  for (const [probeId, pending] of pendingPermissionModeProbes) {
    if (
      pending.sessionId !== sessionId ||
      (ptyGeneration !== undefined && pending.ptyGeneration !== ptyGeneration)
    ) {
      continue;
    }
    clearTimeout(pending.timer);
    pendingPermissionModeProbes.delete(probeId);
    pending.resolve(undefined);
  }
};

/**
 * Requests a synchronous fact from the renderer's xterm buffer. Passive PTY output reports keep the
 * footer current, while this request/reply path gives a mode-switch step a fresh before/after
 * barrier and prevents another Shift+Tab from being sent against an unreadable screen.
 */
const requestPermissionModeFromScreen = (
  sessionId: string,
  ptyGeneration: PtyGeneration,
): Promise<ClaudePermissionMode | undefined> =>
  new Promise((resolve) => {
    if (
      !workspace.hasSession(sessionId) ||
      workspace.getStatus(sessionId).ptyGeneration !== ptyGeneration
    ) {
      resolve(undefined);
      return;
    }
    const target = mainWindow?.webContents;
    if (!target || target.isDestroyed()) {
      resolve(undefined);
      return;
    }

    const probeId = nextPermissionModeProbeId;
    nextPermissionModeProbeId =
      nextPermissionModeProbeId >= Number.MAX_SAFE_INTEGER ? 1 : nextPermissionModeProbeId + 1;
    const timer = setTimeout(() => {
      pendingPermissionModeProbes.delete(probeId);
      resolve(undefined);
    }, PERMISSION_MODE_PROBE_TIMEOUT_MS);
    pendingPermissionModeProbes.set(probeId, {
      ptyGeneration,
      resolve,
      sessionId,
      timer,
    });
    try {
      terminalOutputBatcher.flush(sessionId, ptyGeneration);
      target.send('claude:permission-mode-probe', sessionId, ptyGeneration, probeId);
    } catch {
      clearTimeout(timer);
      pendingPermissionModeProbes.delete(probeId);
      resolve(undefined);
    }
  });

const assetPath = (fileName: string): string =>
  path.join(app.getAppPath(), 'assets', 'generated', fileName);
const runtimeAssetPath = (fileName: string): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'runtime', fileName)
    : path.join(app.getAppPath(), 'assets', 'runtime', fileName);

/*
 * PTY output arrives in many small chunks, and one IPC message per chunk was the dominant cost when
 * a command produced a lot of output. Chunks are coalesced for a few milliseconds and sent as one
 * message. `consumeTerminalOutput` still sees every chunk individually — it tracks exit markers
 * across chunk boundaries and must not be fed a merged buffer.
 */
const terminalOutputBatcher = new TerminalOutputBatcher({
  emit: (sessionId, ptyGeneration, data) => {
    mainWindow?.webContents.send('terminal:data', sessionId, ptyGeneration, data);
  },
  isCurrentGeneration: (sessionId, ptyGeneration) =>
    workspace.hasSession(sessionId) &&
    workspace.getStatus(sessionId).ptyGeneration === ptyGeneration,
});

const terminalStatusBaselines = new Map<string, Pick<TerminalStatus, 'phase' | 'ptyGeneration'>>();
const publishedClaudeStateRevisions = new Map<string, number>();

const workspace = new TerminalWorkspace(
  (sessionId, ptyGeneration, data) => {
    runtimeProcessRegistry?.observeTerminalOutput(sessionId, ptyGeneration, data);
    const claudeFiltered =
      claudeRuntime?.consumeTerminalOutput(sessionId, ptyGeneration, data) ?? data;
    const filtered =
      codexRuntime?.consumeTerminalOutput(sessionId, ptyGeneration, claudeFiltered) ??
      claudeFiltered;
    if (filtered) {
      terminalOutputBatcher.queue(sessionId, ptyGeneration, filtered);
    }
  },
  (state) => {
    const liveSessionIds = new Set(state.sessions.map(({ id }) => id));
    for (const status of state.sessions) {
      if (status.phase === 'stopped' || status.phase === 'error') {
        releaseTerminalConversationOwner(status.id);
      }
      const previous = terminalStatusBaselines.get(status.id);
      const enteredFailure = enteredTerminalFailure(previous, status);
      terminalStatusBaselines.set(status.id, {
        phase: status.phase,
        ptyGeneration: status.ptyGeneration,
      });
      if (!enteredFailure) {
        continue;
      }
      terminalOutputBatcher.flush(status.id, status.ptyGeneration);
      resolvePendingPermissionModeProbes(status.id, status.ptyGeneration);
      if (!terminalOperationInvalidationSuppressions.has(status.id)) {
        invalidateDevelopmentSessionOperation(status.id);
      }
      claudeRuntime?.setInactive(status.id, status.ptyGeneration);
      codexRuntime?.setInactive(status.id, status.ptyGeneration);
    }
    for (const sessionId of terminalStatusBaselines.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        releaseTerminalConversationOwner(sessionId);
        invalidateDevelopmentSessionOperation(sessionId);
        claudeRuntime?.closeSession(sessionId);
        codexRuntime?.closeSession(sessionId);
        terminalStatusBaselines.delete(sessionId);
        terminalOutputBatcher.discard(sessionId);
        resolvePendingPermissionModeProbes(sessionId);
      }
    }
    for (const sessionId of publishedClaudeStateRevisions.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        publishedClaudeStateRevisions.delete(sessionId);
      }
    }
    const enriched = describeWorkspace(state);
    mainWindow?.webContents.send('workspace:state', enriched);
    updateTray(enriched);
  },
  runtimeProfile.effects.allowRealRuntimes
    ? undefined
    : (id, initialCwd, initialTitle, _onData, onStatus) =>
        new IsolatedTerminal(id, initialCwd, initialTitle, onStatus),
);

const workspaceStore = new WorkspaceStore(app.getPath('userData'));
const projectDirectoryLifecycle = new ProjectDirectoryLifecycleCoordinator();
const claudeConversationLifecycle = new ClaudeConversationLifecycleCoordinator();
const advancedSettingsStore = new AdvancedSettingsStore(app.getPath('userData'));
const appPreferencesStore = new AppPreferencesStore(app.getPath('userData'));
const agentRuntimeStore = new AgentRuntimeStore(app.getPath('userData'));
workspace.setTheme(workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME);
const sessionManager = new ClaudeSessionManager(runtimeProfile.paths.projects);
const pluginManager = new ClaudePluginManager(runtimeProfile.paths.home);
const chatConfigStore = new ChatConfigStore(app.getPath('userData'));
const chatAttachmentStore = new ChatAttachmentStore(app.getPath('userData'));
const nativeAttachmentStore = new NativeAttachmentStore(runtimeProfile.paths.userData);
nativeAttachmentStore.collectOrphans(new Set());
const chatHistoryStore = new ChatHistoryStore(app.getPath('userData'), chatAttachmentStore);
try {
  chatAttachmentStore.collectOrphans(chatHistoryStore.referencedAttachmentIds());
} catch {
  // Fail closed: unreadable history must never be interpreted as an empty attachment reference set.
}
const chatService = new ChatService(
  chatConfigStore,
  (event) => {
    mainWindow?.webContents.send('chat:stream', event);
  },
  (url, init) => chatFetch(url, init),
  chatAttachmentStore,
  {},
  () => advancedSettingsStore.get().chatIdleTimeoutMinutes * 60_000,
);
const artifactService = new ArtifactService(app.getPath('userData'), (entry) => {
  mainWindow?.webContents.send('artifact:network-log', entry);
});

const currentTurnLocalAttachmentIds = (messages: ChatMessage[]): Set<string> => {
  const message = messages.at(-1);
  if (!message || !Array.isArray(message.content)) {
    return new Set();
  }
  return new Set(
    message.content.flatMap((block) =>
      block.type !== 'text' && block.source.type === 'local' ? [block.source.attachmentId] : [],
    ),
  );
};

/**
 * Merges the live terminal sessions with the folders remembered on disk. A folder stays in the
 * list after its last conversation is closed — closing a tab must never mean forgetting a project.
 */
function describeWorkspace(state: TerminalWorkspaceState = workspace.getState()): WorkspaceState {
  const projects: WorkspaceProjectView[] = [];
  const indexOfPath = (candidate: string): number =>
    projects.findIndex((project) => sameDirectory(project.path, candidate));

  for (const session of state.sessions) {
    const existing = projects[indexOfPath(session.cwd)];
    if (existing) {
      existing.sessionIds.push(session.id);
    } else {
      projects.push({
        missing: false,
        name: path.basename(session.cwd) || session.cwd,
        open: true,
        path: session.cwd,
        remembered: false,
        sessionIds: [session.id],
      });
    }
  }

  for (const stored of workspaceStore.getProjects()) {
    const index = indexOfPath(stored.path);
    if (index >= 0) {
      const project = projects[index];
      if (project) {
        project.lastActiveAt = stored.lastActiveAt;
        project.remembered = true;
      }
      continue;
    }
    projects.push({
      lastActiveAt: stored.lastActiveAt,
      missing: !existsSync(stored.path),
      name: path.basename(stored.path) || stored.path,
      open: false,
      path: stored.path,
      remembered: true,
      sessionIds: [],
    });
  }

  projects.sort((left, right) => {
    if (left.open !== right.open) {
      return left.open ? -1 : 1;
    }
    return (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0);
  });

  return { ...state, projects };
}

const statusText = (status: TerminalStatus): string => {
  switch (status.phase) {
    case 'starting':
      return '终端启动中';
    case 'running':
      return '终端运行中';
    case 'error':
      return '终端出错';
    case 'stopped':
      return '终端已停止';
  }
};

const projectName = (status: TerminalStatus): string => path.basename(status.cwd) || status.cwd;

const sessionLabel = (status: TerminalStatus): string => `${projectName(status)} · ${status.title}`;

const trayIconForState = (state: WorkspaceState): string => {
  if (state.sessions.some((session) => session.phase === 'error')) {
    return assetPath('tray-error.png');
  }
  if (state.sessions.some((session) => session.phase === 'running')) {
    return assetPath('tray-running.png');
  }
  return assetPath('tray-idle.png');
};

const showMainWindow = (): void => {
  if (!mainWindow) {
    return;
  }

  const wasVisible = mainWindow.isVisible() && !mainWindow.isMinimized();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  if (!wasVisible && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('app:window-restored');
  }
};

const hideMainWindowToTray = (): void => {
  mainWindow?.hide();
  /*
   * Hiding to the tray must never surface as a crash dialog. The balloon and the "already told you"
   * flag are both conveniences, so a storage failure downgrades to a log line instead of an
   * uncaught exception in the main process.
   */
  try {
    const preferences = appPreferencesStore.get();
    if (!preferences.closeToTrayNoticeShown && tray) {
      tray.displayBalloon({
        content: 'ClaudeDock 已最小化到托盘，后台继续运行。可在 设置 → 通用 中修改关闭行为。',
        iconType: 'info',
        title: 'ClaudeDock 仍在后台运行',
      });
      appPreferencesStore.set({ closeToTrayNoticeShown: true });
    }
  } catch (error) {
    console.error('[tray] 记录托盘提示状态失败。', error);
  }
};

/**
 * Starts a quit. An explicit quit is always confirmed when the renderer can answer. Busy operations
 * and live terminals are included so the decision explains exactly what will be interrupted.
 */
const requestQuit = (): void => {
  if (isQuitting) {
    return;
  }
  const window = mainWindow;
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
  const leases = [...(busyRegistry?.list() ?? []), ...terminalLeases];
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
  if (!canAsk || quitConfirmationPending) {
    if (quitConfirmationTimer) {
      clearTimeout(quitConfirmationTimer);
      quitConfirmationTimer = undefined;
    }
    quitConfirmationPending = false;
    void beginControlledQuit(true);
    return;
  }
  quitConfirmationPending = true;
  showMainWindow();
  window.webContents.send('app:quit-requested', {
    hasBlocking: leases.some(({ severity }) => severity === 'blocking'),
    leases,
  });
  quitConfirmationTimer = setTimeout(() => {
    if (!quitConfirmationPending) {
      return;
    }
    quitConfirmationPending = false;
    quitConfirmationTimer = undefined;
    void beginControlledQuit(true);
  }, 3_000);
  quitConfirmationTimer.unref();
};

async function beginControlledQuit(forceWithResidualProcesses: boolean): Promise<void> {
  if (isQuitting || quitCleanupInProgress) return;
  quitCleanupInProgress = true;
  // Closing the per-launch pipe endpoints both releases existing requests to Claude's native
  // prompt and prevents a new permission request from entering while the quit barrier runs.
  claudePermissionBridge?.shutdown();
  try {
    const nativeAttachmentOwners = nativeConversationService?.activeIds() ?? [];
    await nativeConversationService?.closeAll();
    await Promise.all(
      nativeAttachmentOwners.map((conversationId) =>
        nativeAttachmentStore.releaseConversation(conversationId),
      ),
    );
    let processCleanupFailed = false;
    try {
      await runtimeProcessRegistry?.terminateAll();
    } catch {
      processCleanupFailed = true;
    }
    const residual = runtimeProcessRegistry?.list() ?? [];
    if ((processCleanupFailed || residual.length > 0) && !forceWithResidualProcesses) {
      const target = mainWindow?.webContents;
      if (target && !target.isDestroyed() && !target.isCrashed()) {
        quitResidualConfirmationPending = true;
        quitConfirmationPending = true;
        showMainWindow();
        target.send('app:quit-requested', {
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
        return;
      }
    }
    shutdownRuntimeForQuit();
    runtimeProcessRegistry?.stop();
    isQuitting = true;
    app.quit();
  } finally {
    quitCleanupInProgress = false;
  }
}

function shutdownRuntimeForQuit(): void {
  if (runtimeShutdownForQuitDone) return;
  runtimeShutdownForQuitDone = true;
  claudePermissionBridge?.shutdown();
  chatService.shutdown();
  claudeRuntime?.shutdown();
  managedChatGptGateway?.shutdown();
  codexRuntime?.dispose();
  workspace.shutdown();
}

const chooseDirectory = async (ownerWindow?: BrowserWindow): Promise<DirectoryChoiceResult> => {
  const defaultPath = directoryDialogDefaultPath(
    workspace.getActiveStatus()?.cwd ?? runtimeProfile.paths.home,
    runtimeProfile.paths.home,
  );
  const options: Electron.OpenDialogOptions = {
    buttonLabel: '添加此项目',
    ...(defaultPath ? { defaultPath } : {}),
    properties: ['openDirectory'],
    title: '添加项目文件夹',
  };
  let result: Electron.OpenDialogReturnValue;
  try {
    result =
      ownerWindow && !ownerWindow.isDestroyed()
        ? await dialog.showOpenDialog(ownerWindow, options)
        : await dialog.showOpenDialog(options);
  } catch (ownedDialogError) {
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      return { canceled: true, error: directoryDialogError(ownedDialogError) };
    }
    try {
      // A stale Windows owner handle can reject the native dialog. Retry once without a parent.
      result = await dialog.showOpenDialog(options);
    } catch (unownedDialogError) {
      return { canceled: true, error: directoryDialogError(unownedDialogError) };
    }
  }

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }

  try {
    return {
      canceled: false,
      path: resolveDirectory(result.filePaths[0]),
    };
  } catch (error) {
    return {
      canceled: true,
      error: error instanceof Error ? error.message : '所选文件夹无法访问。',
    };
  }
};

const operationFromStatus = (status: TerminalStatus): OperationResult => ({
  error: status.phase === 'error' ? status.message : undefined,
  ok: status.phase !== 'error',
  status,
});

const failedWorkspaceResult = (error: unknown): WorkspaceResult => ({
  error: error instanceof Error ? error.message : '项目操作失败。',
  ok: false,
  state: describeWorkspace(),
});

const validateProjectPath = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error('项目路径格式无效。');
  }
  return path.resolve(value);
};

const addProject = (directoryPath: string): WorkspaceResult => {
  try {
    const resolved = resolveDirectory(directoryPath);
    return projectDirectoryLifecycle.runOpenSync(resolved, (ownership) => {
      ownership.assertCurrent();
      const result = workspace.openProject(resolved);

      // Save to persistent workspace only while this open still owns the folder lifecycle.
      ownership.assertCurrent();
      workspaceStore.addProject(resolved);

      return {
        ok: true,
        reused: result.reused,
        state: describeWorkspace(result.state),
      };
    });
  } catch (error) {
    return failedWorkspaceResult(error);
  }
};

const activateProject = (sessionId: string): WorkspaceState => {
  const state = workspace.activate(sessionId);
  const active = state.sessions.find((session) => session.id === state.activeSessionId);
  if (active) {
    workspaceStore.updateLastActive(active.cwd);
  }
  return describeWorkspace(state);
};

const deleteClaudeConversation = async (
  cwd: string,
  conversationId: string,
): Promise<ClaudeSessionDeleteResult> => {
  const runtime = requireClaudeRuntime();
  const result = await runOwnedClaudeConversationDeletion({
    closeRuntimeSession: (sessionId) => {
      runtime.closeSession(sessionId);
      codexRuntime?.closeSession(sessionId);
    },
    closeWorkspaceSession: (sessionId) => {
      workspace.close(sessionId);
    },
    conversationId,
    coordinator: claudeConversationLifecycle,
    cwd,
    deleteTranscript: () => sessionManager.deleteSession(cwd, conversationId),
    isSessionInDirectory: (sessionId, targetCwd) =>
      workspace.hasSession(sessionId) &&
      sameDirectory(workspace.getStatus(sessionId).cwd, targetCwd),
    readState: describeWorkspace,
    removePreferences: () => runtime.removeConversationPreferences(conversationId),
    runWithSessionOwnership: async (sessionId, operation) => {
      if (!workspace.hasSession(sessionId)) {
        return;
      }
      try {
        await developmentSessionOperations.runLatest(sessionId, async (assertCurrent) => {
          assertCurrent();
          operation();
        });
      } catch (error) {
        if (!workspace.hasSession(sessionId)) {
          return;
        }
        throw error;
      }
    },
    sessionIdsForConversation: () => runtime.sessionIdsForConversation(cwd, conversationId),
    sessionOwnsConversation: (sessionId) =>
      runtime.sessionOwnsConversation(sessionId, cwd, conversationId),
  });
  return result.deleted
    ? { deleted: true, ok: true, state: result.state }
    : {
        deleted: false,
        error: '历史对话文件已不存在或无法删除。',
        ok: false,
        state: result.state,
      };
};

const pickDirectoryFromTray = async (): Promise<void> => {
  try {
    showMainWindow();
    const choice = await chooseDirectory(mainWindow ?? undefined);
    if (!choice.canceled) {
      const added = addProject(choice.path);
      if (!added.ok) {
        throw new Error(added.error ?? '无法添加该项目。');
      }
    } else if (choice.error) {
      throw new Error(choice.error);
    }
  } catch (error) {
    await dialog.showMessageBox({
      message: error instanceof Error ? error.message : '无法打开该文件夹。',
      title: '添加项目失败',
      type: 'error',
    });
  }
};

function updateTray(state = describeWorkspace()): void {
  if (!tray) {
    return;
  }

  const activeStatus =
    state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0];
  const runningCount = state.sessions.filter((session) => session.phase === 'running').length;
  const openProjects = state.projects.filter((project) => project.open);
  const leases = busyRegistry?.list() ?? [];
  const downloadLeases = leases.filter(({ kind }) => kind === 'download');
  const blockingLeases = leases.filter(({ severity }) => severity === 'blocking');
  // One submenu per folder so a project with several conversations reads as one project.
  const projectMenu: MenuItemConstructorOptions[] = openProjects.map((project) => ({
    label: project.name,
    submenu: project.sessionIds.map((sessionId) => {
      const status = state.sessions.find((session) => session.id === sessionId);
      return {
        checked: sessionId === state.activeSessionId,
        click: () => {
          activateProject(sessionId);
          showMainWindow();
        },
        label: status ? `${status.title} · ${statusText(status)}` : sessionId,
        type: 'radio' as const,
      };
    }),
  }));

  const icon = nativeImage.createFromPath(trayIconForState(state));
  tray.setImage(icon);
  const workSummary =
    leases.length === 0
      ? '后台空闲'
      : `${leases.length} 项后台任务${blockingLeases.length > 0 ? `，${blockingLeases.length} 项不可中断` : ''}`;
  tray.setToolTip(
    [
      `ClaudeDock · ${openProjects.length} 个项目 · ${runningCount}/${state.sessions.length} 个对话运行中`,
      workSummary,
      activeStatus?.cwd,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        enabled: false,
        label: `项目：${openProjects.length} 个 · 对话：${state.sessions.length} 个 · 运行中：${runningCount} 个`,
      },
      {
        enabled: projectMenu.length > 0,
        label: '切换对话',
        submenu: projectMenu,
      },
      {
        click: () => {
          void pickDirectoryFromTray();
        },
        label: '添加项目…',
      },
      { type: 'separator' },
      {
        click: showMainWindow,
        label: '显示控制面板',
      },
      ...(downloadLeases.length > 0
        ? [
            {
              click: () => {
                showMainWindow();
                mainWindow?.webContents.send('app:open-download-center');
              },
              label: `打开下载中心（${downloadLeases.length}）`,
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      ...(activeStatus
        ? [
            {
              click: () => {
                void directTerminalTransitions
                  .run(activeStatus.id, activeStatus.ptyGeneration, () =>
                    workspace.restart(activeStatus.id),
                  )
                  .catch(() => {});
              },
              label: `重启 ${sessionLabel(activeStatus)}`,
            } satisfies MenuItemConstructorOptions,
            {
              click: () => {
                void directTerminalTransitions
                  .run(activeStatus.id, activeStatus.ptyGeneration, () =>
                    activeStatus.phase === 'running'
                      ? workspace.stop(activeStatus.id)
                      : workspace.start(activeStatus.id),
                  )
                  .catch(() => {});
              },
              label: activeStatus.phase === 'running' ? '停止当前终端' : '启动当前终端',
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      { type: 'separator' },
      {
        click: requestQuit,
        label: '退出 ClaudeDock',
      },
    ]),
  );
}

const validateSender = (event: IpcMainEvent | IpcMainInvokeEvent): void => {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Rejected IPC from an unknown renderer.');
  }
};

const validateSessionId = (sessionId: unknown): string => {
  if (typeof sessionId !== 'string' || !/^session-\d{1,10}$/.test(sessionId)) {
    throw new Error('项目会话标识无效。');
  }
  return sessionId;
};

const validatePtyGeneration = (value: unknown): PtyGeneration => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('终端代次无效。');
  }
  return value;
};

const requireClaudeRuntime = (): ClaudeRuntime => {
  if (!claudeRuntime) {
    throw new Error('Claude 工作台尚未初始化。');
  }
  return claudeRuntime;
};

const assertRuntimeEffect = (allowed: boolean, message: string): void => {
  if (!allowed) throw new Error(message);
};

const assertRealRuntimeAllowed = (): void =>
  assertRuntimeEffect(
    runtimeProfile.effects.allowRealRuntimes,
    '隔离运行配置禁止启动真实 PowerShell、Claude Code 或 Codex。',
  );

const assertExternalRoutingWritesAllowed = (): void =>
  assertRuntimeEffect(
    runtimeProfile.effects.allowExternalRoutingWrites,
    '隔离运行配置禁止写入真实接入、路由或 MCP 配置。',
  );

const assertPluginMutationsAllowed = (): void =>
  assertRuntimeEffect(
    runtimeProfile.effects.allowPluginMutations,
    '隔离运行配置禁止修改真实 Claude Code 插件。',
  );

const assertApplicationUpdatesAllowed = (): void =>
  assertRuntimeEffect(
    runtimeProfile.effects.allowApplicationUpdates,
    '隔离运行配置禁止下载、安装或应用真实软件更新。',
  );

const requireNativeConversationService = (): NativeConversationService => {
  if (!nativeConversationService) {
    throw new Error('原生对话服务尚未初始化。');
  }
  return nativeConversationService;
};

const validateConversationId = (value: unknown): string => {
  if (typeof value !== 'string' || !isValidClaudeSessionId(value)) {
    throw new Error('原生对话 UUID 无效。');
  }
  return value.toLowerCase();
};

const validateNativeSubmitInput = (value: unknown): ConversationSubmitInput => {
  if (!value || typeof value !== 'object') throw new Error('原生对话输入格式无效。');
  const record = value as Partial<ConversationSubmitInput>;
  if (
    typeof record.clientSubmissionId !== 'string' ||
    !record.clientSubmissionId ||
    record.clientSubmissionId.length > 200 ||
    !Array.isArray(record.blocks) ||
    record.blocks.length === 0 ||
    record.blocks.length > 20
  ) {
    throw new Error('原生对话输入格式无效。');
  }
  for (const block of record.blocks) {
    if (!block || typeof block !== 'object') throw new Error('原生对话内容块无效。');
    if (block.type === 'text') {
      if (typeof block.text !== 'string' || !block.text || block.text.length > 2_000_000) {
        throw new Error('原生对话文本为空或过长。');
      }
      continue;
    }
    if (
      block.type !== 'image' ||
      !block.attachment ||
      typeof block.attachment.id !== 'string' ||
      !isValidClaudeSessionId(block.attachment.id) ||
      typeof block.attachment.mediaType !== 'string' ||
      typeof block.attachment.name !== 'string' ||
      typeof block.attachment.size !== 'number'
    ) {
      throw new Error('原生对话附件格式无效。');
    }
  }
  return record as ConversationSubmitInput;
};

const resolveNativeSubmitAttachments = (
  conversationId: string,
  input: ConversationSubmitInput,
): ConversationSubmitInput => ({
  ...input,
  blocks: input.blocks.map((block) =>
    block.type === 'text'
      ? block
      : {
          attachment: nativeAttachmentStore.resolve(conversationId, block.attachment.id),
          type: 'image' as const,
        },
  ),
});

const validateNativeInteractionResponse = (value: unknown): ConversationInteractionResponse => {
  if (!value || typeof value !== 'object') throw new Error('原生交互响应无效。');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new Error('原生交互响应过大。');
  const response = value as Partial<ConversationInteractionResponse>;
  if (!['allow', 'deny', 'cancel', 'submit'].includes(response.action ?? '')) {
    throw new Error('原生交互响应动作无效。');
  }
  return value as ConversationInteractionResponse;
};

const validateNativeControlUpdate = (value: unknown): ConversationControlUpdate => {
  if (!value || typeof value !== 'object') throw new Error('模型控制参数无效。');
  const update = value as Partial<ConversationControlUpdate>;
  if (
    !Number.isSafeInteger(update.expectedCapabilityRevision) ||
    Number(update.expectedCapabilityRevision) < 0 ||
    (update.model !== undefined &&
      (typeof update.model !== 'string' || update.model.length > 200)) ||
    (update.effort !== undefined &&
      !['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].includes(update.effort)) ||
    (update.fast !== undefined && typeof update.fast !== 'boolean') ||
    (update.permissionMode !== undefined &&
      !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(
        update.permissionMode,
      ))
  ) {
    throw new Error('模型控制参数无效。');
  }
  return update as ConversationControlUpdate;
};

const requireCodexRuntime = (): CodexRuntime => {
  if (!codexRuntime) {
    throw new Error('Codex 工作台尚未初始化。');
  }
  return codexRuntime;
};

const requireDownloadEngine = (): DownloadEngine => {
  if (!downloadEngine) {
    throw new Error('下载引擎尚未初始化。');
  }
  return downloadEngine;
};

const requireCcSwitchAdapter = (): CcSwitchAdapter => {
  if (!ccSwitchAdapter) {
    throw new Error('CC Switch 适配器尚未初始化。');
  }
  return ccSwitchAdapter;
};

const requireManagedChatGptGateway = (): ManagedChatGptGateway => {
  if (!managedChatGptGateway) {
    throw new Error('ChatGPT 托管网关尚未初始化。');
  }
  return managedChatGptGateway;
};

const requireMcpManager = (): McpManager => {
  if (!mcpManager) {
    throw new Error('MCP 管理器尚未初始化。');
  }
  return mcpManager;
};

const getRouterKernelState = async (): Promise<RouterKernelState> => {
  const [ccr, ccSwitch] = await Promise.all([
    requireClaudeRuntime().getRouterManagementState(),
    requireCcSwitchAdapter().getState(),
  ]);
  return selectRouterKernelState(ccr, ccSwitch);
};

const withBlockingRouterTask = async <T>(
  id: string,
  label: string,
  action: () => Promise<T>,
): Promise<T> => {
  const release = busyRegistry?.acquire({
    cancellable: false,
    id,
    kind:
      id.includes('uninstall') || id.includes('delete')
        ? 'uninstall'
        : id.includes('install')
          ? 'install'
          : 'configure',
    label,
    severity: 'blocking',
  });
  try {
    return await action();
  } finally {
    release?.();
  }
};

const routerKernelFailure = async (
  error: unknown,
  fallback: string,
): Promise<RouterKernelOperationResult> => {
  const message = error instanceof Error ? error.message : fallback;
  return {
    error: message,
    message,
    ok: false,
    state: await getRouterKernelState(),
  };
};

/** Chromium closes live sockets whenever proxy rules change, so identical rules are de-duplicated. */
let appliedApplicationProxyRules = '';
let appliedConversationProxyRules = '';

const requireApplicationProxyStore = (): ApplicationProxyStore => {
  if (!applicationProxyStore) throw new Error('应用代理服务尚未初始化。');
  return applicationProxyStore;
};

const applicationProxyView = (): ApplicationProxyState => ({
  config: requireApplicationProxyStore().getView(),
  test: applicationProxyState?.test,
});

const publishApplicationProxyState = (): ApplicationProxyState => {
  applicationProxyState = applicationProxyView();
  mainWindow?.webContents.send('application-proxy:changed', applicationProxyState);
  return applicationProxyState;
};

const applyApplicationProxyScope = async (): Promise<void> => {
  if (!applicationProxyStore) return;
  const rules = applicationProxyRules(applicationProxyStore.getView(), 'application');
  const signature = JSON.stringify(rules);
  if (signature === appliedApplicationProxyRules) return;
  appliedApplicationProxyRules = signature;
  await session.defaultSession.setProxy(rules);
  await session.defaultSession.closeAllConnections();
};

const applyConversationProxyScope = async (): Promise<void> => {
  if (!applicationProxyStore || !conversationNetworkSession) return;
  const rules = applicationProxyRules(applicationProxyStore.getView(), 'conversation');
  const signature = JSON.stringify(rules);
  if (signature === appliedConversationProxyRules) return;
  appliedConversationProxyRules = signature;
  await conversationNetworkSession.setProxy(rules);
  await conversationNetworkSession.closeAllConnections();
};

const detectApplicationProxyCandidates = async (): Promise<ApplicationProxyCandidate[]> => {
  const candidates = new Map<string, ApplicationProxyCandidate>();
  const addCandidate = (candidate: ApplicationProxyCandidate | undefined): void => {
    if (candidate) {
      candidates.set(`${candidate.protocol}:${candidate.host}:${candidate.port}`, candidate);
    }
  };
  for (const variable of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY']) {
    addCandidate(parseApplicationProxyCandidate(process.env[variable], `环境变量 ${variable}`));
  }
  try {
    const detectionSession = session.fromPartition('claudedock-system-proxy-detection');
    await detectionSession.setProxy({ mode: 'system' });
    const resolved = await detectionSession.resolveProxy('https://github.com');
    for (const entry of resolved.split(';')) {
      const [scheme, endpoint] = entry.trim().split(/\s+/);
      if (!endpoint || scheme === 'DIRECT') continue;
      const prefix = scheme === 'SOCKS5' || scheme === 'SOCKS' ? 'socks5' : 'http';
      addCandidate(parseApplicationProxyCandidate(`${prefix}://${endpoint}`, 'Windows 系统代理'));
    }
  } catch {
    // No system proxy configured is a perfectly normal answer.
  }
  return [...candidates.values()];
};

const testApplicationProxy = async (): Promise<ApplicationProxyState> => {
  const store = requireApplicationProxyStore();
  const config = store.getView();
  if (!config.enabled || !applicationProxyTestSession) {
    throw new Error('请先保存并启用应用代理。');
  }
  const testConfig = { ...config, scope: { ...config.scope, application: true } };
  await applicationProxyTestSession.setProxy(applicationProxyRules(testConfig, 'application'));
  await applicationProxyTestSession.closeAllConnections();
  const startedAt = Date.now();
  try {
    const response = await applicationProxyTestSession.fetch('https://github.com/', {
      cache: 'no-store',
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    const latencyMs = Date.now() - startedAt;
    applicationProxyState = {
      config,
      test: {
        checkedAt: Date.now(),
        latencyMs,
        message: response.ok
          ? `已通过该代理访问 GitHub（HTTP ${response.status}）。`
          : `代理已响应，但 GitHub 返回 HTTP ${response.status}。`,
        ok: response.ok,
      },
    };
  } catch (error) {
    applicationProxyState = {
      config,
      test: {
        checkedAt: Date.now(),
        message: `代理连接失败：${error instanceof Error ? error.message : '未知网络错误'}`,
        ok: false,
      },
    };
  }
  mainWindow?.webContents.send('application-proxy:changed', applicationProxyState);
  return applicationProxyState;
};

const assertOfficialProviderAllowed = async (
  provider: NetworkProviderId,
  action: NetworkPreflightAction,
  cwd?: string,
  networkScope?: 'conversation',
): Promise<void> => {
  void networkScope;
  await requireProviderAccessGuard().assertAllowed(provider, action, cwd);
};

const validateDownloadTaskId = (taskId: unknown): string => {
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(taskId)) {
    throw new Error('下载任务标识无效。');
  }
  return taskId;
};

const requireNetworkPreflightService = (): NetworkPreflightService => {
  if (!networkPreflightService) {
    throw new Error('网络预检服务尚未初始化。');
  }
  return networkPreflightService;
};

const requireProviderAccessGuard = (): ProviderAccessGuard => {
  if (!providerAccessGuard) {
    throw new Error('官方服务访问守卫尚未初始化。');
  }
  return providerAccessGuard;
};

const DEVELOPMENT_RUNTIMES = new Set<DevelopmentRuntime>(['claude', 'codex']);
const NETWORK_PROVIDERS = new Set<NetworkProviderId>([
  'anthropic-claude',
  'openai-api',
  'openai-codex',
]);
const NETWORK_PREFLIGHT_ACTIONS = new Set<NetworkPreflightAction>([
  'background',
  'cli-launch',
  'cloud-task',
  'first-request',
  'login',
  'provider-switch',
]);

const validateDevelopmentRuntime = (value: unknown): DevelopmentRuntime => {
  if (typeof value !== 'string' || !DEVELOPMENT_RUNTIMES.has(value as DevelopmentRuntime)) {
    throw new Error('开发引擎标识无效。');
  }
  return value as DevelopmentRuntime;
};

const validateNetworkProvider = (value: unknown): NetworkProviderId => {
  if (typeof value !== 'string' || !NETWORK_PROVIDERS.has(value as NetworkProviderId)) {
    throw new Error('网络预检服务商标识无效。');
  }
  return value as NetworkProviderId;
};

const validateNetworkPreflightAction = (value: unknown): NetworkPreflightAction => {
  if (
    typeof value !== 'string' ||
    !NETWORK_PREFLIGHT_ACTIONS.has(value as NetworkPreflightAction)
  ) {
    throw new Error('网络预检动作标识无效。');
  }
  return value as NetworkPreflightAction;
};

const officialProviderForChat = (): NetworkProviderId | undefined => {
  try {
    const hostname = new URL(chatConfigStore.getView().baseUrl).hostname.toLowerCase();
    if (hostname === 'api.anthropic.com') {
      return 'anthropic-claude';
    }
    if (hostname === 'api.openai.com' || hostname === 'chatgpt.com') {
      return hostname === 'api.openai.com' ? 'openai-api' : 'openai-codex';
    }
  } catch {
    // The chat config store already validates URLs; a malformed legacy value is treated as custom.
  }
  return undefined;
};

const validateClaudeLaunchMode = (mode: unknown): ClaudeLaunchMode => {
  if (mode !== 'new' && mode !== 'continue' && mode !== 'resume') {
    throw new Error('Claude 会话启动方式无效。');
  }
  return mode;
};

const validateCodexLaunchMode = (mode: unknown): CodexLaunchMode => validateClaudeLaunchMode(mode);

const validateCodexLoginMethod = (method: unknown): CodexLoginMethod => {
  if (method !== 'browser' && method !== 'device-code') {
    throw new Error('Codex 登录方式无效。');
  }
  return method;
};

const CLAUDE_PERMISSION_MODES = new Set<ClaudePermissionMode>([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

const validateClaudePermissionMode = (mode: unknown): ClaudePermissionMode => {
  if (typeof mode !== 'string' || !CLAUDE_PERMISSION_MODES.has(mode as ClaudePermissionMode)) {
    throw new Error('权限模式标识无效。');
  }
  return mode as ClaudePermissionMode;
};

const validateClaudeEffortRequest = (effort: unknown): ClaudeEffortRequest => {
  if (typeof effort !== 'string' || !CLAUDE_EFFORT_REQUESTS.has(effort as ClaudeEffortRequest)) {
    throw new Error('思考程度标识无效。');
  }
  return effort as ClaudeEffortRequest;
};

const validateModelSpeedMode = (mode: unknown): ModelSpeedMode => {
  if (mode !== 'fast' && mode !== 'standard') {
    throw new Error('模型服务速度标识无效。');
  }
  return mode;
};

/** Option identifiers are minted by `getModelOptions`; anything else never reaches the terminal. */
const validateModelOptionId = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^(?:current|history-[a-z0-9]{1,16}-[a-z0-9]{1,16})$/.test(value.replace(/^history:/, ''))
  ) {
    throw new Error('模型选项标识无效。');
  }
  return value;
};

const validateClaudeRelaunchInput = (input: unknown): ClaudeRelaunchInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('会话重启参数无效。');
  }
  const value = input as Record<string, unknown>;
  if (typeof value.compactFirst !== 'boolean') {
    throw new Error('会话重启参数无效。');
  }
  return {
    compactFirst: value.compactFirst,
    entryId: value.entryId === undefined ? undefined : validateHistoryEntryId(value.entryId),
    permissionMode:
      value.permissionMode === undefined
        ? undefined
        : validateClaudePermissionMode(value.permissionMode),
  };
};

const validateClaudeConfigInput = (input: unknown): SaveClaudeConfigInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('Claude 接入配置格式无效。');
  }
  const value = input as Record<string, unknown>;
  if (
    (value.provider !== 'anthropic' && value.provider !== 'gateway') ||
    typeof value.preset !== 'string' ||
    !claudeProviderIdSet.has(value.preset) ||
    (value.authMode !== 'apiKey' &&
      value.authMode !== 'authToken' &&
      value.authMode !== 'existing' &&
      value.authMode !== 'none') ||
    (value.credentialAction !== 'clear' &&
      value.credentialAction !== 'keep' &&
      value.credentialAction !== 'replace') ||
    (value.apiKeyHelperPolicy !== undefined &&
      value.apiKeyHelperPolicy !== 'inherit' &&
      value.apiKeyHelperPolicy !== 'prefer-claudedock') ||
    typeof value.baseUrl !== 'string' ||
    typeof value.model !== 'string' ||
    (value.modelFast !== undefined && typeof value.modelFast !== 'string') ||
    (value.credential !== undefined && typeof value.credential !== 'string') ||
    (value.protocol !== undefined &&
      value.protocol !== 'anthropic' &&
      value.protocol !== 'openai') ||
    (value.routerProviderId !== undefined && typeof value.routerProviderId !== 'string')
  ) {
    throw new Error('Claude 接入配置包含无效字段。');
  }

  return {
    apiKeyHelperPolicy: value.apiKeyHelperPolicy as SaveClaudeConfigInput['apiKeyHelperPolicy'],
    authMode: value.authMode,
    baseUrl: value.baseUrl,
    credential: value.credential,
    credentialAction: value.credentialAction,
    model: value.model,
    modelFast: value.modelFast,
    preset: value.preset as SaveClaudeConfigInput['preset'],
    protocol: value.protocol as SaveClaudeConfigInput['protocol'],
    provider: value.provider,
    routerProviderId: value.routerProviderId,
  };
};

const validateClaudeRouterProviderInput = (input: unknown): SaveClaudeRouterProviderInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('路由器服务提供方配置格式无效。');
  }
  const value = input as Record<string, unknown>;
  if (
    (value.id !== undefined && typeof value.id !== 'string') ||
    typeof value.name !== 'string' ||
    typeof value.baseUrl !== 'string' ||
    !Array.isArray(value.models) ||
    !value.models.every((model) => typeof model === 'string') ||
    (value.protocol !== 'anthropic_messages' &&
      value.protocol !== 'openai_chat_completions' &&
      value.protocol !== 'openai_responses') ||
    (value.credentialAction !== 'clear' &&
      value.credentialAction !== 'keep' &&
      value.credentialAction !== 'replace') ||
    (value.apiKey !== undefined && typeof value.apiKey !== 'string') ||
    typeof value.makePreferred !== 'boolean' ||
    typeof value.useForCurrentProject !== 'boolean'
  ) {
    throw new Error('路由器服务提供方配置包含无效字段。');
  }
  return {
    apiKey: value.apiKey,
    baseUrl: value.baseUrl,
    credentialAction: value.credentialAction,
    id: value.id,
    makePreferred: value.makePreferred,
    models: value.models,
    name: value.name,
    protocol: value.protocol,
    useForCurrentProject: value.useForCurrentProject,
  };
};

const allowedExternalHosts = new Set([
  ...CLAUDE_PROVIDER_EXTERNAL_HOSTS,
  'api-docs.deepseek.com',
  'ccrdesk.top',
  'code.claude.com',
  'docs.litellm.ai',
  'github.com',
  'musistudio.github.io',
]);
const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const validateHistoryEntryId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^history-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/.test(value)) {
    throw new Error('接入记录标识无效。');
  }
  return value;
};

const validateExternalUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('外部链接格式无效。');
  }
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const allowedHttps = parsed.protocol === 'https:' && allowedExternalHosts.has(hostname);
  const allowedLoopback =
    parsed.protocol === 'http:' && loopbackHosts.has(hostname) && parsed.port === '3458';
  if (
    (!allowedHttps && !allowedLoopback) ||
    parsed.username ||
    parsed.password ||
    parsed.protocol === 'file:'
  ) {
    throw new Error('该链接不在 ClaudeDock 允许打开的帮助或本机管理地址中。');
  }
  return parsed.toString();
};

const validateMarkdownExternalUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/u.test(value)) {
    throw new Error('对话链接格式无效。');
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' &&
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'mailto:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('只允许打开 HTTP、HTTPS 或邮件链接。');
  }
  return parsed.toString();
};

const claudeCommands = claudeRunnableCommands();

const claudeFailure = async (sessionId: string, error: unknown): Promise<ClaudeOperationResult> => {
  const runtime = requireClaudeRuntime();
  const status = workspace.getStatus(sessionId);
  return {
    error: error instanceof Error ? error.message : 'Claude Code 操作失败。',
    ok: false,
    state: await runtime.getState(sessionId, status.cwd),
  };
};

/** Serializes launch-time PTY mutation across Claude and Codex for each workspace session. */
const developmentSessionOperations = new SessionOperationCoordinator((sessionId) =>
  workspace.hasSession(sessionId),
);
const projectRuntimeSwitchOperations = new ProjectRuntimeSwitchCoordinator({
  cleanupBeforeCommit: async (_cwd, selected) => {
    if (selected === 'codex') {
      await requireClaudeRuntime().stopUnusedRoutingServices();
    }
  },
  commitRuntime: (cwd, selected) => agentRuntimeStore.set(cwd, selected),
  getCurrentRuntime: (cwd) => agentRuntimeStore.get(cwd),
  getSession: (sessionId) =>
    workspace.hasSession(sessionId) ? workspace.getStatus(sessionId) : undefined,
  hasActiveRuntime: (sessionId) =>
    requireClaudeRuntime().isActive(sessionId) || requireCodexRuntime().isActive(sessionId),
  invalidateAndWait: (sessionId) => developmentSessionOperations.invalidateAndWait(sessionId),
  prepareProvider: async (cwd, selected) => {
    const officialProvider =
      selected === 'codex' ? 'openai-codex' : requireClaudeRuntime().officialNetworkProvider(cwd);
    if (officialProvider) {
      await assertOfficialProviderAllowed(officialProvider, 'provider-switch', cwd);
    }
  },
  sessionsForDirectory: (cwd) =>
    workspace.sessionIdsForDirectory(cwd).map((sessionId) => workspace.getStatus(sessionId)),
});
const managedConfigTransactions = new SessionConfigTransactionCoordinator();
const terminalOperationInvalidationSuppressions = new Set<string>();

const invalidateDevelopmentSessionOperation = (sessionId: string): void => {
  developmentSessionOperations.invalidate(sessionId);
};

const invalidateAndWaitForDevelopmentSessionOperation = (sessionId: string): Promise<void> =>
  developmentSessionOperations.invalidateAndWait(sessionId);

const acquireConfigTransactionIsolation = (sessionId: string, cwd: string): Promise<void> =>
  managedConfigTransactions.acquireDevelopmentIsolation(
    sessionId,
    cwd,
    workspace.sessionIdsForDirectory(cwd),
    invalidateAndWaitForDevelopmentSessionOperation,
  );

const withDevelopmentSessionOperation = <T>(
  sessionId: string,
  operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const initialStatus = workspace.getStatus(sessionId);
  projectRuntimeSwitchOperations.assertDevelopmentOperationAllowed(initialStatus.cwd);
  managedConfigTransactions.assertDevelopmentOperationAllowed(initialStatus.cwd, sessionId);
  return developmentSessionOperations.run(sessionId, (assertSessionCurrent, signal) =>
    operation(() => {
      assertSessionCurrent();
      const currentStatus = workspace.getStatus(sessionId);
      if (!sameDirectory(currentStatus.cwd, initialStatus.cwd)) {
        throw new Error('开发会话已不再属于发起操作时的项目。');
      }
      projectRuntimeSwitchOperations.assertDevelopmentOperationAllowed(currentStatus.cwd);
      managedConfigTransactions.assertDevelopmentOperationAllowed(currentStatus.cwd, sessionId);
    }, signal),
  );
};

const withoutTerminalOperationInvalidation = <T>(sessionId: string, operation: () => T): T => {
  terminalOperationInvalidationSuppressions.add(sessionId);
  try {
    return operation();
  } finally {
    terminalOperationInvalidationSuppressions.delete(sessionId);
  }
};

const directTerminalTransitionDependencies = {
  deactivateRuntimes: (sessionId: string, expectedGeneration: PtyGeneration) => {
    claudeRuntime?.setInactive(sessionId, expectedGeneration);
    codexRuntime?.setInactive(sessionId, expectedGeneration);
  },
  discardOutput: (sessionId: string, expectedGeneration: PtyGeneration) => {
    terminalOutputBatcher.discard(sessionId, expectedGeneration);
  },
  getPtyGeneration: (sessionId: string) => workspace.getStatus(sessionId).ptyGeneration,
  invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,
  resolveProbes: resolvePendingPermissionModeProbes,
  withInvalidationSuppressed: withoutTerminalOperationInvalidation,
};
const directTerminalTransitions = new TerminalTransitionCoordinator(
  directTerminalTransitionDependencies,
);

const failedRuntimeLaunchCleanupDependencies = {
  hasSession: (sessionId: string) => workspace.hasSession(sessionId),
  stopIfGeneration: (sessionId: string, expectedGeneration: PtyGeneration) =>
    workspace.stopIfGeneration(sessionId, expectedGeneration),
};

interface TerminalRuntimeOwner {
  bindPty(sessionId: string, ptyGeneration: PtyGeneration): void;
  cleanupPreparedLaunch(sessionId: string): boolean;
  setInactive(sessionId: string, expectedGeneration: PtyGeneration): boolean;
  writeTerminal(sessionId: string, ptyGeneration: PtyGeneration, data: string): boolean;
}

const restartRuntimeTerminal = (
  runtime: TerminalRuntimeOwner,
  sessionId: string,
  environment: Parameters<TerminalWorkspace['restart']>[1],
  command: string,
  failureMessage: string,
  assertCurrent: () => void,
  ownGeneration: (ptyGeneration: PtyGeneration) => void,
): TerminalStatus => {
  assertRealRuntimeAllowed();
  const previousGeneration = workspace.getStatus(sessionId).ptyGeneration;
  terminalOutputBatcher.discard(sessionId, previousGeneration);
  resolvePendingPermissionModeProbes(sessionId, previousGeneration);
  const terminalStatus = workspace.restart(sessionId, environment);
  ownGeneration(terminalStatus.ptyGeneration);
  runtime.bindPty(sessionId, terminalStatus.ptyGeneration);
  if (terminalStatus.phase === 'error') {
    throw new Error(terminalStatus.message ?? failureMessage);
  }
  assertCurrent();
  if (!runtime.writeTerminal(sessionId, terminalStatus.ptyGeneration, `${command}\r`)) {
    throw new Error('新的 PowerShell 已停止，启动命令没有写入。');
  }
  return terminalStatus;
};

const codexFailure = async (sessionId: string, error: unknown): Promise<CodexOperationResult> => {
  const runtime = requireCodexRuntime();
  const status = workspace.getStatus(sessionId);
  return {
    error: error instanceof Error ? error.message : 'Codex 操作失败。',
    ok: false,
    state: await runtime.getState(sessionId, status.cwd),
  };
};

const routerFailure = async (
  error: unknown,
  fallback: string,
): Promise<ClaudeRouterOperationResult> => {
  const message = error instanceof Error ? error.message : fallback;
  const projectState = configTransactionState(error);
  return {
    error: message,
    message,
    ok: false,
    ...(projectState ? { projectState } : {}),
    routerState: await requireClaudeRuntime().getRouterManagementState(),
  };
};

const emitManagedChatGptProgress = (
  sessionId: string,
  stage: ManagedChatGptSetupStage,
  step: number,
  detail: string,
  active = true,
): void => {
  mainWindow?.webContents.send('claude:managed-chatgpt-setup-progress', {
    active,
    detail,
    sessionId,
    stage,
    step,
    totalSteps: 8,
  });
};

const managedChatGptConfigInput = (
  managed: ManagedChatGptGatewayProjectConfig,
  model = managed.model,
  modelFast = managed.modelFast,
): SaveClaudeConfigInput => ({
  apiKeyHelperPolicy: 'prefer-claudedock',
  authMode: 'authToken',
  baseUrl: managed.baseUrl,
  credential: managed.credential,
  credentialAction: 'replace',
  model,
  modelFast,
  preset: 'chatgpt-subscription',
  protocol: 'anthropic',
  provider: 'gateway',
});

const configTransactionState = (error: unknown): ClaudeProjectState | undefined =>
  error instanceof OwnedConfigTransactionError
    ? (error.state as ClaudeProjectState | undefined)
    : undefined;

interface ClaudeProjectConfigTransactionOptions<TPrepared> {
  assertCurrent: () => void;
  commit: (prepared: TPrepared) => void;
  complete: (prepared: TPrepared) => Promise<ClaudeProjectState>;
  cwd: string;
  prepare: () => Promise<TPrepared> | TPrepared;
  runtime: ClaudeRuntime;
  sessionId: string;
}

const runClaudeProjectConfigTransaction = <TPrepared>(
  options: ClaudeProjectConfigTransactionOptions<TPrepared>,
): Promise<ClaudeProjectState> => {
  assertExternalRoutingWritesAllowed();
  const assertTargetCurrent = (): void => {
    const currentStatus = workspace.getStatus(options.sessionId);
    if (!sameDirectory(currentStatus.cwd, options.cwd)) {
      throw new Error('配置事务已不再拥有发起操作时的项目会话。');
    }
  };
  const assertTransactionCurrent = (): void => {
    options.assertCurrent();
    assertTargetCurrent();
  };
  return runOwnedConfigTransaction({
    acquireIsolation: () => acquireConfigTransactionIsolation(options.sessionId, options.cwd),
    assertOperationOwnership: assertTransactionCurrent,
    assertRollbackOwnership: assertTargetCurrent,
    commit: options.commit,
    complete: options.complete,
    coordinator: managedConfigTransactions,
    createSnapshot: () => options.runtime.createConfigSnapshot(options.cwd),
    cwd: options.cwd,
    prepare: options.prepare,
    publishRestoredState: publishRestoredClaudeProjectState,
    readState: () => options.runtime.getState(options.sessionId, options.cwd),
    restoreSnapshot: (snapshot) => options.runtime.restoreConfigSnapshot(options.cwd, snapshot),
    sessionId: options.sessionId,
  });
};

const publishClaudeProjectState = (state: ClaudeProjectState): boolean => {
  if (!workspace.hasSession(state.sessionId)) {
    return false;
  }
  const status = workspace.getStatus(state.sessionId);
  const currentRevision = publishedClaudeStateRevisions.get(state.sessionId);
  if (!claudeStateOwnershipIsCurrent(state, currentRevision, status.ptyGeneration)) {
    return false;
  }
  publishedClaudeStateRevisions.set(state.sessionId, state.stateRevision);
  if (!state.active) {
    releaseTerminalConversationOwner(state.sessionId);
  } else {
    const conversationId = state.metrics?.sessionId?.toLowerCase();
    const generation = Number(state.ptyGeneration ?? 0);
    if (
      conversationId &&
      isValidClaudeSessionId(conversationId) &&
      generation > 0 &&
      !terminalTransferSessions.has(state.sessionId)
    ) {
      const previous = terminalConversationOwners.get(state.sessionId);
      if (
        previous &&
        (previous.conversationId !== conversationId || previous.generation !== generation)
      ) {
        releaseTerminalConversationOwner(state.sessionId);
      }
      const owner: ConversationOwner = {
        conversationId,
        generation,
        ownerId: `terminal:${state.sessionId}`,
        ownerKind: 'terminal',
        phase: 'active',
        projectPath: state.cwd,
        runtime: 'claude',
      };
      const claim = conversationOwnerRegistry.claim(owner);
      if (claim.status === 'conflict') {
        mainWindow?.webContents.send('conversation:owner-conflict', {
          conversationId,
          existingOwnerKind: claim.owner.ownerKind,
          existingSessionId:
            claim.owner.ownerKind === 'terminal'
              ? claim.owner.ownerId.replace(/^terminal:/, '')
              : undefined,
          sessionId: state.sessionId,
        });
        // A raw `/resume` is only identifiable after Claude reports its UUID. Stop the late owner
        // immediately so two runtimes cannot continue against one transcript; the renderer explains
        // that the already-stable owner was retained.
        queueMicrotask(() => {
          if (!workspace.hasSession(state.sessionId)) return;
          const status = workspace.getStatus(state.sessionId);
          if (status.ptyGeneration !== state.ptyGeneration) return;
          workspace.stop(state.sessionId);
          claudeRuntime?.setInactive(state.sessionId, status.ptyGeneration);
        });
      } else {
        terminalConversationOwners.set(state.sessionId, claim.owner);
      }
    }
  }
  const claudeTitle = state.metrics?.sessionName;
  if (claudeTitle) {
    try {
      workspace.syncClaudeSessionTitle(state.sessionId, claudeTitle);
    } catch {
      // Ignore malformed or oversized names from a future Claude Code status-line schema.
    }
  }
  mainWindow?.webContents.send('claude:state', state);
  return true;
};

const publishRestoredClaudeProjectState = (state: ClaudeProjectState): void => {
  publishClaudeProjectState(state);
};

const resumeClaudeAfterManagedCutover = async (
  runtime: ClaudeRuntime,
  sessionId: string,
  cwd: string,
  assertCurrent: () => void,
): Promise<ClaudeProjectState> => {
  let ownedGeneration = workspace.getStatus(sessionId).ptyGeneration;
  try {
    const prepared = await runtime.prepareLaunch(sessionId, cwd, 'continue');
    assertCurrent();
    restartRuntimeTerminal(
      runtime,
      sessionId,
      prepared.environment,
      prepared.command,
      '无法在新接入上恢复 Claude Code 会话。',
      assertCurrent,
      (ptyGeneration) => {
        ownedGeneration = ptyGeneration;
      },
    );
    const state = await runtime.getState(sessionId, cwd);
    assertCurrent();
    return state;
  } catch (error) {
    // Once the saved route changes, falling back to the old live PTY would silently keep billing
    // the previous relay. Fail closed even when preparing or starting the replacement TUI fails.
    cleanupFailedRuntimeLaunch(
      failedRuntimeLaunchCleanupDependencies,
      runtime,
      sessionId,
      ownedGeneration,
    );
    throw error;
  }
};

const verifyAndSaveManagedChatGptProject = async (
  sessionId: string,
  cwd: string,
  managed: ManagedChatGptGatewayProjectConfig,
  assertCurrent: () => void,
  requestedModel?: string,
  resumeAfterSave = false,
): Promise<{ connectionTest: ClaudeConnectionTestResult; projectState?: ClaudeProjectState }> => {
  const runtime = requireClaudeRuntime();
  const current = await runtime.getState(sessionId, cwd);
  assertCurrent();
  const model =
    requestedModel ??
    (current.config.preset === 'chatgpt-subscription' &&
    managed.availableModels.includes(current.config.model)
      ? current.config.model
      : managed.model);
  const modelFast =
    current.config.preset === 'chatgpt-subscription' &&
    current.config.modelFast &&
    managed.availableModels.includes(current.config.modelFast)
      ? current.config.modelFast
      : managed.modelFast;
  const input = managedChatGptConfigInput(managed, model, modelFast);
  emitManagedChatGptProgress(sessionId, 'testing', 7, `正在真实验证模型 ${model}。`);
  let connectionTest = await runtime.testConnection(cwd, input);
  assertCurrent();
  if (
    !connectionTest.ok &&
    (connectionTest.failureKind === 'network' || connectionTest.failureKind === 'timeout')
  ) {
    emitManagedChatGptProgress(sessionId, 'testing', 7, '连接首次失败，正在自动重启网关并复检。');
    await requireManagedChatGptGateway().ensureRunning();
    assertCurrent();
    connectionTest = await runtime.testConnection(cwd, input);
    assertCurrent();
  }
  if (!connectionTest.ok) {
    return { connectionTest };
  }
  emitManagedChatGptProgress(sessionId, 'saving', 8, '连接已通过，正在保存当前项目配置。');
  const projectState = await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
    assertCurrent,
    commit: (prepared) => runtime.commitPreparedConfig(cwd, prepared),
    complete: async (prepared) => {
      const savedState = await runtime.completePreparedConfigSave(sessionId, cwd, prepared);
      assertCurrent();
      return resumeAfterSave
        ? resumeClaudeAfterManagedCutover(runtime, sessionId, cwd, assertCurrent)
        : savedState;
    },
    cwd,
    prepare: () => runtime.prepareConnectionConfig(input, undefined, assertCurrent),
    runtime,
    sessionId,
  });
  return { connectionTest, projectState };
};

const validatePluginId = (value: unknown): string => {
  if (!isValidPluginId(value)) {
    throw new Error('插件标识无效。');
  }
  return value;
};

const refreshedPluginCatalog = async (): Promise<ClaudePluginCatalog> => {
  pluginManager.invalidate();
  return pluginManager.getCatalog(true);
};

const mcpScopes = new Set<McpScope>(['local', 'project', 'user']);
const validateMcpScope = (value: unknown): McpScope => {
  if (typeof value !== 'string' || !mcpScopes.has(value as McpScope)) {
    throw new Error('MCP 作用域无效。');
  }
  return value as McpScope;
};

const validateMcpInstallInput = (value: unknown): McpInstallInput => {
  if (!value || typeof value !== 'object') {
    throw new Error('MCP 安装参数无效。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.catalogId !== 'string' || input.catalogId.length > 240) {
    throw new Error('MCP 目录条目标识无效。');
  }
  return {
    catalogId: input.catalogId,
    cwd: validateProjectPath(input.cwd),
    scope: validateMcpScope(input.scope),
  };
};

const validateMcpRemoveInput = (value: unknown): McpRemoveInput => {
  if (!value || typeof value !== 'object') {
    throw new Error('MCP 卸载参数无效。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.name)) {
    throw new Error('MCP 名称无效。');
  }
  return {
    cwd: validateProjectPath(input.cwd),
    name: input.name,
    scope: validateMcpScope(input.scope),
  };
};

const runMcpMutation = async (
  cwd: string,
  operation: () => Promise<string>,
): Promise<McpOperationResult> => {
  try {
    assertExternalRoutingWritesAllowed();
    const message = await operation();
    return { catalog: await requireMcpManager().getCatalog(cwd, true), message, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP 操作失败。';
    return {
      catalog: await requireMcpManager().getCatalog(cwd, true),
      error: message,
      message,
      ok: false,
    };
  }
};

/** Every plugin mutation shares the same validate → run → refresh → report shape. */
const runPluginMutation = async (
  operation: () => Promise<string>,
): Promise<ClaudePluginOperationResult> => {
  try {
    assertPluginMutationsAllowed();
    const message = await operation();
    return { catalog: await refreshedPluginCatalog(), message, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '插件操作失败。';
    return { catalog: await refreshedPluginCatalog(), error: message, message, ok: false };
  }
};

const pluginMutations = new Map<string, (argument: unknown, flag: unknown) => Promise<string>>([
  ['claude:plugins-install', (argument) => pluginManager.install(validatePluginId(argument))],
  ['claude:plugins-uninstall', (argument) => pluginManager.uninstall(validatePluginId(argument))],
  ['claude:plugins-update', (argument) => pluginManager.update(validatePluginId(argument))],
  [
    'claude:plugins-set-enabled',
    (argument, flag) => {
      if (typeof flag !== 'boolean') {
        throw new Error('插件启用状态无效。');
      }
      return pluginManager.setEnabled(validatePluginId(argument), flag);
    },
  ],
  [
    'claude:plugins-marketplace-add',
    (argument) => {
      if (!isValidMarketplaceSource(argument)) {
        throw new Error('插件市场地址无效，请填写仓库所有者/仓库名、HTTPS 地址或本机绝对路径。');
      }
      return pluginManager.addMarketplace(argument.trim());
    },
  ],
  [
    'claude:plugins-marketplace-remove',
    (argument) => {
      if (!isValidMarketplaceName(argument)) {
        throw new Error('插件市场名称无效。');
      }
      return pluginManager.removeMarketplace(argument);
    },
  ],
  ['claude:plugins-marketplaces-refresh', () => pluginManager.refreshMarketplaces()],
  ['claude:plugins-update-all', () => pluginManager.updateAll()],
]);

const routerInstallSources = new Set<ClaudeRouterInstallSource>(['npm', 'npmmirror']);

const validateProviderModelDiscoveryInput = (value: unknown): ClaudeProviderModelDiscoveryInput => {
  if (!value || typeof value !== 'object') {
    throw new Error('模型发现参数无效。');
  }
  const input = value as Partial<ClaudeProviderModelDiscoveryInput>;
  if (
    typeof input.baseUrl !== 'string' ||
    input.baseUrl.length > 2048 ||
    (input.credential !== undefined &&
      (typeof input.credential !== 'string' || input.credential.length > 20_000))
  ) {
    throw new Error('模型发现参数包含无效字段。');
  }
  return { baseUrl: input.baseUrl, credential: input.credential };
};

const validateClaudePermissionDecision = (value: unknown): ClaudePermissionDecision => {
  if (!value || typeof value !== 'object') throw new Error('权限确认结果无效。');
  const decision = value as Partial<ClaudePermissionDecision> & {
    message?: unknown;
    suggestionId?: unknown;
  };
  if (decision.behavior === 'fallback') return { behavior: 'fallback' };
  if (decision.behavior === 'allow') {
    if (
      decision.suggestionId !== undefined &&
      (typeof decision.suggestionId !== 'string' || decision.suggestionId.length > 200)
    ) {
      throw new Error('权限范围无效。');
    }
    return {
      behavior: 'allow',
      ...(decision.suggestionId ? { suggestionId: decision.suggestionId } : {}),
    };
  }
  if (decision.behavior === 'deny') {
    if (decision.message !== undefined && typeof decision.message !== 'string') {
      throw new Error('拒绝原因无效。');
    }
    return {
      behavior: 'deny',
      ...(decision.message ? { message: decision.message.slice(0, 300) } : {}),
    };
  }
  throw new Error('权限确认结果无效。');
};

const windowsBuildNumber = (): number => {
  const value = Number(release().split('.')[2]);
  return Number.isInteger(value) && value > 0 ? value : 0;
};

const registerIpc = (): void => {
  ipcMain.handle('native-conversation:start', async (event, value: unknown) => {
    validateSender(event);
    if (!value || typeof value !== 'object') throw new Error('原生对话启动参数无效。');
    const request = value as Partial<NativeConversationLaunchRequest>;
    const projectPath = resolveDirectory(validateProjectPath(request.projectPath));
    const conversationId = request.conversationId
      ? validateConversationId(request.conversationId)
      : randomUUID();
    if (
      request.model !== undefined &&
      (typeof request.model !== 'string' || request.model.length > 200)
    ) {
      throw new Error('原生对话模型标识无效。');
    }
    if (
      request.permissionMode !== undefined &&
      !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(
        request.permissionMode,
      )
    ) {
      throw new Error('原生对话权限模式无效。');
    }
    const service = requireNativeConversationService();
    const existing = conversationOwnerRegistry.ownerFor({
      conversationId,
      projectPath,
      runtime: 'claude',
    });
    if (existing) {
      return service.start({
        conversationId,
        model: request.model,
        permissionMode: request.permissionMode,
        projectPath,
        resume: request.resume,
      });
    }

    let launch: { ownerId: string; prepared: PreparedNativeClaudeConversation } | undefined;
    if (runtimeProfile.adapterMode === 'production') {
      const runtime = requireClaudeRuntime();
      const officialProvider = runtime.officialNetworkProvider(projectPath);
      if (officialProvider) {
        await assertOfficialProviderAllowed(officialProvider, 'cli-launch', projectPath);
      }
      const ownerId = `native-route:${conversationId}`;
      const prepared = await runtime.prepareNativeConversation(ownerId, projectPath, request.model);
      launch = { ownerId, prepared };
      nativeLaunches.set(conversationId, launch);
    }
    try {
      const allowBypassPermissions =
        launch?.prepared.allowBypassPermissions ?? runtimeProfile.adapterMode === 'fake';
      if (request.permissionMode === 'bypassPermissions' && !allowBypassPermissions) {
        throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
      }
      const result = await service.start({
        allowBypassPermissions,
        conversationId,
        launch: launch
          ? {
              cliVersion: launch.prepared.cliVersion,
              configFingerprintSource: { runtime: launch.prepared.configFingerprint },
              endpointIdentity: launch.prepared.endpointIdentity,
              model: launch.prepared.model,
            }
          : { configFingerprintSource: { adapter: 'isolated-fake' } },
        model: launch?.prepared.model ?? request.model,
        permissionMode: request.permissionMode,
        projectPath,
        resume: request.resume,
      });
      if (!result.ok && launch) {
        requireClaudeRuntime().releaseNativeConversation(launch.ownerId);
        nativeLaunches.delete(conversationId);
      }
      return result;
    } catch (error) {
      if (launch) {
        requireClaudeRuntime().releaseNativeConversation(launch.ownerId);
        nativeLaunches.delete(conversationId);
      }
      throw error;
    }
  });
  ipcMain.handle('native-conversation:get', (event, conversationId: unknown) => {
    validateSender(event);
    return requireNativeConversationService().getSnapshot(validateConversationId(conversationId));
  });
  ipcMain.handle(
    'native-attachment:import-paths',
    async (event, conversationId: unknown, paths: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.length > 10 ||
        paths.some((item) => typeof item !== 'string' || item.length > 32_768)
      ) {
        throw new Error('图片选择结果无效。');
      }
      try {
        return {
          attachments: await nativeAttachmentStore.importFiles(validatedConversationId, paths),
          ok: true,
        };
      } catch (error) {
        return {
          attachments: [],
          message: error instanceof Error ? error.message : '无法安全导入图片。',
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    'native-attachment:import-bytes',
    async (event, conversationId: unknown, sources: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      if (
        !Array.isArray(sources) ||
        sources.length === 0 ||
        sources.length > 10 ||
        sources.some(
          (source) =>
            !source ||
            typeof source !== 'object' ||
            typeof source.fileName !== 'string' ||
            !(source.bytes instanceof ArrayBuffer),
        )
      ) {
        throw new Error('粘贴图片数据无效。');
      }
      try {
        return {
          attachments: await nativeAttachmentStore.importBytes(
            validatedConversationId,
            sources as NativeAttachmentBytesInput[],
          ),
          ok: true,
        };
      } catch (error) {
        return {
          attachments: [],
          message: error instanceof Error ? error.message : '无法安全导入图片。',
          ok: false,
        };
      }
    },
  );
  ipcMain.handle('native-attachment:import-clipboard', async (event, conversationId: unknown) => {
    validateSender(event);
    const validatedConversationId = validateConversationId(conversationId);
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return { attachments: [], message: '剪贴板中没有可读取的图片。', ok: false };
    }
    try {
      const bytes = image.toPNG();
      return {
        attachments: await nativeAttachmentStore.importBytes(validatedConversationId, [
          {
            bytes: Uint8Array.from(bytes).buffer,
            fileName: '剪贴板图片.png',
          },
        ]),
        ok: true,
      };
    } catch (error) {
      return {
        attachments: [],
        message: error instanceof Error ? error.message : '无法安全导入剪贴板图片。',
        ok: false,
      };
    }
  });
  ipcMain.handle(
    'native-attachment:read',
    (event, conversationId: unknown, attachmentId: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      const validatedAttachmentId = validateConversationId(attachmentId);
      const attachment = nativeAttachmentStore.get(validatedConversationId, validatedAttachmentId);
      const resolved = nativeAttachmentStore.resolve(
        validatedConversationId,
        validatedAttachmentId,
      );
      const image = resolved.path
        ? nativeImage.createFromPath(resolved.path)
        : nativeImage.createEmpty();
      return image.isEmpty()
        ? attachment
        : {
            ...attachment,
            previewDataUrl: image.resize({ height: 160, quality: 'good', width: 240 }).toDataURL(),
          };
    },
  );
  ipcMain.handle(
    'native-attachment:remove',
    (event, conversationId: unknown, attachmentId: unknown) => {
      validateSender(event);
      return nativeAttachmentStore.remove(
        validateConversationId(conversationId),
        validateConversationId(attachmentId),
      );
    },
  );
  ipcMain.handle('native-conversation:submit', (event, conversationId: unknown, input: unknown) => {
    validateSender(event);
    const validatedConversationId = validateConversationId(conversationId);
    return requireNativeConversationService().submit(
      validatedConversationId,
      resolveNativeSubmitAttachments(validatedConversationId, validateNativeSubmitInput(input)),
    );
  });
  ipcMain.handle(
    'native-conversation:respond',
    (event, conversationId: unknown, interactionId: unknown, response: unknown) => {
      validateSender(event);
      if (typeof interactionId !== 'string' || !interactionId || interactionId.length > 300) {
        throw new Error('原生交互标识无效。');
      }
      return requireNativeConversationService().respond(
        validateConversationId(conversationId),
        interactionId,
        validateNativeInteractionResponse(response),
      );
    },
  );
  ipcMain.handle('native-conversation:interrupt', (event, conversationId: unknown) => {
    validateSender(event);
    return requireNativeConversationService().interrupt(validateConversationId(conversationId));
  });
  ipcMain.handle(
    'native-conversation:stop-task',
    (event, conversationId: unknown, taskId: unknown) => {
      validateSender(event);
      if (typeof taskId !== 'string' || !taskId || taskId.length > 300) {
        throw new Error('后台任务标识无效。');
      }
      return requireNativeConversationService().stopTask(
        validateConversationId(conversationId),
        taskId,
      );
    },
  );
  ipcMain.handle(
    'native-conversation:update-controls',
    (event, conversationId: unknown, update: unknown) => {
      validateSender(event);
      const service = requireNativeConversationService();
      const validatedConversationId = validateConversationId(conversationId);
      const validatedUpdate = validateNativeControlUpdate(update);
      if (validatedUpdate.permissionMode === 'bypassPermissions') {
        const snapshot = service.getSnapshot(validatedConversationId);
        if (!snapshot || !requireClaudeRuntime().allowsBypassPermissions(snapshot.projectPath)) {
          throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
        }
      }
      return service.updateControls(validatedConversationId, validatedUpdate);
    },
  );
  ipcMain.handle('native-conversation:close', async (event, conversationId: unknown) => {
    validateSender(event);
    const validatedConversationId = validateConversationId(conversationId);
    const result = await requireNativeConversationService().close(validatedConversationId);
    if (result.ok) await nativeAttachmentStore.releaseConversation(validatedConversationId);
    return result;
  });
  ipcMain.handle(
    'native-conversation:rename',
    (event, conversationId: unknown, title: unknown): boolean => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      if (typeof title !== 'string') throw new Error('对话名称格式无效。');
      const snapshot = requireNativeConversationService().getSnapshot(validatedConversationId);
      if (!snapshot) throw new Error('原生对话不存在或已结束。');
      return sessionManager.renameSession(
        snapshot.projectPath,
        validatedConversationId,
        normalizeClaudeSessionTitle(title),
      );
    },
  );
  ipcMain.handle(
    'native-conversation:transfer-to-terminal',
    async (event, conversationId: unknown, draft: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      const validatedDraft = draft === undefined ? undefined : validateNativeSubmitInput(draft);
      let transferredOwner: ConversationOwner | undefined;
      let transferredSessionId: string | undefined;
      const result = await requireNativeConversationService().transferToTerminal(
        validatedConversationId,
        validatedDraft,
        async (identity) => {
          const runtime = requireClaudeRuntime();
          workspace.openConversation(
            identity.projectPath,
            `高级终端 ${identity.conversationId.slice(0, 8)}`,
          );
          const openedSessionId = workspace.getState().activeSessionId;
          if (!openedSessionId) throw new Error('无法创建高级终端。');
          transferredSessionId = openedSessionId;
          terminalTransferSessions.add(openedSessionId);
          workspaceStore.addProject(identity.projectPath);
          let launchPrepared = false;
          let ownedGeneration: PtyGeneration | undefined;
          try {
            await withDevelopmentSessionOperation(openedSessionId, async (assertCurrent) => {
              const prepared = await runtime.prepareLaunchWithSession(
                openedSessionId,
                identity.projectPath,
                identity.conversationId,
              );
              launchPrepared = true;
              ownedGeneration = prepared.predecessorPtyGeneration;
              assertCurrent();
              restartRuntimeTerminal(
                runtime,
                openedSessionId,
                prepared.environment,
                prepared.command,
                '无法为 Claude Code 启动高级终端。',
                assertCurrent,
                (ptyGeneration) => {
                  ownedGeneration = ptyGeneration;
                },
              );
            });
            if (ownedGeneration === undefined) throw new Error('高级终端没有有效的进程代际。');
            transferredOwner = {
              conversationId: identity.conversationId,
              generation: Number(ownedGeneration),
              ownerId: `terminal:${openedSessionId}`,
              ownerKind: 'terminal',
              phase: 'active',
              projectPath: identity.projectPath,
              runtime: 'claude',
            };
            return { owner: transferredOwner, terminalSessionId: openedSessionId };
          } catch (error) {
            if (launchPrepared || ownedGeneration !== undefined) {
              cleanupFailedRuntimeLaunch(
                failedRuntimeLaunchCleanupDependencies,
                runtime,
                openedSessionId,
                ownedGeneration,
              );
            }
            if (workspace.hasSession(openedSessionId)) workspace.close(openedSessionId);
            throw error;
          }
        },
      );
      if (transferredSessionId) terminalTransferSessions.delete(transferredSessionId);
      if (!result.ok && transferredSessionId && workspace.hasSession(transferredSessionId)) {
        await invalidateAndWaitForDevelopmentSessionOperation(transferredSessionId).catch(
          () => undefined,
        );
        await runtimeProcessRegistry?.terminateSession(transferredSessionId).catch(() => undefined);
        requireClaudeRuntime().closeSession(transferredSessionId);
        workspace.close(transferredSessionId);
      }
      if (result.ok && transferredOwner && transferredSessionId) {
        terminalConversationOwners.set(transferredSessionId, transferredOwner);
        const launch = nativeLaunches.get(validatedConversationId);
        if (launch) {
          requireClaudeRuntime().releaseNativeConversation(launch.ownerId);
          nativeLaunches.delete(validatedConversationId);
        }
      }
      return result;
    },
  );
  ipcMain.handle('native-conversation:list-recoveries', (event) => {
    validateSender(event);
    return requireNativeConversationService()
      .listRecoveries()
      .filter((recovery) => !recovery.clean);
  });
  ipcMain.handle(
    'native-conversation:restore-draft',
    (event, conversationId: unknown, clientSubmissionId: unknown, projectPath: unknown) => {
      validateSender(event);
      if (
        typeof clientSubmissionId !== 'string' ||
        !clientSubmissionId ||
        clientSubmissionId.length > 200
      ) {
        throw new Error('恢复草稿标识无效。');
      }
      return requireNativeConversationService().restoreDraft(
        validateConversationId(conversationId),
        clientSubmissionId,
        validateProjectPath(projectPath),
      );
    },
  );
  ipcMain.handle(
    'native-conversation:discard-recovery',
    (event, conversationId: unknown, projectPath: unknown) => {
      validateSender(event);
      return requireNativeConversationService().discardRecovery(
        validateConversationId(conversationId),
        validateProjectPath(projectPath),
      );
    },
  );
  ipcMain.handle('busy:list', (event) => {
    validateSender(event);
    if (!busyRegistry) {
      throw new Error('忙碌任务登记表尚未初始化。');
    }
    return busyRegistry.list();
  });
  ipcMain.handle('runtime:get-activity', (event, sessionId: unknown): RuntimeActivitySnapshot => {
    validateSender(event);
    return runtimeActivityRegistry.get(validateSessionId(sessionId));
  });
  ipcMain.handle(
    'claude:permission-response',
    (event, requestId: unknown, decision: unknown): boolean => {
      validateSender(event);
      if (typeof requestId !== 'string' || requestId.length > 200 || !claudePermissionBridge) {
        throw new Error('权限请求已失效。');
      }
      return claudePermissionBridge.respond(requestId, validateClaudePermissionDecision(decision));
    },
  );
  ipcMain.handle(
    'runtime:terminate-process',
    async (event, sessionId: unknown, processKey: unknown): Promise<RuntimeActivitySnapshot> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      if (typeof processKey !== 'string' || processKey.length > 200 || !runtimeProcessRegistry) {
        throw new Error('进程控制请求无效。');
      }
      await runtimeProcessRegistry.terminate(validatedSessionId, processKey);
      return runtimeActivityRegistry.get(validatedSessionId);
    },
  );
  ipcMain.handle('busy:set-conversation', (event, busy: unknown) => {
    validateSender(event);
    if (typeof busy !== 'boolean' || !busyRegistry) {
      throw new Error('对话忙碌状态无效。');
    }
    if (busy && !releaseConversationBusy) {
      releaseConversationBusy = busyRegistry.acquire({
        cancellable: true,
        id: 'conversation:renderer',
        kind: 'conversation',
        label: '独立对话正在生成或准备发送',
        severity: 'blocking',
      });
    } else if (!busy && releaseConversationBusy) {
      releaseConversationBusy();
      releaseConversationBusy = undefined;
    }
    return busyRegistry.list();
  });
  ipcMain.handle('download:list', (event) => {
    validateSender(event);
    return requireDownloadEngine().list();
  });
  ipcMain.handle('download:pause', (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().pause(validateDownloadTaskId(taskId));
  });
  ipcMain.handle('download:resume', (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().resume(validateDownloadTaskId(taskId));
  });
  ipcMain.handle('download:cancel', (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().cancel(validateDownloadTaskId(taskId));
  });
  ipcMain.handle('download:history-delete', (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().deleteHistory(validateDownloadTaskId(taskId));
  });
  ipcMain.handle('download:history-clear', (event) => {
    validateSender(event);
    return requireDownloadEngine().clearHistory();
  });
  ipcMain.handle('application-proxy:get', (event) => {
    validateSender(event);
    return applicationProxyView();
  });
  ipcMain.handle('application-proxy:save', async (event, input: unknown) => {
    validateSender(event);
    requireApplicationProxyStore().save(input as SaveApplicationProxyInput);
    applicationProxyState = undefined;
    await applyApplicationProxyScope();
    await applyConversationProxyScope();
    requireNetworkPreflightService().invalidate('application-proxy-changed');
    return publishApplicationProxyState();
  });
  ipcMain.handle('application-proxy:test', async (event) => {
    validateSender(event);
    return testApplicationProxy();
  });
  ipcMain.handle('application-proxy:detect', async (event) => {
    validateSender(event);
    return detectApplicationProxyCandidates();
  });
  ipcMain.handle('network-preflight:get', (event, provider: unknown) => {
    validateSender(event);
    return requireNetworkPreflightService().get(validateNetworkProvider(provider));
  });
  ipcMain.handle('network-preflight:run', (event, input: unknown) => {
    validateSender(event);
    const record =
      input && typeof input === 'object' ? (input as Partial<NetworkPreflightRunInput>) : undefined;
    if (!record) {
      throw new Error('网络预检参数无效。');
    }
    return requireNetworkPreflightService().run({
      action: validateNetworkPreflightAction(record.action),
      force: record.force === true,
      provider: validateNetworkProvider(record.provider),
    });
  });
  ipcMain.handle('network-preflight:invalidate', (event, reason: unknown) => {
    validateSender(event);
    requireNetworkPreflightService().invalidate(
      typeof reason === 'string' ? reason.slice(0, 120) : 'renderer-request',
    );
  });
  ipcMain.handle('network-preflight:get-history', (event) => {
    validateSender(event);
    return requireNetworkPreflightService().getHistory();
  });
  ipcMain.handle('network-preflight:clear-history', (event) => {
    validateSender(event);
    return requireNetworkPreflightService().clearHistory();
  });
  const appSettingsView = (): AppSettingsView => ({
    advanced: advancedSettingsStore.get(),
    artifactNetworkAllowed: artifactService.getState().allowed,
    closeBehavior: appPreferencesStore.get().closeBehavior,
    footerResourcePreference: appPreferencesStore.get().footerResourcePreference,
    managedChatGptContextWindowMode: appPreferencesStore.get().managedChatGptContextWindowMode,
    language: 'zh-CN',
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    theme: workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME,
    version: app.getVersion(),
    windowsBuildNumber: windowsBuildNumber(),
  });
  ipcMain.handle('app:get-settings', (event) => {
    validateSender(event);
    return appSettingsView();
  });
  ipcMain.handle('app:set-advanced-settings', (event, settings: unknown) => {
    validateSender(event);
    const record =
      settings && typeof settings === 'object'
        ? (settings as Partial<AdvancedSettings>)
        : undefined;
    if (
      ![0, 5, 10, 30].includes(record?.chatIdleTimeoutMinutes ?? -1) ||
      typeof record?.webResearchIsolation !== 'boolean'
    ) {
      throw new Error('高级设置无效。');
    }
    advancedSettingsStore.set({
      chatIdleTimeoutMinutes: record.chatIdleTimeoutMinutes as 0 | 5 | 10 | 30,
      webResearchIsolation: record.webResearchIsolation,
    });
    return appSettingsView();
  });
  ipcMain.handle('app:set-footer-resource-preference', (event, preference: unknown) => {
    validateSender(event);
    if (preference !== 'auto' && preference !== 'context' && preference !== 'quota') {
      throw new Error('底栏资源偏好无效。');
    }
    appPreferencesStore.set({ footerResourcePreference: preference as FooterResourcePreference });
    return appSettingsView();
  });
  ipcMain.handle('app:set-managed-chatgpt-context-window-mode', (event, mode: unknown) => {
    validateSender(event);
    if (mode !== 'standard' && mode !== 'extended') {
      throw new Error('ChatGPT 上下文窗口模式无效。');
    }
    appPreferencesStore.set({
      managedChatGptContextWindowMode: mode as ManagedChatGptContextWindowMode,
    });
    return appSettingsView();
  });
  ipcMain.handle('app:set-launch-at-login', (event, enabled: unknown) => {
    validateSender(event);
    if (typeof enabled !== 'boolean') {
      throw new Error('开机启动设置无效。');
    }
    app.setLoginItemSettings({
      args: app.isPackaged ? [] : [app.getAppPath()],
      openAtLogin: enabled,
      path: process.execPath,
    });
    return appSettingsView();
  });
  ipcMain.handle('app:set-close-behavior', (event, behavior: unknown) => {
    validateSender(event);
    if (behavior !== 'exit' && behavior !== 'tray') {
      throw new Error('关闭按钮行为无效。');
    }
    appPreferencesStore.set({ closeBehavior: behavior as CloseBehavior });
    return appSettingsView();
  });
  ipcMain.handle('artifact:create', (event, html: unknown) => {
    validateSender(event);
    if (typeof html !== 'string') {
      throw new Error('Artifact 内容格式无效。');
    }
    return artifactService.create(html);
  });
  ipcMain.handle('artifact:destroy', (event, artifactId: unknown) => {
    validateSender(event);
    if (typeof artifactId !== 'string') {
      throw new Error('Artifact 标识无效。');
    }
    return artifactService.destroy(artifactId);
  });
  ipcMain.handle('artifact:get-network-state', (event) => {
    validateSender(event);
    return artifactService.getState();
  });
  ipcMain.handle('artifact:set-network-allowed', (event, allowed: unknown) => {
    validateSender(event);
    if (typeof allowed !== 'boolean') {
      throw new Error('Artifact 联网开关取值无效。');
    }
    return artifactService.setNetworkAllowed(allowed);
  });
  ipcMain.handle('markdown:open-external', async (event, url: unknown) => {
    validateSender(event);
    try {
      await shell.openExternal(validateMarkdownExternalUrl(url));
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('chat:get-config', (event) => {
    validateSender(event);
    return chatConfigStore.getView();
  });
  ipcMain.handle('chat:save-config', (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话接入配置格式无效。');
    }
    return chatConfigStore.save(input as SaveChatConfigInput);
  });
  ipcMain.handle('chat:test-connection', async (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话接入测试参数无效。');
    }
    return chatService.test(input as SaveChatConfigInput);
  });
  ipcMain.handle('chat:import-attachments', async (event, input: unknown) => {
    validateSender(event);
    const record =
      input && typeof input === 'object'
        ? (input as Partial<ChatAttachmentImportInput>)
        : undefined;
    const paths = record?.paths;
    if (
      !Array.isArray(paths) ||
      paths.some((filePath) => typeof filePath !== 'string') ||
      paths.length === 0 ||
      (record?.draftId !== undefined && typeof record.draftId !== 'string')
    ) {
      throw new Error('附件路径列表无效。');
    }
    try {
      const imported = await chatAttachmentStore.importDraftFiles(paths, record?.draftId);
      return {
        attachments: imported.attachments,
        draftId: imported.draftId,
        errors: [],
        ok: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法导入附件。';
      return {
        attachments: [],
        errors: paths.map((filePath) => ({ message, path: String(filePath) })),
        ok: false,
      };
    }
  });
  ipcMain.handle('chat:import-attachment-bytes', async (event, input: unknown) => {
    validateSender(event);
    const record =
      input && typeof input === 'object'
        ? (input as Partial<ChatAttachmentBytesImportInput>)
        : undefined;
    const sources = record?.sources;
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some(
        (source) =>
          !source ||
          typeof source !== 'object' ||
          typeof source.fileName !== 'string' ||
          !(source.bytes instanceof ArrayBuffer || ArrayBuffer.isView(source.bytes)),
      ) ||
      (record?.draftId !== undefined && typeof record.draftId !== 'string')
    ) {
      throw new Error('粘贴的附件数据无效。');
    }
    try {
      const imported = await chatAttachmentStore.importDraftBytes(sources, record?.draftId);
      return {
        attachments: imported.attachments,
        draftId: imported.draftId,
        errors: [],
        ok: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法导入附件。';
      return {
        attachments: [],
        errors: sources.map((source) => ({ message, path: String(source?.fileName ?? '') })),
        ok: false,
      };
    }
  });
  ipcMain.handle('chat:import-clipboard-image', async (event, draftId: unknown) => {
    validateSender(event);
    if (draftId !== undefined && typeof draftId !== 'string') {
      throw new Error('附件草稿标识无效。');
    }
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return { attachments: [], errors: [], ok: false };
    }
    try {
      const bytes = image.toPNG();
      const imported = await chatAttachmentStore.importDraftBytes(
        [
          {
            bytes,
            fileName: '剪贴板图片.png',
          },
        ],
        draftId,
      );
      return {
        attachments: imported.attachments,
        draftId: imported.draftId,
        errors: [],
        ok: true,
      };
    } catch (error) {
      return {
        attachments: [],
        errors: [
          {
            message: error instanceof Error ? error.message : '无法安全导入剪贴板图片。',
            path: '剪贴板图片',
          },
        ],
        ok: false,
      };
    }
  });
  ipcMain.handle(
    'chat:delete-draft-attachment',
    async (event, draftId: unknown, attachmentId: unknown) => {
      validateSender(event);
      if (typeof draftId !== 'string' || typeof attachmentId !== 'string') {
        throw new Error('附件草稿或附件标识无效。');
      }
      return chatAttachmentStore.removeDraftAttachment(
        draftId,
        attachmentId,
        chatHistoryStore.referencedAttachmentIds(),
      );
    },
  );
  ipcMain.handle('chat:release-attachment-draft', async (event, draftId: unknown) => {
    validateSender(event);
    if (typeof draftId !== 'string') {
      throw new Error('附件草稿标识无效。');
    }
    return chatAttachmentStore.releaseDraft(draftId, chatHistoryStore.referencedAttachmentIds());
  });
  ipcMain.handle('chat:read-attachment', (event, attachmentId: unknown) => {
    validateSender(event);
    if (!isChatAttachmentId(attachmentId)) {
      throw new Error('附件标识无效。');
    }
    const attachment = chatAttachmentStore.get(attachmentId);
    if (attachment.type !== 'image') {
      return attachment;
    }
    const resolved = chatAttachmentStore.resolve(attachmentId);
    const image = nativeImage.createFromPath(resolved.filePath);
    if (image.isEmpty()) {
      return attachment;
    }
    const resized = image.resize({ height: 160, quality: 'good', width: 240 });
    return {
      ...attachment,
      previewDataUrl: resized.toDataURL(),
    };
  });
  ipcMain.handle('chat:list-conversations', (event) => {
    validateSender(event);
    return chatHistoryStore.list();
  });
  ipcMain.handle('chat:get-conversation', (event, conversationId: unknown) => {
    validateSender(event);
    if (typeof conversationId !== 'string') {
      throw new Error('对话历史标识无效。');
    }
    return chatHistoryStore.get(conversationId);
  });
  ipcMain.handle('chat:save-conversation', (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话历史保存参数无效。');
    }
    return chatHistoryStore.save(input as SaveChatConversationInput);
  });
  ipcMain.handle('chat:rename-conversation', (event, conversationId: unknown, title: unknown) => {
    validateSender(event);
    if (typeof conversationId !== 'string') {
      throw new Error('对话历史标识无效。');
    }
    return chatHistoryStore.rename(conversationId, title);
  });
  ipcMain.handle('chat:delete-conversation', (event, conversationId: unknown) => {
    validateSender(event);
    if (typeof conversationId !== 'string') {
      throw new Error('对话历史标识无效。');
    }
    return chatHistoryStore.delete(conversationId);
  });
  ipcMain.handle('chat:preflight', (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话请求格式无效。');
    }
    const request = input as ChatStartInput;
    const prepared = chatService.preflight(request);
    chatAttachmentStore.assertDraftMatches(
      request.draftId,
      currentTurnLocalAttachmentIds(prepared.messages),
    );
    return prepared;
  });
  ipcMain.handle('chat:start', async (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话请求格式无效。');
    }
    const request = input as ChatStartInput;
    const officialProvider = officialProviderForChat();
    if (officialProvider) {
      await assertOfficialProviderAllowed(
        officialProvider,
        'first-request',
        undefined,
        'conversation',
      );
    }
    return chatService.start(request, (prepared) => {
      chatAttachmentStore.commitDraft(
        request.draftId,
        currentTurnLocalAttachmentIds(prepared.messages),
      );
    });
  });
  ipcMain.handle('chat:stop', (event, requestId: unknown) => {
    validateSender(event);
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
      throw new Error('对话请求标识无效。');
    }
    chatService.stop(requestId);
  });
  ipcMain.handle('workspace:get-state', (event) => {
    validateSender(event);
    return describeWorkspace();
  });
  ipcMain.handle('runtime:get', (event, sessionId: unknown): DevelopmentRuntimeState => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return {
      cwd: status.cwd,
      runtime: agentRuntimeStore.get(status.cwd),
      sessionId: validatedSessionId,
    };
  });
  ipcMain.handle(
    'runtime:set',
    async (event, sessionId: unknown, runtime: unknown): Promise<DevelopmentRuntimeState> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const selected = validateDevelopmentRuntime(runtime);
      const status = workspace.getStatus(validatedSessionId);
      const committedRuntime = await projectRuntimeSwitchOperations.switchRuntime(
        validatedSessionId,
        status.cwd,
        selected,
      );
      return {
        cwd: status.cwd,
        runtime: committedRuntime,
        sessionId: validatedSessionId,
      };
    },
  );
  ipcMain.handle('project:add', (event, directoryPath: unknown) => {
    validateSender(event);
    if (typeof directoryPath !== 'string') {
      return failedWorkspaceResult(new Error('文件夹路径格式无效。'));
    }
    return addProject(directoryPath);
  });
  ipcMain.handle('project:activate', (event, sessionId: unknown) => {
    validateSender(event);
    try {
      return {
        ok: true,
        state: activateProject(validateSessionId(sessionId)),
      } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:close', async (event, sessionId: unknown) => {
    validateSender(event);
    try {
      const validatedSessionId = validateSessionId(sessionId);
      await invalidateAndWaitForDevelopmentSessionOperation(validatedSessionId);
      await runtimeProcessRegistry?.terminateSession(validatedSessionId);
      requireClaudeRuntime().closeSession(validatedSessionId);
      requireCodexRuntime().closeSession(validatedSessionId);
      // The folder stays remembered: closing one conversation is not "forget this project".
      const state = workspace.close(validatedSessionId);
      const active = state.sessions.find((session) => session.id === state.activeSessionId);
      if (active) {
        workspaceStore.updateLastActive(active.cwd);
      }
      return {
        ok: true,
        state: describeWorkspace(state),
      } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:open-conversation', (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const resolved = resolveDirectory(validateProjectPath(projectPath));
      return projectDirectoryLifecycle.runOpenSync(resolved, (ownership) => {
        ownership.assertCurrent();
        const state = workspace.openConversation(resolved);
        ownership.assertCurrent();
        workspaceStore.addProject(resolved);
        return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
      });
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:close-folder', async (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const target = validateProjectPath(projectPath);
      const state = await runOwnedProjectDirectoryClosure({
        beforeCloseSession: (sessionId) =>
          runtimeProcessRegistry?.terminateSession(sessionId) ?? Promise.resolve(),
        captureSessionIds: () => workspace.sessionIdsForDirectory(target),
        closeRuntimeSession: (sessionId) => {
          claudeRuntime?.closeSession(sessionId);
          codexRuntime?.closeSession(sessionId);
        },
        closeWorkspaceSession: (sessionId) => {
          workspace.close(sessionId);
        },
        coordinator: projectDirectoryLifecycle,
        cwd: target,
        invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,
        isSessionInDirectory: (sessionId, cwd) =>
          workspace.hasSession(sessionId) && sameDirectory(workspace.getStatus(sessionId).cwd, cwd),
        kind: 'close',
        readState: () => workspace.getState(),
      });
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:forget', async (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const target = validateProjectPath(projectPath);
      const state = await runOwnedProjectDirectoryClosure({
        beforeCloseSession: (sessionId) =>
          runtimeProcessRegistry?.terminateSession(sessionId) ?? Promise.resolve(),
        captureSessionIds: () => workspace.sessionIdsForDirectory(target),
        closeRuntimeSession: (sessionId) => {
          claudeRuntime?.closeSession(sessionId);
          codexRuntime?.closeSession(sessionId);
        },
        closeWorkspaceSession: (sessionId) => {
          workspace.close(sessionId);
        },
        commit: () => {
          workspaceStore.removeProject(target);
          agentRuntimeStore.remove(target);
        },
        coordinator: projectDirectoryLifecycle,
        cwd: target,
        invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,
        isSessionInDirectory: (sessionId, cwd) =>
          workspace.hasSession(sessionId) && sameDirectory(workspace.getStatus(sessionId).cwd, cwd),
        kind: 'forget',
        readState: () => workspace.getState(),
      });
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:rename-conversation', (event, sessionId: unknown, title: unknown) => {
    validateSender(event);
    try {
      if (typeof title !== 'string') {
        throw new Error('对话名称格式无效。');
      }
      const validatedSessionId = validateSessionId(sessionId);
      const normalizedTitle = normalizeClaudeSessionTitle(title);
      const state = workspace.renameSession(validatedSessionId, normalizedTitle);
      const status = workspace.getStatus(validatedSessionId);
      claudeRuntime?.writeTerminal(
        validatedSessionId,
        status.ptyGeneration,
        `/rename ${normalizedTitle}\r`,
      );
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle(
    'project:open-stored-conversation',
    async (event, projectPath: unknown, conversationId: unknown): Promise<WorkspaceResult> => {
      validateSender(event);
      try {
        if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
          throw new Error('会话标识无效。');
        }
        const resolved = resolveDirectory(validateProjectPath(projectPath));
        return await projectDirectoryLifecycle.runOpen(resolved, async (ownership) => {
          const runtime = requireClaudeRuntime();
          ownership.assertCurrent();
          managedConfigTransactions.assertDevelopmentOperationAllowed(resolved);
          if (agentRuntimeStore.get(resolved) !== 'claude') {
            throw new Error('这是 Claude Code 历史会话，请先将该项目切换为 Claude Code。');
          }
          claudeConversationLifecycle.assertLaunchAllowed(resolved, 'resume', conversationId);

          const existingOwner = conversationOwnerRegistry.ownerFor({
            conversationId,
            projectPath: resolved,
            runtime: 'claude',
          });
          if (existingOwner?.ownerKind === 'terminal') {
            const existingSessionId = existingOwner.ownerId.replace(/^terminal:/, '');
            if (workspace.hasSession(existingSessionId)) {
              return {
                ok: true,
                reused: true,
                state: describeWorkspace(workspace.activate(existingSessionId)),
              };
            }
          }
          if (existingOwner) {
            throw new Error('该对话已在原生界面运行，请切换到现有对话。');
          }

          // Different UUIDs may run side by side, but the same canonical transcript has one owner.
          workspace.openConversation(resolved, `历史 ${conversationId.slice(0, 8)}`);
          const openedSessionId = workspace.getState().activeSessionId;
          if (!openedSessionId) {
            throw new Error('无法创建历史会话终端。');
          }
          const predictedGeneration =
            Number(workspace.getStatus(openedSessionId).ptyGeneration) + 1;
          const terminalOwner: ConversationOwner = {
            conversationId: conversationId.toLowerCase(),
            generation: predictedGeneration,
            ownerId: `terminal:${openedSessionId}`,
            ownerKind: 'terminal',
            phase: 'starting',
            projectPath: resolved,
            runtime: 'claude',
          };
          const ownerClaim = conversationOwnerRegistry.claim(terminalOwner);
          if (ownerClaim.status === 'conflict') {
            workspace.close(openedSessionId);
            throw new Error('该对话刚刚被另一个界面接管，已取消重复恢复。');
          }
          terminalConversationOwners.set(openedSessionId, ownerClaim.owner);
          ownership.assertCurrent();
          workspaceStore.addProject(resolved);

          await withDevelopmentSessionOperation(openedSessionId, async (assertCurrent) =>
            claudeConversationLifecycle.runResume(
              resolved,
              conversationId,
              openedSessionId,
              async (conversationOwnership) => {
                const assertOpenCurrent = (): void => {
                  ownership.assertCurrent();
                  conversationOwnership.assertCurrent();
                  assertCurrent();
                };
                let launchPrepared = false;
                let ownedGeneration: PtyGeneration | undefined;
                try {
                  const prepared = await runtime.prepareLaunchWithSession(
                    openedSessionId,
                    resolved,
                    conversationId,
                  );
                  launchPrepared = true;
                  ownedGeneration = prepared.predecessorPtyGeneration;
                  assertOpenCurrent();
                  restartRuntimeTerminal(
                    runtime,
                    openedSessionId,
                    prepared.environment,
                    prepared.command,
                    '无法为 Claude Code 启动安全终端。',
                    assertOpenCurrent,
                    (ptyGeneration) => {
                      ownedGeneration = ptyGeneration;
                    },
                  );
                } catch (error) {
                  if (launchPrepared || ownedGeneration !== undefined) {
                    cleanupFailedRuntimeLaunch(
                      failedRuntimeLaunchCleanupDependencies,
                      runtime,
                      openedSessionId,
                      ownedGeneration,
                    );
                  }
                  releaseTerminalConversationOwner(openedSessionId);
                  if (workspace.hasSession(openedSessionId)) workspace.close(openedSessionId);
                  throw error;
                }
              },
            ),
          );
          ownership.assertCurrent();
          conversationOwnerRegistry.updatePhase(
            terminalOwner,
            terminalOwner.ownerId,
            terminalOwner.generation,
            'active',
          );
          return { ok: true, state: describeWorkspace() };
        });
      } catch (error) {
        return failedWorkspaceResult(error);
      }
    },
  );
  ipcMain.handle(
    'terminal:start',
    async (event, sessionId: unknown, expectedGeneration: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(expectedGeneration);
        const status = await directTerminalTransitions.run(
          validatedSessionId,
          validatedGeneration,
          () => workspace.start(validatedSessionId),
        );
        return operationFromStatus(status);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : '无法启动终端。',
          ok: false,
          status: workspace.getActiveStatus(),
        } satisfies OperationResult;
      }
    },
  );
  ipcMain.handle(
    'terminal:restart',
    async (event, sessionId: unknown, expectedGeneration: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(expectedGeneration);
        const status = await directTerminalTransitions.run(
          validatedSessionId,
          validatedGeneration,
          () => workspace.restart(validatedSessionId),
        );
        return operationFromStatus(status);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : '无法重启终端。',
          ok: false,
          status: workspace.getActiveStatus(),
        } satisfies OperationResult;
      }
    },
  );
  ipcMain.handle(
    'terminal:stop',
    async (event, sessionId: unknown, expectedGeneration: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(expectedGeneration);
        const status = await directTerminalTransitions.run(
          validatedSessionId,
          validatedGeneration,
          () => workspace.stop(validatedSessionId),
        );
        return operationFromStatus(status);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : '无法停止终端。',
          ok: false,
          status: workspace.getActiveStatus(),
        } satisfies OperationResult;
      }
    },
  );
  ipcMain.handle('directory:choose', async (event) => {
    validateSender(event);
    return chooseDirectory(BrowserWindow.fromWebContents(event.sender) ?? undefined);
  });
  ipcMain.handle('claude:get-state', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getState(validatedSessionId, status.cwd);
  });
  ipcMain.handle('codex:get-state', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireCodexRuntime().getState(validatedSessionId, status.cwd);
  });
  ipcMain.handle(
    'codex:install-update',
    async (event, sessionId: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        assertApplicationUpdatesAllowed();
        return {
          ok: true,
          state: await requireCodexRuntime().installOrUpdate(validatedSessionId, status.cwd),
        };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'codex:login-start',
    async (event, sessionId: unknown, method: unknown): Promise<CodexLoginStartResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      assertRealRuntimeAllowed();
      const status = workspace.getStatus(validatedSessionId);
      try {
        await assertOfficialProviderAllowed('openai-codex', 'login', status.cwd);
        const prepared = await requireCodexRuntime().startLogin(
          validatedSessionId,
          status.cwd,
          validateCodexLoginMethod(method),
        );
        let openedBrowser = false;
        if (prepared.externalUrl) {
          await shell.openExternal(prepared.externalUrl);
          openedBrowser = true;
        }
        return { ok: true, openedBrowser, state: prepared.state };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'codex:login-cancel',
    async (event, sessionId: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      assertRealRuntimeAllowed();
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await requireCodexRuntime().cancelLogin(validatedSessionId, status.cwd),
        };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'codex:logout',
    async (event, sessionId: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      assertRealRuntimeAllowed();
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await requireCodexRuntime().logout(validatedSessionId, status.cwd),
        };
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'codex:launch',
    async (event, sessionId: unknown, mode: unknown): Promise<CodexOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireCodexRuntime();
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let launchPrepared = false;
          let ownedGeneration: PtyGeneration | undefined;
          try {
            if (agentRuntimeStore.get(status.cwd) !== 'codex') {
              throw new Error('当前项目尚未选择 Codex 开发引擎。');
            }
            await assertOfficialProviderAllowed('openai-codex', 'cli-launch', status.cwd);
            assertCurrent();
            const prepared = await runtime.prepareLaunch(
              validatedSessionId,
              status.cwd,
              validateCodexLaunchMode(mode),
            );
            launchPrepared = true;
            ownedGeneration = prepared.predecessorPtyGeneration;
            assertCurrent();
            if (agentRuntimeStore.get(status.cwd) !== 'codex') {
              throw new Error('当前项目已切换开发引擎，这次 Codex 启动已取消。');
            }
            restartRuntimeTerminal(
              runtime,
              validatedSessionId,
              prepared.environment,
              prepared.command,
              '无法为 Codex 启动安全终端。',
              assertCurrent,
              (ptyGeneration) => {
                ownedGeneration = ptyGeneration;
              },
            );
            const state = await runtime.getState(validatedSessionId, status.cwd);
            assertCurrent();
            return { ok: true, state };
          } catch (error) {
            if (launchPrepared || ownedGeneration !== undefined) {
              cleanupFailedRuntimeLaunch(
                failedRuntimeLaunchCleanupDependencies,
                runtime,
                validatedSessionId,
                ownedGeneration,
              );
            }
            return codexFailure(validatedSessionId, error);
          }
        });
      } catch (error) {
        return codexFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle('claude:get-gateway-diagnostics', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getGatewayDiagnostics(status.cwd);
  });
  ipcMain.handle('claude:router-get-state', async (event, sessionId: unknown) => {
    validateSender(event);
    validateSessionId(sessionId);
    return requireClaudeRuntime().getRouterManagementState();
  });
  ipcMain.handle('claude:managed-chatgpt-gateway-state', async (event) => {
    validateSender(event);
    return requireManagedChatGptGateway().getState();
  });
  ipcMain.handle(
    'claude:provider-models-discover',
    async (event, rawInput: unknown): Promise<ClaudeProviderModelDiscoveryResult> => {
      validateSender(event);
      try {
        const input = validateProviderModelDiscoveryInput(rawInput);
        const models = await requireClaudeRuntime().discoverProviderModels(
          input.baseUrl,
          input.credential,
        );
        return {
          message: `已从当前接口读取 ${models.length} 个可用模型。`,
          models,
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法读取当前接口的模型列表。';
        return { error: message, message, models: [], ok: false };
      }
    },
  );
  ipcMain.handle(
    'claude:managed-chatgpt-gateway-open-management',
    async (event): Promise<OperationResult> => {
      validateSender(event);
      try {
        const access = await requireManagedChatGptGateway().managementAccess();
        clipboard.writeText(access.managementKey);
        await shell.openExternal(access.url);
        return {
          message: '已打开 ChatGPT 网关本机后台，管理密钥已复制到剪贴板供登录使用。',
          ok: true,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : '无法打开 ChatGPT 网关后台。',
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    'claude:managed-chatgpt-gateway-setup',
    async (
      event,
      sessionId: unknown,
      forceLogin: unknown,
    ): Promise<ManagedChatGptGatewayOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      if (typeof forceLogin !== 'boolean') {
        throw new Error('托管网关登录参数无效。');
      }
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      const resumeAfterSetup = runtime.isActive(validatedSessionId);
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let connectionTest: ClaudeConnectionTestResult | undefined;
          try {
            await assertOfficialProviderAllowed('openai-codex', 'login', status.cwd);
            assertCurrent();
            if (resumeAfterSetup) {
              emitManagedChatGptProgress(
                validatedSessionId,
                'detecting',
                1,
                '检测到运行中的 Claude 会话；已先停止旧路由，防止登录期间继续消耗原中转站额度。',
              );
              withoutTerminalOperationInvalidation(validatedSessionId, () => {
                workspace.stopIfGeneration(validatedSessionId, status.ptyGeneration);
              });
              runtime.setInactive(validatedSessionId, status.ptyGeneration);
              assertCurrent();
            }
            emitManagedChatGptProgress(
              validatedSessionId,
              'detecting',
              1,
              resumeAfterSetup
                ? '旧路由已停止，正在检测 Claude Code、登录网关与本机端口。'
                : '正在检测 Claude Code、登录网关与本机端口。',
            );
            let environment = await runtime.getSoftwareUpdates(true);
            assertCurrent();
            if (!environment.claudeCode.installed) {
              emitManagedChatGptProgress(
                validatedSessionId,
                'installing-claude',
                2,
                '未检测到 Claude Code，正在通过官方安装方式补齐。',
              );
              environment = (await runtime.installOrUpdateClaudeCode()).state;
              assertCurrent();
            } else {
              emitManagedChatGptProgress(
                validatedSessionId,
                'installing-claude',
                2,
                'Claude Code 已就绪，无需重复安装。',
              );
            }
            if (!environment.claudeCode.installed) {
              throw new Error('Claude Code 自动安装结束后仍未通过环境检测。');
            }
            emitManagedChatGptProgress(
              validatedSessionId,
              'installing-gateway',
              3,
              'Claude Code 已就绪，正在检查并配置 ChatGPT 本地网关；此方式不需要 CCR。',
            );
            const managed = await requireManagedChatGptGateway().setup(
              forceLogin,
              (step, detail) => {
                const stage: ManagedChatGptSetupStage =
                  step === 5
                    ? 'logging-in'
                    : step >= 6
                      ? 'discovering-models'
                      : 'installing-gateway';
                emitManagedChatGptProgress(validatedSessionId, stage, step, detail);
              },
            );
            assertCurrent();
            const applied = await verifyAndSaveManagedChatGptProject(
              validatedSessionId,
              status.cwd,
              managed,
              assertCurrent,
              undefined,
              resumeAfterSetup,
            );
            assertCurrent();
            connectionTest = applied.connectionTest;
            const state = await requireManagedChatGptGateway().getState();
            assertCurrent();
            if (!applied.projectState) {
              emitManagedChatGptProgress(
                validatedSessionId,
                'error',
                8,
                `自动接入未通过：${connectionTest.message}`,
                false,
              );
              return {
                connectionTest,
                error: connectionTest.message,
                message: '环境与模型列表已准备好，但真实连接测试未通过。',
                ok: false,
                state,
              };
            }
            emitManagedChatGptProgress(
              validatedSessionId,
              'complete',
              8,
              resumeAfterSetup
                ? `接入成功；旧路由已切断，最近会话已在新路由恢复，模型为 ${applied.projectState.config.model}。`
                : `接入成功，已自动选择并验证模型 ${applied.projectState.config.model}。`,
              false,
            );
            return {
              connectionTest,
              message: resumeAfterSetup
                ? `环境、网关和模型已全部自动配置；旧路由已停止，最近会话已在新路由恢复。`
                : `环境、网关和模型已全部自动配置；当前使用 ${applied.projectState.config.model}。`,
              ok: true,
              projectState: applied.projectState,
              state,
            };
          } catch (error) {
            const state = await requireManagedChatGptGateway().getState();
            const message = error instanceof Error ? error.message : '托管网关配置失败。';
            const projectState = configTransactionState(error);
            emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
            return {
              connectionTest,
              error: message,
              message: resumeAfterSetup
                ? '未能完成 ChatGPT 订阅的一键接入；旧路由会话已保持停止，不会继续消耗原中转站额度。'
                : '未能完成 ChatGPT 订阅的一键接入。',
              ok: false,
              ...(projectState ? { projectState } : {}),
              state,
            };
          }
        });
      } catch (error) {
        const state = await requireManagedChatGptGateway().getState();
        const message = error instanceof Error ? error.message : '托管网关配置失败。';
        emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
        return {
          error: message,
          message: resumeAfterSetup
            ? '未能完成 ChatGPT 订阅的一键接入；旧路由会话已保持停止，不会继续消耗原中转站额度。'
            : '未能完成 ChatGPT 订阅的一键接入。',
          ok: false,
          state,
        };
      }
    },
  );
  ipcMain.handle(
    'claude:managed-chatgpt-gateway-model',
    async (
      event,
      sessionId: unknown,
      requestedModel: unknown,
    ): Promise<ManagedChatGptGatewayOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      if (
        typeof requestedModel !== 'string' ||
        !/^[-A-Za-z0-9._:/@[\]]{1,200}$/.test(requestedModel)
      ) {
        throw new Error('托管网关模型标识无效。');
      }
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      const resumeAfterModelChange = runtime.isActive(validatedSessionId);
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let connectionTest: ClaudeConnectionTestResult | undefined;
          try {
            await assertOfficialProviderAllowed('openai-codex', 'first-request', status.cwd);
            assertCurrent();
            emitManagedChatGptProgress(
              validatedSessionId,
              'discovering-models',
              6,
              '正在刷新网关模型列表并校验你的选择。',
            );
            const managed =
              await requireManagedChatGptGateway().configurationForModel(requestedModel);
            assertCurrent();
            const applied = await verifyAndSaveManagedChatGptProject(
              validatedSessionId,
              status.cwd,
              managed,
              assertCurrent,
              requestedModel,
              resumeAfterModelChange,
            );
            assertCurrent();
            connectionTest = applied.connectionTest;
            const state = await requireManagedChatGptGateway().getState();
            assertCurrent();
            if (!applied.projectState) {
              emitManagedChatGptProgress(
                validatedSessionId,
                'error',
                8,
                connectionTest.message,
                false,
              );
              return {
                connectionTest,
                error: connectionTest.message,
                message: '所选模型未通过真实连接测试，原配置保持不变。',
                ok: false,
                state,
              };
            }
            emitManagedChatGptProgress(
              validatedSessionId,
              'complete',
              8,
              `模型 ${requestedModel} 已验证并切换完成。`,
              false,
            );
            return {
              connectionTest,
              message: `已切换并验证模型 ${requestedModel}。`,
              ok: true,
              projectState: applied.projectState,
              state,
            };
          } catch (error) {
            const state = await requireManagedChatGptGateway().getState();
            const message = error instanceof Error ? error.message : '无法切换托管网关模型。';
            const projectState = configTransactionState(error);
            emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
            return {
              connectionTest,
              error: message,
              message: '无法完成模型切换。',
              ok: false,
              ...(projectState ? { projectState } : {}),
              state,
            };
          }
        });
      } catch (error) {
        const state = await requireManagedChatGptGateway().getState();
        const message = error instanceof Error ? error.message : '无法切换托管网关模型。';
        emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
        return {
          error: message,
          message: '无法完成模型切换。',
          ok: false,
          state,
        };
      }
    },
  );
  ipcMain.handle('router:kernel-state', async (event, sessionId: unknown) => {
    validateSender(event);
    validateSessionId(sessionId);
    return getRouterKernelState();
  });
  ipcMain.handle(
    'router:cc-switch-install',
    async (event, sessionId: unknown): Promise<RouterKernelOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const ccSwitch = await requireCcSwitchAdapter().install();
        const state = await getRouterKernelState();
        return {
          message: ccSwitch.installed
            ? 'CC Switch 官方 MSI 已校验并安装。'
            : 'CC Switch 安装程序已结束，但尚未检测到安装状态。',
          ok: ccSwitch.installed,
          state,
        };
      } catch (error) {
        return routerKernelFailure(error, '无法安装 CC Switch。');
      }
    },
  );
  ipcMain.handle(
    'router:cc-switch-uninstall',
    async (event, sessionId: unknown): Promise<RouterKernelOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const ccSwitch = await requireCcSwitchAdapter().uninstall(true);
        const state = await getRouterKernelState();
        return {
          message:
            !ccSwitch.installed && ccSwitch.residuals.length === 0
              ? 'CC Switch 已卸载，程序、协议注册与已知数据目录均无残留。'
              : `卸载后仍检测到残留：${ccSwitch.residuals.join('、') || ccSwitch.message}`,
          ok: !ccSwitch.installed && ccSwitch.residuals.length === 0,
          state,
        };
      } catch (error) {
        return routerKernelFailure(error, '无法卸载 CC Switch。');
      }
    },
  );
  ipcMain.handle(
    'router:cc-switch-export-current',
    async (event, sessionId: unknown): Promise<RouterKernelOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        await requireCcSwitchAdapter().exportProvider(
          requireClaudeRuntime().currentProviderForCcSwitch(status.cwd),
        );
        return {
          message: '已通过 ccswitch:// 打开单向导入确认；请在 CC Switch 中确认。',
          ok: true,
          state: await getRouterKernelState(),
        };
      } catch (error) {
        return routerKernelFailure(error, '无法导出当前供应商。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-install',
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-install',
          '正在后台安装 Claude Code Router CLI',
          () => requireClaudeRuntime().installRouterPackage('npm'),
        );
        return { message: result.message, ok: true, routerState: result.state };
      } catch (error) {
        return routerFailure(error, '无法安装或更新路由器 CLI。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-install-source',
    async (event, sessionId: unknown, source: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      if (
        typeof source !== 'string' ||
        !routerInstallSources.has(source as ClaudeRouterInstallSource)
      ) {
        return routerFailure(new Error('路由器安装源无效。'), '无法安装路由器。');
      }
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-install',
          '正在安装 Claude Code Router',
          () => requireClaudeRuntime().installRouterPackage(source as ClaudeRouterInstallSource),
        );
        return { message: result.message, ok: true, routerState: result.state };
      } catch (error) {
        return routerFailure(error, '无法安装或更新路由器。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-uninstall',
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-uninstall',
          '正在卸载 Claude Code Router CLI',
          () => requireClaudeRuntime().uninstallRouter(),
        );
        return { message: result.message, ok: true, routerState: result.state };
      } catch (error) {
        return routerFailure(error, '无法卸载路由器。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-start',
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const routerState = await requireClaudeRuntime().startRouter();
        return {
          message:
            routerState.gatewayState === 'running' ? '路由器网关已启动。' : routerState.message,
          ok: routerState.gatewayState === 'running',
          routerState,
        };
      } catch (error) {
        return routerFailure(error, '无法启动路由器。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-stop',
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const routerState = await requireClaudeRuntime().stopRouter();
        return {
          message: 'ClaudeDock 管理的 CCR CLI 后台与模型网关已停止。',
          ok: !routerState.serviceRunning,
          routerState,
        };
      } catch (error) {
        return routerFailure(error, '无法停止路由器。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-open-management',
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      const runtime = requireClaudeRuntime();
      try {
        await shell.openExternal(await runtime.routerManagementUrl());
        return {
          message: '已打开 CCR 本机管理页。',
          ok: true,
          routerState: await runtime.getRouterManagementState(),
        };
      } catch (error) {
        return routerFailure(error, '无法打开 CCR 管理页。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-repair-from-project',
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-repair',
          '正在修复 Claude Code Router 配置',
          () =>
            withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
              let saved: SavedRouterProvider | undefined;
              const projectState =
                await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
                  assertCurrent,
                  commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
                  complete: (prepared) =>
                    runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
                  cwd: status.cwd,
                  prepare: async () => {
                    saved = await runtime.repairRouterProviderFromProject(
                      status.cwd,
                      assertCurrent,
                    );
                    assertCurrent();
                    return runtime.prepareRouterProjectConfig(saved);
                  },
                  runtime,
                  sessionId: validatedSessionId,
                });
              if (!saved) {
                throw new Error('路由器服务提供方保存结果缺失。');
              }
              return { projectState, saved };
            }),
        );
        return {
          message: `已用当前项目配置创建服务提供方 ${result.saved.provider.name}，启动 3456，并将当前项目安全切换到路由器。`,
          ok: true,
          projectState: result.projectState,
          provider: result.saved.provider,
          routerState: result.saved.state,
        };
      } catch (error) {
        return routerFailure(error, '无法用当前项目配置修复路由器。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-save-provider',
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedInput = validateClaudeRouterProviderInput(input);
        const result = await withBlockingRouterTask<{
          projectState?: ClaudeProjectState;
          saved: SavedRouterProvider;
        }>('router:ccr-save-provider', '正在保存 Claude Code Router 服务提供方', () => {
          if (!validatedInput.useForCurrentProject) {
            return runtime
              .saveRouterProvider(validatedInput)
              .then((saved) => ({ projectState: undefined, saved }));
          }
          return withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
            let saved: SavedRouterProvider | undefined;
            const projectState = await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
              assertCurrent,
              commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
              complete: (prepared) =>
                runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
              cwd: status.cwd,
              prepare: async () => {
                saved = await runtime.saveRouterProvider(validatedInput, assertCurrent);
                assertCurrent();
                return runtime.prepareRouterProjectConfig(saved);
              },
              runtime,
              sessionId: validatedSessionId,
            });
            if (!saved) {
              throw new Error('路由器服务提供方保存结果缺失。');
            }
            return { projectState, saved };
          });
        });
        return {
          message: result.projectState
            ? `服务提供方 ${result.saved.provider.name} 已保存，并已安全接入当前项目。`
            : `服务提供方 ${result.saved.provider.name} 已保存。`,
          ok: true,
          projectState: result.projectState,
          provider: result.saved.provider,
          routerState: result.saved.state,
        };
      } catch (error) {
        return routerFailure(error, '无法保存路由器服务提供方。');
      }
    },
  );
  ipcMain.handle(
    'claude:router-delete-provider',
    async (
      event,
      sessionId: unknown,
      providerId: unknown,
    ): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      if (typeof providerId !== 'string') {
        return routerFailure(new Error('服务提供方标识无效。'), '无法删除服务提供方。');
      }
      try {
        return {
          message: '服务提供方已从路由器删除。',
          ok: true,
          routerState: await withBlockingRouterTask(
            'router:ccr-delete-provider',
            '正在删除 Claude Code Router 服务提供方',
            () => requireClaudeRuntime().deleteRouterProvider(providerId),
          ),
        };
      } catch (error) {
        return routerFailure(error, '无法删除路由器服务提供方。');
      }
    },
  );
  ipcMain.handle(
    'claude:save-config',
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeConfigResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedInput = validateClaudeConfigInput(input);
        const officialProvider = officialNetworkProviderForClaudePreset(validatedInput.preset);
        const state = await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
          runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
            assertCurrent,
            commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
            complete: (prepared) =>
              runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
            cwd: status.cwd,
            prepare: async () => {
              if (officialProvider) {
                await assertOfficialProviderAllowed(
                  officialProvider,
                  'provider-switch',
                  status.cwd,
                );
                assertCurrent();
              }
              return runtime.prepareConnectionConfig(validatedInput, undefined, assertCurrent);
            },
            runtime,
            sessionId: validatedSessionId,
          }),
        );
        return { ok: true, state };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : '无法保存 Claude 接入配置。',
          ok: false,
          state:
            configTransactionState(error) ??
            (await runtime.getState(validatedSessionId, status.cwd)),
        };
      }
    },
  );
  ipcMain.handle('claude:connection-history', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getConnectionHistory(status.cwd);
  });
  ipcMain.handle(
    'claude:connection-history-apply',
    async (event, sessionId: unknown, entryId: unknown): Promise<ClaudeConnectionHistoryResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedEntryId = validateHistoryEntryId(entryId);
        const state = await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
          runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
            assertCurrent,
            commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
            complete: (prepared) =>
              runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
            cwd: status.cwd,
            prepare: async () => {
              const officialProvider = runtime.connectionHistoryOfficialNetworkProvider(
                status.cwd,
                validatedEntryId,
              );
              if (officialProvider) {
                await assertOfficialProviderAllowed(
                  officialProvider,
                  'provider-switch',
                  status.cwd,
                );
                assertCurrent();
              }
              return runtime.prepareConnectionHistory(status.cwd, validatedEntryId, assertCurrent);
            },
            runtime,
            sessionId: validatedSessionId,
          }),
        );
        return { entries: runtime.getConnectionHistory(status.cwd), ok: true, state };
      } catch (error) {
        const state = configTransactionState(error);
        return {
          entries: runtime.getConnectionHistory(status.cwd),
          error: error instanceof Error ? error.message : '无法应用这条接入记录。',
          ok: false,
          ...(state ? { state } : {}),
        };
      }
    },
  );
  ipcMain.handle(
    'claude:connection-history-delete',
    async (event, sessionId: unknown, entryId: unknown): Promise<ClaudeConnectionHistoryResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        return {
          entries: runtime.deleteConnectionHistory(status.cwd, validateHistoryEntryId(entryId)),
          ok: true,
        };
      } catch (error) {
        return {
          entries: runtime.getConnectionHistory(status.cwd),
          error: error instanceof Error ? error.message : '无法删除这条接入记录。',
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    'claude:connection-history-rename',
    async (
      event,
      sessionId: unknown,
      entryId: unknown,
      name: unknown,
    ): Promise<ClaudeConnectionHistoryResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        if (typeof name !== 'string') {
          throw new Error('连接名称格式无效。');
        }
        return {
          entries: runtime.renameConnectionHistory(
            status.cwd,
            validateHistoryEntryId(entryId),
            name,
          ),
          ok: true,
        };
      } catch (error) {
        return {
          entries: runtime.getConnectionHistory(status.cwd),
          error: error instanceof Error ? error.message : '无法重命名这条接入记录。',
          ok: false,
        };
      }
    },
  );
  ipcMain.handle('claude:model-options', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getModelOptions(status.cwd, validatedSessionId);
  });
  ipcMain.handle(
    'claude:switch-model',
    async (event, sessionId: unknown, optionId: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
            requireClaudeRuntime().switchModel(
              validatedSessionId,
              status.cwd,
              validateModelOptionId(optionId),
              assertCurrent,
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'claude:relaunch',
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedInput = validateClaudeRelaunchInput(input);
        return await withDevelopmentSessionOperation(
          validatedSessionId,
          async (assertCurrent, signal) => {
            let launchPrepared = false;
            let ownedGeneration: PtyGeneration | undefined;
            const launchReplacement = async (): Promise<ClaudeProjectState> => {
              const prepared = await runtime.prepareLaunch(
                validatedSessionId,
                status.cwd,
                'continue',
                validatedInput.permissionMode,
              );
              launchPrepared = true;
              ownedGeneration = prepared.predecessorPtyGeneration;
              assertCurrent();
              restartRuntimeTerminal(
                runtime,
                validatedSessionId,
                prepared.environment,
                prepared.command,
                '无法为 Claude Code 启动安全终端。',
                assertCurrent,
                (ptyGeneration) => {
                  ownedGeneration = ptyGeneration;
                },
              );
              const state = await runtime.getState(validatedSessionId, status.cwd);
              assertCurrent();
              return state;
            };

            try {
              const entryId = validatedInput.entryId;
              if (!entryId) {
                const officialProvider = runtime.officialNetworkProvider(status.cwd);
                if (officialProvider) {
                  await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                  assertCurrent();
                }
                await runtime.compactBeforeRelaunch(
                  validatedSessionId,
                  status.cwd,
                  validatedInput.compactFirst,
                  assertCurrent,
                  signal,
                );
                assertCurrent();
                return { ok: true, state: await launchReplacement() };
              }

              const state = await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
                assertCurrent,
                commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
                complete: async (prepared) => {
                  await runtime.completePreparedConfigSave(
                    validatedSessionId,
                    status.cwd,
                    prepared,
                  );
                  assertCurrent();
                  return launchReplacement();
                },
                cwd: status.cwd,
                prepare: async () => {
                  const officialProvider = runtime.connectionHistoryOfficialNetworkProvider(
                    status.cwd,
                    entryId,
                  );
                  if (officialProvider) {
                    await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                    assertCurrent();
                  }
                  await runtime.compactBeforeRelaunch(
                    validatedSessionId,
                    status.cwd,
                    validatedInput.compactFirst,
                    assertCurrent,
                    signal,
                  );
                  assertCurrent();
                  return runtime.prepareConnectionHistory(status.cwd, entryId, assertCurrent);
                },
                runtime,
                sessionId: validatedSessionId,
              });
              return { ok: true, state };
            } catch (error) {
              if (launchPrepared || ownedGeneration !== undefined) {
                cleanupFailedRuntimeLaunch(
                  failedRuntimeLaunchCleanupDependencies,
                  runtime,
                  validatedSessionId,
                  ownedGeneration,
                );
              }
              return claudeFailure(validatedSessionId, error);
            }
          },
        );
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'claude:set-permission-mode',
    async (event, sessionId: unknown, mode: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, () =>
            requireClaudeRuntime().setPermissionMode(
              validatedSessionId,
              status.cwd,
              validateClaudePermissionMode(mode),
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'claude:set-effort',
    async (event, sessionId: unknown, effort: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, () =>
            requireClaudeRuntime().setEffort(
              validatedSessionId,
              status.cwd,
              validateClaudeEffortRequest(effort),
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'claude:set-model-speed',
    async (event, sessionId: unknown, mode: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let commandWritten = false;
          let launchPrepared = false;
          let ownedGeneration: PtyGeneration | undefined;
          try {
            const validatedMode = validateModelSpeedMode(mode);
            if (!runtime.isActive(validatedSessionId)) {
              return {
                ok: true,
                state: await runtime.saveModelSpeedPreference(
                  validatedSessionId,
                  status.cwd,
                  validatedMode,
                ),
              };
            }
            const officialProvider = runtime.officialNetworkProvider(status.cwd);
            if (officialProvider) {
              await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
              assertCurrent();
            }
            const prepared = await runtime.prepareModelSpeedRelaunch(
              validatedSessionId,
              status.cwd,
              validatedMode,
            );
            launchPrepared = true;
            ownedGeneration = prepared.predecessorPtyGeneration;
            assertCurrent();
            restartRuntimeTerminal(
              runtime,
              validatedSessionId,
              prepared.environment,
              prepared.command,
              '无法为 Claude Code 启动安全终端。',
              assertCurrent,
              (ptyGeneration) => {
                ownedGeneration = ptyGeneration;
              },
            );
            commandWritten = true;
            return {
              ok: true,
              state: await runtime.commitModelSpeedPreference(
                validatedSessionId,
                status.cwd,
                prepared.targetKey,
                prepared.preference,
              ),
            };
          } catch (error) {
            if ((launchPrepared || ownedGeneration !== undefined) && !commandWritten) {
              cleanupFailedRuntimeLaunch(
                failedRuntimeLaunchCleanupDependencies,
                runtime,
                validatedSessionId,
                ownedGeneration,
              );
            }
            return claudeFailure(validatedSessionId, error);
          }
        });
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.on(
    'claude:permission-mode-observed',
    (event, sessionId: unknown, ptyGeneration: unknown, mode: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(ptyGeneration);
        const status = workspace.getStatus(validatedSessionId);
        requireClaudeRuntime().observePermissionModeFromScreen(
          validatedSessionId,
          status.cwd,
          validatedGeneration,
          validateClaudePermissionMode(mode),
        );
      } catch {
        // A queued xterm write can finish immediately after its project or Claude session is closed.
      }
    },
  );
  ipcMain.on(
    'claude:permission-mode-probe-result',
    (event, sessionId: unknown, ptyGeneration: unknown, probeId: unknown, mode: unknown) => {
      validateSender(event);
      if (
        typeof probeId !== 'number' ||
        !Number.isSafeInteger(probeId) ||
        probeId < 1 ||
        typeof sessionId !== 'string'
      ) {
        return;
      }
      const pending = pendingPermissionModeProbes.get(probeId);
      if (!pending || pending.sessionId !== sessionId) {
        return;
      }

      let validatedMode: ClaudePermissionMode | undefined;
      let validatedGeneration: PtyGeneration;
      try {
        const validatedSessionId = validateSessionId(sessionId);
        validatedGeneration = validatePtyGeneration(ptyGeneration);
        const current = workspace.getStatus(validatedSessionId);
        if (
          pending.ptyGeneration !== validatedGeneration ||
          current.ptyGeneration !== validatedGeneration
        ) {
          throw new Error('终端代次已经失效。');
        }
        validatedMode = mode === undefined ? undefined : validateClaudePermissionMode(mode);
      } catch {
        clearTimeout(pending.timer);
        pendingPermissionModeProbes.delete(probeId);
        pending.resolve(undefined);
        return;
      }
      clearTimeout(pending.timer);
      pendingPermissionModeProbes.delete(probeId);
      pending.resolve(validatedMode);
    },
  );
  ipcMain.handle(
    'claude:set-allow-bypass-permissions',
    async (event, sessionId: unknown, allowed: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        if (typeof allowed !== 'boolean') {
          throw new Error('放权开关的取值无效。');
        }
        const state = await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
          runClaudeProjectConfigTransaction<boolean>({
            assertCurrent,
            commit: (preparedAllowed) =>
              runtime.commitAllowBypassPermissions(status.cwd, preparedAllowed),
            complete: () => runtime.publishProjectState(validatedSessionId, status.cwd),
            cwd: status.cwd,
            prepare: () => allowed,
            runtime,
            sessionId: validatedSessionId,
          }),
        );
        return { ok: true, state };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'claude:test-connection',
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeConnectionTestResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        const validatedInput = validateClaudeConfigInput(input);
        // The ChatGPT subscription route is an app-owned loopback gateway. A saved project must be
        // able to survive an app or Windows restart without presenting the stopped child process as
        // a broken user configuration. Start it before both manual and automatic connection tests.
        if (validatedInput.preset === 'chatgpt-subscription') {
          await requireManagedChatGptGateway().ensureRunning();
        }
        const officialProvider = officialNetworkProviderForClaudePreset(validatedInput.preset);
        if (officialProvider) {
          await assertOfficialProviderAllowed(officialProvider, 'first-request', status.cwd);
        }
        return await requireClaudeRuntime().testConnection(status.cwd, validatedInput);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法测试 Claude 接入。';
        return {
          message,
          ok: false,
          stages: [
            { detail: message, id: 'endpoint', label: '接口地址', status: 'failed' },
            {
              detail: '请先修正配置。',
              id: 'authentication',
              label: '身份认证',
              status: 'skipped',
            },
            { detail: '尚未发送请求。', id: 'model', label: '模型响应', status: 'skipped' },
          ],
          testedAt: Date.now(),
          tone: 'error',
        };
      }
    },
  );
  ipcMain.handle('app:open-external', async (event, url: unknown) => {
    validateSender(event);
    try {
      await shell.openExternal(validateExternalUrl(url));
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('app:clipboard-read', (event) => {
    validateSender(event);
    return clipboard.readText().slice(0, 5 * 1024 * 1024);
  });
  ipcMain.handle('app:clipboard-write', (event, text: unknown) => {
    validateSender(event);
    if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) {
      return false;
    }
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle(
    'claude:launch',
    async (event, sessionId: unknown, mode: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const launchMode = validateClaudeLaunchMode(mode);
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          const executeLaunch = async (
            assertConversationCurrent: () => void = () => undefined,
          ): Promise<ClaudeOperationResult> => {
            const assertLaunchCurrent = (): void => {
              assertConversationCurrent();
              assertCurrent();
            };
            let launchPrepared = false;
            let ownedGeneration: PtyGeneration | undefined;
            try {
              if (agentRuntimeStore.get(status.cwd) !== 'claude') {
                throw new Error('当前项目尚未选择 Claude Code 开发引擎。');
              }
              const officialProvider = runtime.officialNetworkProvider(status.cwd);
              if (officialProvider) {
                await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                assertLaunchCurrent();
              }
              const prepared = await runtime.prepareLaunch(
                validatedSessionId,
                status.cwd,
                launchMode,
              );
              launchPrepared = true;
              ownedGeneration = prepared.predecessorPtyGeneration;
              assertLaunchCurrent();
              if (agentRuntimeStore.get(status.cwd) !== 'claude') {
                throw new Error('当前项目已切换开发引擎，这次 Claude 启动已取消。');
              }
              restartRuntimeTerminal(
                runtime,
                validatedSessionId,
                prepared.environment,
                prepared.command,
                '无法为 Claude Code 启动安全终端。',
                assertLaunchCurrent,
                (ptyGeneration) => {
                  ownedGeneration = ptyGeneration;
                },
              );
              const state = await runtime.getState(validatedSessionId, status.cwd);
              assertLaunchCurrent();
              return { ok: true, state };
            } catch (error) {
              if (launchPrepared || ownedGeneration !== undefined) {
                cleanupFailedRuntimeLaunch(
                  failedRuntimeLaunchCleanupDependencies,
                  runtime,
                  validatedSessionId,
                  ownedGeneration,
                );
              }
              return claudeFailure(validatedSessionId, error);
            }
          };

          return launchMode === 'new'
            ? executeLaunch()
            : claudeConversationLifecycle.runResume(
                status.cwd,
                undefined,
                validatedSessionId,
                async (conversationOwnership) =>
                  executeLaunch(() => conversationOwnership.assertCurrent()),
              );
        });
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    'claude:command',
    async (
      event,
      sessionId: unknown,
      command: unknown,
      argument: unknown,
    ): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const runtime = requireClaudeRuntime();
      try {
        if (typeof command !== 'string' || !claudeCommands.has(command)) {
          throw new Error('该 Claude 命令不在可视化命令白名单中。');
        }
        if (!runtime.isActive(validatedSessionId)) {
          throw new Error('请先通过 Claude 工作台启动会话，再执行可视化命令。');
        }
        const acceptsArgument = claudeCommands.get(command) ?? false;
        const normalizedArgument =
          typeof argument === 'string' && acceptsArgument ? argument.trim() : '';
        if (
          normalizedArgument.length > 500 ||
          /[\r\n]/.test(normalizedArgument) ||
          (!acceptsArgument && typeof argument === 'string' && argument.trim())
        ) {
          throw new Error('命令参数无效。');
        }
        const status = workspace.getStatus(validatedSessionId);
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, () =>
            runtime.runCommand(
              validatedSessionId,
              status.cwd,
              `${command}${normalizedArgument ? ` ${normalizedArgument}` : ''}`,
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.on('app:confirm-quit', (event, confirmed: unknown) => {
    validateSender(event);
    if (quitConfirmationTimer) {
      clearTimeout(quitConfirmationTimer);
      quitConfirmationTimer = undefined;
    }
    quitConfirmationPending = false;
    if (confirmed === 'retry' && quitResidualConfirmationPending) {
      quitResidualConfirmationPending = false;
      void beginControlledQuit(false);
      return;
    }
    if (confirmed !== true) {
      quitResidualConfirmationPending = false;
      return;
    }
    const forceWithResidualProcesses = quitResidualConfirmationPending;
    quitResidualConfirmationPending = false;
    void beginControlledQuit(forceWithResidualProcesses);
  });
  ipcMain.on('app:quit-request-received', (event) => {
    validateSender(event);
    if (quitConfirmationTimer) {
      clearTimeout(quitConfirmationTimer);
      quitConfirmationTimer = undefined;
    }
  });
  ipcMain.on('app:minimize-to-tray', (event) => {
    validateSender(event);
    hideMainWindowToTray();
  });
  ipcMain.on(
    'terminal:write',
    (event, sessionId: unknown, ptyGeneration: unknown, data: unknown) => {
      validateSender(event);
      if (typeof data !== 'string' || data.length > 65_536) {
        return;
      }
      try {
        workspace.write(validateSessionId(sessionId), validatePtyGeneration(ptyGeneration), data);
      } catch {
        // A stale renderer event can arrive immediately after a project is closed.
      }
    },
  );
  ipcMain.on(
    'terminal:resize',
    (
      event,
      sessionId: unknown,
      ptyGeneration: unknown,
      resizeRevision: unknown,
      cols: unknown,
      rows: unknown,
    ) => {
      validateSender(event);
      if (
        typeof resizeRevision !== 'number' ||
        !Number.isSafeInteger(resizeRevision) ||
        resizeRevision < 0 ||
        typeof cols !== 'number' ||
        typeof rows !== 'number'
      ) {
        return;
      }
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(ptyGeneration);
        const applied = workspace.resize(validatedSessionId, validatedGeneration, cols, rows);
        if (!applied) {
          return;
        }
        // This is the app-normalized request, not an OS/ConPTY acknowledgement.
        mainWindow?.webContents.send(
          'terminal:size',
          validatedSessionId,
          validatedGeneration,
          resizeRevision,
          applied.cols,
          applied.rows,
        );
      } catch {
        // A ResizeObserver callback can race with project closure.
      }
    },
  );
  ipcMain.handle('workspace:get-stored-projects', async (event) => {
    validateSender(event);
    return workspaceStore.getProjects().filter((project) => existsSync(project.path));
  });
  ipcMain.handle('workspace:remove-stored-project', async (event, projectPath: unknown) => {
    validateSender(event);
    if (typeof projectPath !== 'string') {
      throw new Error('项目路径格式无效。');
    }
    workspaceStore.removeProject(projectPath);
  });
  ipcMain.handle('ui:set-theme', async (event, themeId: unknown) => {
    validateSender(event);
    if (!isTerminalThemeId(themeId)) {
      throw new Error('主题标识无效。');
    }
    workspaceStore.setTheme(themeId);
    workspace.setTheme(themeId);
    claudeRuntime?.setTheme(themeId);
    applyWindowTheme(themeId);
  });
  ipcMain.handle('claude:get-sessions', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    const active =
      nativeConversationService?.activeConversationIds(status.cwd) ?? new Set<string>();
    return sessionManager
      .getSessionsForProject(status.cwd)
      .filter((session) => !active.has(session.conversationId.toLowerCase()));
  });
  ipcMain.handle('claude:get-sessions-for-path', async (event, projectPath: unknown) => {
    validateSender(event);
    const validatedProjectPath = validateProjectPath(projectPath);
    const active =
      nativeConversationService?.activeConversationIds(validatedProjectPath) ?? new Set<string>();
    return sessionManager
      .getSessionsForProject(validatedProjectPath)
      .filter((session) => !active.has(session.conversationId.toLowerCase()));
  });
  ipcMain.handle(
    'claude:rename-session',
    async (event, projectPath: unknown, conversationId: unknown, title: unknown) => {
      validateSender(event);
      if (
        typeof conversationId !== 'string' ||
        !isValidClaudeSessionId(conversationId) ||
        typeof title !== 'string'
      ) {
        throw new Error('历史对话重命名参数无效。');
      }
      return sessionManager.renameSession(
        validateProjectPath(projectPath),
        conversationId,
        normalizeClaudeSessionTitle(title),
      );
    },
  );
  ipcMain.handle('claude:get-connection-advice', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getConnectionAdvice(status.cwd);
  });
  ipcMain.handle(
    'claude:delete-session',
    async (
      event,
      projectPath: unknown,
      conversationId: unknown,
    ): Promise<ClaudeSessionDeleteResult> => {
      validateSender(event);
      try {
        if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
          throw new Error('会话标识无效。');
        }
        return await deleteClaudeConversation(validateProjectPath(projectPath), conversationId);
      } catch (error) {
        return {
          deleted: false,
          error: error instanceof Error ? error.message : '无法删除这个历史对话。',
          ok: false,
          state: describeWorkspace(),
        };
      }
    },
  );
  ipcMain.handle(
    'claude:launch-with-session',
    async (event, sessionId: unknown, conversationId: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
            throw new Error('会话标识无效。');
          }
          const existingOwner = conversationOwnerRegistry.ownerFor({
            conversationId,
            projectPath: status.cwd,
            runtime: 'claude',
          });
          if (existingOwner) {
            if (existingOwner.ownerId === `terminal:${validatedSessionId}`) {
              return { ok: true, state: await runtime.getState(validatedSessionId, status.cwd) };
            }
            throw new Error(
              existingOwner.ownerKind === 'native'
                ? '该对话已在原生界面运行。'
                : '该对话已在另一个高级终端运行。',
            );
          }
          const terminalOwner: ConversationOwner = {
            conversationId: conversationId.toLowerCase(),
            generation: Number(status.ptyGeneration) + 1,
            ownerId: `terminal:${validatedSessionId}`,
            ownerKind: 'terminal',
            phase: 'starting',
            projectPath: status.cwd,
            runtime: 'claude',
          };
          const ownerClaim = conversationOwnerRegistry.claim(terminalOwner);
          if (ownerClaim.status === 'conflict') {
            throw new Error('该对话刚刚被其他界面接管。');
          }
          terminalConversationOwners.set(validatedSessionId, ownerClaim.owner);
          return claudeConversationLifecycle.runResume(
            status.cwd,
            conversationId,
            validatedSessionId,
            async (conversationOwnership) => {
              const assertResumeCurrent = (): void => {
                conversationOwnership.assertCurrent();
                assertCurrent();
              };
              let launchPrepared = false;
              let ownedGeneration: PtyGeneration | undefined;
              try {
                const officialProvider = runtime.officialNetworkProvider(status.cwd);
                if (officialProvider) {
                  await assertOfficialProviderAllowed(officialProvider, 'cli-launch', status.cwd);
                  assertResumeCurrent();
                }
                const prepared = await runtime.prepareLaunchWithSession(
                  validatedSessionId,
                  status.cwd,
                  conversationId,
                );
                launchPrepared = true;
                ownedGeneration = prepared.predecessorPtyGeneration;
                assertResumeCurrent();
                restartRuntimeTerminal(
                  runtime,
                  validatedSessionId,
                  prepared.environment,
                  prepared.command,
                  '无法为 Claude Code 启动安全终端。',
                  assertResumeCurrent,
                  (ptyGeneration) => {
                    ownedGeneration = ptyGeneration;
                  },
                );
                const state = await runtime.getState(validatedSessionId, status.cwd);
                assertResumeCurrent();
                conversationOwnerRegistry.updatePhase(
                  terminalOwner,
                  terminalOwner.ownerId,
                  terminalOwner.generation,
                  'active',
                );
                return { ok: true, state };
              } catch (error) {
                if (launchPrepared || ownedGeneration !== undefined) {
                  cleanupFailedRuntimeLaunch(
                    failedRuntimeLaunchCleanupDependencies,
                    runtime,
                    validatedSessionId,
                    ownedGeneration,
                  );
                }
                releaseTerminalConversationOwner(validatedSessionId);
                return claudeFailure(validatedSessionId, error);
              }
            },
          );
        });
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle('claude:plugins-get', async (event, refresh: unknown) => {
    validateSender(event);
    return pluginManager.getCatalog(refresh === true);
  });
  for (const [channel, run] of pluginMutations) {
    ipcMain.handle(channel, async (event, argument: unknown, flag: unknown) => {
      validateSender(event);
      return runPluginMutation(async () => {
        const identity =
          typeof argument === 'string'
            ? createHash('sha256').update(argument).digest('hex').slice(0, 16)
            : 'global';
        const action = channel.includes('uninstall')
          ? 'uninstall'
          : channel.includes('disable')
            ? 'disable'
            : channel.includes('enable')
              ? 'enable'
              : channel.includes('update')
                ? 'update'
                : channel.includes('refresh')
                  ? 'refresh'
                  : channel.includes('remove')
                    ? 'remove'
                    : 'install';
        const actionLabel = (
          {
            disable: '禁用',
            enable: '启用',
            install: '安装',
            refresh: '刷新',
            remove: '移除',
            uninstall: '卸载',
            update: '更新',
          } as const
        )[action];
        const target =
          typeof argument === 'string' && /^[\w@./:-]{1,120}$/.test(argument)
            ? argument
            : channel.includes('marketplace')
              ? '插件市场'
              : '所选插件';
        const release = busyRegistry?.acquire({
          action,
          cancellable: false,
          domain: 'plugin',
          id: `plugin:${channel}:${identity}`,
          kind:
            channel.includes('uninstall') || channel.includes('remove') ? 'uninstall' : 'install',
          label: `${actionLabel} ${target}`,
          severity: 'blocking',
          stage: `${actionLabel} Claude Code 插件`,
          target,
        });
        try {
          return await run(argument, flag);
        } finally {
          release?.();
        }
      });
    });
  }
  ipcMain.handle(
    'mcp:get-catalog',
    async (event, cwd: unknown, refresh: unknown): Promise<McpCatalog> => {
      validateSender(event);
      return requireMcpManager().getCatalog(validateProjectPath(cwd), refresh === true);
    },
  );
  ipcMain.handle('mcp:install', async (event, rawInput: unknown): Promise<McpOperationResult> => {
    validateSender(event);
    const input = validateMcpInstallInput(rawInput);
    return runMcpMutation(input.cwd, () => requireMcpManager().install(input));
  });
  ipcMain.handle('mcp:remove', async (event, rawInput: unknown): Promise<McpOperationResult> => {
    validateSender(event);
    const input = validateMcpRemoveInput(rawInput);
    return runMcpMutation(input.cwd, () => requireMcpManager().remove(input));
  });
  ipcMain.handle(
    'mcp:toggle-preview',
    async (event, cwd: unknown, name: unknown, enabled: unknown): Promise<McpTogglePreview> => {
      validateSender(event);
      if (typeof name !== 'string' || typeof enabled !== 'boolean') {
        throw new Error('MCP 启停参数无效。');
      }
      return requireMcpManager().previewToggle(validateProjectPath(cwd), name, enabled);
    },
  );
  ipcMain.handle(
    'mcp:toggle-apply',
    async (event, previewId: unknown, cwd: unknown): Promise<McpOperationResult> => {
      validateSender(event);
      if (typeof previewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(previewId)) {
        throw new Error('MCP 改动预览标识无效。');
      }
      const validatedCwd = validateProjectPath(cwd);
      return runMcpMutation(validatedCwd, () => requireMcpManager().applyToggle(previewId));
    },
  );
  ipcMain.handle('mcp:backups', (event): McpBackupView[] => {
    validateSender(event);
    return requireMcpManager().listBackups();
  });
  ipcMain.handle(
    'mcp:backup-restore',
    async (event, backupId: unknown, cwd: unknown): Promise<McpOperationResult> => {
      validateSender(event);
      if (typeof backupId !== 'string') throw new Error('MCP 备份标识无效。');
      const validatedCwd = validateProjectPath(cwd);
      return runMcpMutation(validatedCwd, () =>
        requireMcpManager().restoreBackup(backupId, validatedCwd),
      );
    },
  );
  ipcMain.handle('software:updates-get', async (event, refresh: unknown) => {
    validateSender(event);
    return requireClaudeRuntime().getSoftwareUpdates(refresh === true);
  });
  ipcMain.handle(
    'software:claude-install-update',
    async (event): Promise<SoftwareUpdateOperationResult> => {
      validateSender(event);
      assertApplicationUpdatesAllowed();
      const runtime = requireClaudeRuntime();
      const operationId = 'software:claude-install-update';
      const release = busyRegistry?.acquire({
        action: 'update',
        cancellable: false,
        domain: 'claude-code',
        id: operationId,
        kind: 'install',
        label: 'Claude Code',
        severity: 'blocking',
        stage: '准备安装或更新',
        target: 'Claude Code',
      });
      let logTail: string[] = [];
      try {
        const result = await runtime.installOrUpdateClaudeCode(({ line, stage }) => {
          if (line) logTail = [...logTail, line].slice(-8);
          busyRegistry?.update(operationId, { logTail, stage });
        });
        return { message: result.message, ok: true, state: result.state };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法安装或更新 Claude Code。';
        return {
          error: message,
          message,
          ok: false,
          state: await runtime.getSoftwareUpdates(true),
        };
      } finally {
        release?.();
      }
    },
  );
  ipcMain.handle('software:application-updater-get', (event) => {
    validateSender(event);
    if (!applicationUpdaterService) throw new Error('应用更新服务尚未就绪。');
    return applicationUpdaterService.getState();
  });
  ipcMain.handle('software:application-updater-download', async (event) => {
    validateSender(event);
    assertApplicationUpdatesAllowed();
    if (!applicationUpdaterService) throw new Error('应用更新服务尚未就绪。');
    return applicationUpdaterService.checkAndDownload();
  });
  ipcMain.handle('software:application-updater-install', async (event) => {
    validateSender(event);
    assertApplicationUpdatesAllowed();
    if (!applicationUpdaterService) throw new Error('应用更新服务尚未就绪。');
    if (applicationUpdaterService.getState().phase !== 'downloaded') {
      throw new Error('更新安装包尚未下载完成。');
    }
    claudePermissionBridge?.shutdown();
    await runtimeProcessRegistry?.terminateAll();
    runtimeProcessRegistry?.stop();
    isQuitting = true;
    try {
      applicationUpdaterService.installDownloaded();
    } catch (error) {
      isQuitting = false;
      throw error;
    }
  });
};

const createTray = (): void => {
  tray = new Tray(nativeImage.createFromPath(trayIconForState(describeWorkspace())));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTray();
};

/**
 * The native frame is drawn by Windows, not by CSS, so the theme has to be pushed into Electron as
 * well — otherwise the chosen colour stops at the document edge and the window keeps a dark ring.
 */
const applyWindowTheme = (themeId: TerminalThemeId): void => {
  const { shell } = TERMINAL_THEMES[themeId];
  mainWindow?.setBackgroundColor(shell.surfaceCanvas);
  mainWindow?.setTitleBarOverlay({
    color: shell.surface1,
    height: 48,
    symbolColor: shell.textHi,
  });
};

const createWindow = async (): Promise<void> => {
  // Reading the remembered theme before the first paint keeps cold start from flashing the wrong hue.
  const { shell } = TERMINAL_THEMES[workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME];
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: shell.surfaceCanvas,
    height: 760,
    icon: assetPath('app-icon-256.png'),
    minHeight: 640,
    minWidth: 820,
    show: false,
    title: 'ClaudeDock 控制面板',
    titleBarOverlay: {
      color: shell.surface1,
      height: 48,
      symbolColor: shell.textHi,
    },
    titleBarStyle: 'hidden',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
    },
    width: 1180,
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('render-process-gone', () => {
    claudePermissionBridge?.fallbackPending();
  });
  /*
   * The OS is logging out or shutting down. Windows gives an app very little time here and kills it
   * regardless, so this is the one quit that must not be questioned: latch the flag so the following
   * `before-quit` runs its teardown straight through instead of asking.
   */
  mainWindow.on('session-end', () => {
    downloadEngine?.flushJournal();
    if (quitConfirmationTimer) {
      clearTimeout(quitConfirmationTimer);
      quitConfirmationTimer = undefined;
    }
    isQuitting = true;
    quitConfirmationPending = false;
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault();
    }
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    if (appPreferencesStore.get().closeBehavior === 'exit') {
      requestQuit();
      return;
    }
    hideMainWindowToTray();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => {
    showMainWindow();
  });

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
};

const hasSingleInstanceLock =
  !runtimeProfile.effects.singleInstanceLock || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // A duplicate launch has nothing to protect and no window to ask through: leave immediately.
  isQuitting = true;
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  });
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy || !applicationProxyStore) return;
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
  app.whenReady().then(async () => {
    app.setAppUserModelId('io.github.aeonusovo.claudedock');
    artifactService.install();
    busyRegistry = new BusyRegistry((leases) => {
      mainWindow?.webContents.send('busy:changed', leases);
      updateTray();
    });
    mcpManager = new McpManager(
      runtimeProfile.paths.home,
      runtimeProfile.paths.userData,
      busyRegistry,
    );
    downloadEngine = new DownloadEngine(
      session.defaultSession as unknown as DownloadSession,
      busyRegistry,
      app.getPath('userData'),
      (tasks) => {
        mainWindow?.webContents.send('download:changed', tasks);
      },
    );
    downloadEngine.install();
    ccSwitchAdapter = new CcSwitchAdapter(
      app.getPath('userData'),
      downloadEngine,
      busyRegistry,
      (url) => shell.openExternal(url),
      (url, init) => session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
    );
    managedChatGptGateway = new ManagedChatGptGateway(
      app.getPath('userData'),
      downloadEngine,
      busyRegistry,
      safeStorage,
      (url, init) => session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
    );
    applicationProxyStore = new ApplicationProxyStore(app.getPath('userData'), safeStorage);
    conversationNetworkSession = session.fromPartition('claudedock-conversation-network');
    applicationProxyTestSession = session.fromPartition('claudedock-application-proxy-test');
    chatFetch = (url, init) =>
      conversationNetworkSession!.fetch(url instanceof URL ? url.toString() : url, init);
    await applyApplicationProxyScope();
    await applyConversationProxyScope();
    // Restore only after the selected application network path is stable.
    if (runtimeProfile.effects.restoreWorkspace) {
      downloadEngine.restoreInterrupted();
    }
    workspace.setEnvironmentProvider(() =>
      applicationProxyStore
        ? buildApplicationProxyEnvironment(
            applicationProxyStore.getView(),
            applicationProxyStore.getCredentials(),
          )
        : {},
    );
    runtimeProcessRegistry = new RuntimeProcessRegistry((sessionId, processes) => {
      if (!workspace.hasSession(sessionId)) return;
      const status = workspace.getStatus(sessionId);
      const activity = runtimeActivityRegistry.get(sessionId);
      if (activity.ptyGeneration !== status.ptyGeneration) {
        runtimeActivityRegistry.beginLaunch(
          sessionId,
          activity.launchGeneration,
          status.ptyGeneration,
        );
      }
      runtimeActivityRegistry.setWebProcesses(sessionId, processes);
    });
    claudeRuntime = new ClaudeRuntime(
      app.getPath('userData'),
      runtimeAssetPath('claude-statusline.ps1'),
      runtimeAssetPath('claude-runtime-signal.ps1'),
      runtimeAssetPath('claude-web-search-guard.ps1'),
      () => advancedSettingsStore.get().webResearchIsolation,
      () => appPreferencesStore.get().managedChatGptContextWindowMode,
      (state) => {
        publishClaudeProjectState(state);
      },
      (sessionId, ptyGeneration, data) => workspace.write(sessionId, ptyGeneration, data),
      requestPermissionModeFromScreen,
      () => requireManagedChatGptGateway().ensureRunning(),
      () => requireManagedChatGptGateway().getInstalledVersion(),
      (url, init) => session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
      workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME,
      app.getVersion(),
      (progress) => {
        mainWindow?.webContents.send('router:operation-progress', progress);
      },
      () => requireManagedChatGptGateway().stop(),
      () =>
        applicationProxyStore
          ? buildApplicationProxyEnvironment(
              applicationProxyStore.getView(),
              applicationProxyStore.getCredentials(),
            )
          : {},
    );
    const nativeAdapter =
      runtimeProfile.adapterMode === 'fake'
        ? new FakeConversationAdapter()
        : new ClaudeAgentAdapter({
            appVersion: app.getVersion(),
            environment: (input) => {
              const launch = nativeLaunches.get(input.conversationId);
              if (!launch) throw new Error('原生对话的接入环境尚未准备完成。');
              return {
                ...launch.prepared.environment,
                ...(applicationProxyStore
                  ? buildApplicationProxyEnvironment(
                      applicationProxyStore.getView(),
                      applicationProxyStore.getCredentials(),
                    )
                  : {}),
              };
            },
          });
    nativeConversationService = new NativeConversationService({
      adapter: nativeAdapter,
      onSnapshot: (snapshot) => {
        mainWindow?.webContents.send('native-conversation:snapshot', snapshot);
        if (snapshot.phase === 'failed' || snapshot.phase === 'stopped') {
          const launch = nativeLaunches.get(snapshot.conversationId);
          if (launch) {
            claudeRuntime?.releaseNativeConversation(launch.ownerId);
            nativeLaunches.delete(snapshot.conversationId);
          }
        }
      },
      onSubmissionConfirmed: async (conversationId, attachmentIds) => {
        await Promise.all(
          attachmentIds.map((attachmentId) =>
            nativeAttachmentStore.remove(conversationId, attachmentId),
          ),
        );
      },
      ownerRegistry: conversationOwnerRegistry,
      recoveryStore: new ConversationRecoveryStore(runtimeProfile.paths.userData, safeStorage),
      runtime: 'claude',
    });
    const interruptedNativeConversations = nativeConversationService.recoverInterrupted();
    // rc.2 could leave a recovery row when the adapter failed before Claude created a transcript.
    // Such an empty reservation has no prompt, output, or session to recover. Reconcile it against
    // Claude's canonical JSONL index so the upgrade cleans the false card without touching history.
    for (const recovery of interruptedNativeConversations) {
      if (
        recovery.submissions.length === 0 &&
        !sessionManager
          .getSessionsForProject(recovery.projectPath)
          .some((session) => session.conversationId === recovery.conversationId)
      ) {
        nativeConversationService.discardRecovery(recovery.conversationId, recovery.projectPath);
      }
    }
    claudePermissionBridge = new ClaudePermissionBridge(
      (request) => {
        const target = mainWindow?.webContents;
        if (!target || target.isDestroyed() || target.isCrashed()) return false;
        target.send('claude:permission-request', request);
        return true;
      },
      (sessionId, launchGeneration) =>
        claudeRuntime?.ownsLaunch(sessionId, launchGeneration) ?? false,
    );
    claudeRuntime.setPermissionRequestHook(
      runtimeAssetPath('claude-permission-hook.ps1'),
      (sessionId, launchGeneration) =>
        claudePermissionBridge!.createEndpoint(sessionId, launchGeneration),
    );
    claudeStreamDiagnosticsStore = new ClaudeStreamDiagnosticsStore(app.getPath('userData'));
    claudeRuntime.setStreamFailureHandler((observation) => {
      const activity = runtimeActivityRegistry.get(observation.sessionId);
      claudeStreamDiagnosticsStore?.append({
        ...observation,
        backgroundTaskCount: activity.tasks.filter(
          (task) =>
            task.status === 'queued' || task.status === 'running' || task.status === 'waiting',
        ).length,
      });
      runtimeActivityRegistry.setPhase(observation.sessionId, 'failed');
    });
    claudeRuntime.setRuntimeActivityHandler(
      runtimeAssetPath('claude-runtime-event.ps1'),
      (event) => {
        if (event.event === 'SessionEnd') {
          claudePermissionBridge?.closeLaunch(event.sessionId, event.launchGeneration);
        }
        runtimeActivityRegistry.consume(event);
      },
    );
    claudeRuntime.setConversationLaunchGuard((cwd, mode, conversationId) => {
      claudeConversationLifecycle.assertLaunchAllowed(cwd, mode, conversationId);
    });
    codexRuntime = new CodexRuntime(
      app.getPath('userData'),
      (state) => {
        if (workspace.hasSession(state.sessionId)) {
          mainWindow?.webContents.send('codex:state', state);
        }
      },
      (sessionId, ptyGeneration, data) => workspace.write(sessionId, ptyGeneration, data),
      downloadEngine,
      busyRegistry,
      (url, init) => session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
    );
    networkPreflightService = new NetworkPreflightService({
      diagnosticsStore: new NetworkDiagnosticsStore(app.getPath('userData')),
      onResult: (result) => {
        mainWindow?.webContents.send('network-preflight:result', result);
      },
      probe: new ProviderConnectivityProbe({
        appFetch: (url, init) => net.fetch(url, init),
        applicationRequest: createElectronApplicationRequest((options) =>
          net.request({ ...options, session: session.defaultSession }),
        ),
        cliEnvironment: () =>
          applicationProxyStore
            ? buildApplicationProxyEnvironment(
                applicationProxyStore.getView(),
                applicationProxyStore.getCredentials(),
              )
            : {},
        resolveProxy: (url) => session.defaultSession.resolveProxy(url),
        applicationProxyUrl: () =>
          applicationProxyStore ? applicationProxyUrl(applicationProxyStore.getView()) : undefined,
      }),
    });
    providerAccessGuard = new ProviderAccessGuard(networkPreflightService);
    runtimeProcessRegistry.start(() =>
      workspace
        .getState()
        .sessions.filter((status): status is TerminalStatus & { pid: number } =>
          Boolean(status.phase === 'running' && status.pid),
        )
        .map((status) => ({
          launchGeneration: runtimeActivityRegistry.get(status.id).launchGeneration,
          ptyGeneration: status.ptyGeneration,
          rootPid: status.pid,
          sessionId: status.id,
        })),
    );
    const updateFloorFile = updateVersionFloorPath(app.getPath('userData'));
    let activeApplicationUpdateSource: ApplicationUpdateSourceSelection | undefined;
    const applicationUpdateSession = session.fromPartition('electron-updater', {
      cache: false,
    });
    applicationUpdateSession.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel:
          !activeApplicationUpdateSource ||
          !isApplicationUpdateRequestAllowed(activeApplicationUpdateSource, details.url),
      });
    });
    applicationUpdaterService = new ApplicationUpdaterService({
      configureSource: (source) => {
        activeApplicationUpdateSource = source;
      },
      currentVersion: app.getVersion(),
      driver: autoUpdater as unknown as ApplicationUpdaterDriver,
      enabled:
        runtimeProfile.effects.allowApplicationUpdates &&
        app.isPackaged &&
        process.platform === 'win32',
      onChange: (state) => {
        mainWindow?.webContents.send('software:application-updater-changed', state);
      },
      onTrustedVersion: (version) => {
        recordHighestTrustedVersion(updateFloorFile, version);
      },
      selectSource: () => {
        const publicKeyPem = readFileSync(
          runtimeAssetPath('release-manifest-public-key.pem'),
          'utf8',
        );
        return selectApplicationUpdateSource(
          loadApplicationUpdateSources(runtimeAssetPath('update-sources.json')),
          (url, init) => session.defaultSession.fetch(url, init),
          {
            currentVersion: app.getVersion(),
            highestTrustedVersion: readHighestTrustedVersion(updateFloorFile),
            publicKeyPem,
          },
        );
      },
    });
    registerIpc();
    if (runtimeProfile.effects.tray) {
      createTray();
    }

    // Remembered folders are listed without a terminal each — otherwise every folder ever opened
    // would spawn a PowerShell at startup. Only the folder in use last time is reopened live.
    const lastActive = runtimeProfile.effects.restoreWorkspace
      ? workspaceStore.getLastActiveProject()
      : undefined;
    if (lastActive && existsSync(lastActive)) {
      try {
        const result = workspace.openProject(lastActive);
        const restored = result.state.sessions.find((session) =>
          sameDirectory(session.cwd, lastActive),
        );
        if (restored) {
          activateProject(restored.id);
        }
      } catch {
        // A folder that has become unreadable stays in the list as a remembered entry.
      }
    }

    await createWindow();
    if (runtimeProfile.effects.allowExternalRoutingWrites) {
      void claudeRuntime.recoverInterruptedRouterInstall().catch(() => {
        // The journal is intentionally retained; the next launch or install click retries safely.
      });
    }
  });
}

app.on('activate', showMainWindow);
app.on('before-quit', (event) => {
  /*
   * Anything that can reach here without going through `requestQuit` — Alt+F4 on a visible window,
   * `Cmd/Ctrl+Q`, an installer restart — is bounced back through the same confirmation. `isQuitting`
   * is the one-way latch that lets the real quit through on the second pass.
   */
  if (!isQuitting) {
    event.preventDefault();
    requestQuit();
    return;
  }
  downloadEngine?.flushJournal();
  terminalOutputBatcher.dispose();
  for (const pending of pendingPermissionModeProbes.values()) {
    clearTimeout(pending.timer);
    pending.resolve(undefined);
  }
  pendingPermissionModeProbes.clear();
  claudePermissionBridge?.shutdown();
  runtimeProcessRegistry?.stop();
  shutdownRuntimeForQuit();
});
