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
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, release } from 'node:os';
import path from 'node:path';
import type {
  AdvancedSettings,
  AppSettingsView,
  ClaudeConfigResult,
  ClaudeConnectionTestResult,
  ClaudeConnectionHistoryResult,
  ClaudeCodeInstallSource,
  ClaudeEffortRequest,
  ClaudeLaunchMode,
  ClaudeOperationResult,
  ClaudePermissionMode,
  ClaudePluginCatalog,
  ClaudePluginOperationResult,
  ClaudeRelaunchInput,
  ClaudeRouterOperationResult,
  ClaudeRouterInstallSource,
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
  NetworkPreflightAction,
  NetworkPreflightRunInput,
  NetworkPreflightSettings,
  NetworkProviderId,
  McpCatalog,
  McpBackupView,
  McpInstallInput,
  McpOperationResult,
  McpRemoveInput,
  McpScope,
  McpTogglePreview,
  SoftwareUpdateOperationResult,
  DirectoryChoiceResult,
  OperationResult,
  ProxyAuditRecord,
  ProxyControlView,
  ProxyProfileInput,
  ProxyScopeSettings,
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
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../shared/terminal-themes';
import { CLAUDE_PROVIDER_EXTERNAL_HOSTS, claudeProviderIdSet } from '../shared/claude-providers';
import { selectRouterKernelState } from '../shared/router-kernel';
import { CLAUDE_EFFORT_REQUESTS } from '../shared/claude-effort';
import {
  ClaudePluginManager,
  isValidMarketplaceName,
  isValidMarketplaceSource,
  isValidPluginId,
} from './claude-plugin-manager';
import { ClaudeRuntime } from './claude-runtime';
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
import { sameDirectory, TerminalWorkspace } from './terminal-workspace';
import { WorkspaceStore } from './workspace-store';
import { AdvancedSettingsStore } from './advanced-settings-store';
import { NetworkDiagnosticsStore } from './network-diagnostics-store';
import { NetworkPreflightService } from './network-preflight-service';
import { NetworkPreflightSettingsStore } from './network-preflight-settings-store';
import { ProviderAccessGuard } from './provider-access-guard';
import { createElectronApplicationRequest } from './electron-application-request';
import { ProviderConnectivityProbe } from './provider-connectivity-probe';
import { RollbackCoordinator } from './rollback-coordinator';
import { BusyRegistry } from './busy-registry';
import { DownloadEngine, type DownloadSession } from './download-engine';
import { CcSwitchAdapter } from './cc-switch-adapter';
import { McpManager } from './mcp-manager';
import { AppPreferencesStore } from './app-preferences-store';
import { ProxyStore } from './proxy/proxy-store';
import { XraySidecar } from './proxy/xray-sidecar';
import {
  buildCliProxyEnvironment,
  builtInProxyRules,
  normalizeBootstrapProxyUrl,
} from './proxy/proxy-environment';
import { parseProxyImportText } from './proxy/proxy-parser';
import { downloadProxySubscription } from './proxy/proxy-subscription';
import { LeakAuditService } from './proxy/leak-audit';
import { LeakAuditStore } from './proxy/leak-audit-store';
import { auditWebRtc } from './proxy/webrtc-audit';
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
let proxyStore: ProxyStore | null = null;
let xraySidecar: XraySidecar | null = null;
let proxyLeakAuditService: LeakAuditService | null = null;
let releaseConversationBusy: (() => void) | undefined;

interface PendingPermissionModeProbe {
  resolve: (mode: ClaudePermissionMode | undefined) => void;
  sessionId: string;
  timer: NodeJS.Timeout;
}

const PERMISSION_MODE_PROBE_TIMEOUT_MS = 300;
let nextPermissionModeProbeId = 1;
const pendingPermissionModeProbes = new Map<number, PendingPermissionModeProbe>();

/**
 * Requests a synchronous fact from the renderer's xterm buffer. Passive PTY output reports keep the
 * footer current, while this request/reply path gives a mode-switch step a fresh before/after
 * barrier and prevents another Shift+Tab from being sent against an unreadable screen.
 */
const requestPermissionModeFromScreen = (
  sessionId: string,
): Promise<ClaudePermissionMode | undefined> =>
  new Promise((resolve) => {
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
    pendingPermissionModeProbes.set(probeId, { resolve, sessionId, timer });
    try {
      target.send('claude:permission-mode-probe', sessionId, probeId);
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
const OUTPUT_FLUSH_MS = 8;
const OUTPUT_FLUSH_BYTES = 64 * 1024;

interface OutputBuffer {
  chunks: string[];
  length: number;
  timer: NodeJS.Timeout | undefined;
}

const outputBuffers = new Map<string, OutputBuffer>();

const flushTerminalOutput = (sessionId: string): void => {
  const buffer = outputBuffers.get(sessionId);
  if (!buffer) {
    return;
  }
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  outputBuffers.delete(sessionId);
  if (buffer.chunks.length > 0) {
    mainWindow?.webContents.send('terminal:data', sessionId, buffer.chunks.join(''));
  }
};

const queueTerminalOutput = (sessionId: string, data: string): void => {
  const buffer = outputBuffers.get(sessionId) ?? { chunks: [], length: 0, timer: undefined };
  buffer.chunks.push(data);
  buffer.length += data.length;
  outputBuffers.set(sessionId, buffer);

  if (buffer.length >= OUTPUT_FLUSH_BYTES) {
    flushTerminalOutput(sessionId);
    return;
  }
  buffer.timer ??= setTimeout(() => {
    flushTerminalOutput(sessionId);
  }, OUTPUT_FLUSH_MS);
};

const workspace = new TerminalWorkspace(
  (sessionId, data) => {
    const claudeFiltered = claudeRuntime?.consumeTerminalOutput(sessionId, data) ?? data;
    const filtered =
      codexRuntime?.consumeTerminalOutput(sessionId, claudeFiltered) ?? claudeFiltered;
    if (filtered) {
      queueTerminalOutput(sessionId, filtered);
    }
  },
  (state) => {
    const enriched = describeWorkspace(state);
    mainWindow?.webContents.send('workspace:state', enriched);
    updateTray(enriched);
  },
);

const workspaceStore = new WorkspaceStore(app.getPath('userData'));
const advancedSettingsStore = new AdvancedSettingsStore(app.getPath('userData'));
const appPreferencesStore = new AppPreferencesStore(app.getPath('userData'));
const agentRuntimeStore = new AgentRuntimeStore(app.getPath('userData'));
workspace.setTheme(workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME);
const sessionManager = new ClaudeSessionManager();
const pluginManager = new ClaudePluginManager(homedir());
const chatConfigStore = new ChatConfigStore(app.getPath('userData'));
const chatAttachmentStore = new ChatAttachmentStore(app.getPath('userData'));
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
  fetch,
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
 * Starts a quit. The main-process busy registry is authoritative; when it is non-empty, the renderer
 * presents the themed decision and answers through `app:confirm-quit`.
 */
const requestQuit = (): void => {
  if (isQuitting) {
    return;
  }
  const window = mainWindow;
  const leases = busyRegistry?.list() ?? [];
  if (leases.length === 0) {
    isQuitting = true;
    app.quit();
    return;
  }
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
    isQuitting = true;
    app.quit();
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
    isQuitting = true;
    app.quit();
  }, 3_000);
  quitConfirmationTimer.unref();
};

const chooseDirectory = async (ownerWindow?: BrowserWindow): Promise<DirectoryChoiceResult> => {
  const defaultPath = directoryDialogDefaultPath(
    workspace.getActiveStatus()?.cwd ?? homedir(),
    homedir(),
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
    const result = workspace.openProject(resolved);

    // Save to persistent workspace
    workspaceStore.addProject(resolved);

    return {
      ok: true,
      reused: result.reused,
      state: describeWorkspace(result.state),
    };
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

/** Drops every runtime session bound to a folder so agent state does not leak into a reopen. */
const releaseRuntimeForSessions = (sessionIds: string[]): void => {
  for (const sessionId of sessionIds) {
    claudeRuntime?.closeSession(sessionId);
    codexRuntime?.closeSession(sessionId);
  }
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
                workspace.restart(activeStatus.id);
              },
              label: `重启 ${sessionLabel(activeStatus)}`,
            } satisfies MenuItemConstructorOptions,
            {
              click: () => {
                if (activeStatus.phase === 'running') {
                  workspace.stop(activeStatus.id);
                } else {
                  workspace.start(activeStatus.id);
                }
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

const requireClaudeRuntime = (): ClaudeRuntime => {
  if (!claudeRuntime) {
    throw new Error('Claude 工作台尚未初始化。');
  }
  return claudeRuntime;
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

/**
 * The last rules handed to Chromium. `setProxy` + `closeAllConnections` tears down every live socket,
 * so replaying identical rules on each runtime-view change (every log line during startup) would keep
 * killing the very download that startup is waiting on.
 */
let appliedProxyRules = '';

const applyApplicationProxyScope = async (): Promise<void> => {
  if (!proxyStore || !xraySidecar) {
    return;
  }
  const rules = builtInProxyRules(xraySidecar.getView(), proxyStore.getView().scope);
  const signature = JSON.stringify(rules);
  if (signature === appliedProxyRules) {
    return;
  }
  appliedProxyRules = signature;
  await session.defaultSession.setProxy(rules);
  await session.defaultSession.closeAllConnections();
};

const requireProxyServices = (): {
  audit: LeakAuditService;
  sidecar: XraySidecar;
  store: ProxyStore;
} => {
  if (!proxyStore || !xraySidecar || !proxyLeakAuditService) {
    throw new Error('内置代理服务尚未初始化。');
  }
  return { audit: proxyLeakAuditService, sidecar: xraySidecar, store: proxyStore };
};

const proxyControlView = (): ProxyControlView => {
  const { audit, sidecar, store } = requireProxyServices();
  return {
    audits: audit.list(),
    core: sidecar.getCoreView(),
    runtime: sidecar.getView(),
    store: store.getView(),
  };
};

/**
 * Lists what a bootstrap proxy *could* be on this machine — the standard proxy environment variables
 * and whatever Windows itself is configured to use. It only ever suggests: the user picks one and
 * confirms, because a port that exists here says nothing about the next machine this ships to.
 */
const detectBootstrapProxyCandidates = async (): Promise<string[]> => {
  const candidates = new Set<string>();
  for (const variable of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY']) {
    const normalized = normalizeBootstrapProxyUrl(process.env[variable]);
    if (normalized) {
      candidates.add(normalized);
    }
  }
  try {
    // `resolveProxy` reports the PAC/system decision for a real destination without changing it.
    const resolved = await session.defaultSession.resolveProxy('https://github.com');
    for (const entry of resolved.split(';')) {
      const [scheme, endpoint] = entry.trim().split(/\s+/);
      if (!endpoint) {
        continue;
      }
      const prefix = scheme === 'SOCKS5' || scheme === 'SOCKS' ? 'socks5' : 'http';
      const normalized = normalizeBootstrapProxyUrl(`${prefix}://${endpoint}`);
      if (normalized) {
        candidates.add(normalized);
      }
    }
  } catch {
    // No system proxy configured is a perfectly normal answer.
  }
  return [...candidates];
};

const selectedProxyProfile = () => {
  const { store } = requireProxyServices();
  const profileId = store.getView().state.selectedProfileId;
  const profile = profileId ? store.getProfile(profileId) : undefined;
  if (!profile) {
    throw new Error('请先选择一个代理节点。');
  }
  return profile;
};

const runSelectedProxyAudit = async (): Promise<ProxyAuditRecord> => {
  const { audit, sidecar, store } = requireProxyServices();
  const profile = selectedProxyProfile();
  const record = await audit.run(profile, sidecar.getView());
  store.setState({
    lastAuditAt: record.report.checkedAt,
    lastAuditConclusion: record.report.summary,
  });
  mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
  return record;
};

/**
 * Shared by the IPC handler and the launch-time restore. `autoStart` is only written once the tunnel
 * is genuinely up, and cleared the moment it is not, so an unexpected exit can be told apart from a
 * deliberate stop or a start that never succeeded.
 */
const startBuiltInProxy = async (manualCorePath?: string): Promise<void> => {
  const { sidecar, store } = requireProxyServices();
  const profile = selectedProxyProfile();
  store.setState({ runtimeStatus: 'starting' });
  try {
    await sidecar.start(profile, manualCorePath);
    store.setState({ autoStart: true, runtimeStatus: 'ready' });
    await applyApplicationProxyScope();
    requireNetworkPreflightService().invalidate('built-in-proxy-started');
    await runSelectedProxyAudit();
  } catch (error) {
    // A cancelled or failed start leaves nothing running: report 已停止 so 启动 becomes available again.
    store.setState({ autoStart: false, runtimeStatus: 'stopped' });
    await applyApplicationProxyScope();
    throw error;
  } finally {
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
  }
};

const stopBuiltInProxy = async (): Promise<void> => {
  const { sidecar, store } = requireProxyServices();
  await sidecar.stop();
  store.setState({ autoStart: false, runtimeStatus: 'stopped' });
  await applyApplicationProxyScope();
  requireNetworkPreflightService().invalidate('built-in-proxy-stopped');
  mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
};

const validateProxyProfileId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('代理节点标识无效。');
  }
  return value;
};

const assertOfficialProviderAllowed = async (
  provider: NetworkProviderId,
  action: NetworkPreflightAction,
  cwd?: string,
): Promise<void> => {
  if (proxyStore && xraySidecar && proxyLeakAuditService) {
    const scope = proxyStore.getView().scope;
    const proxyAffectsAction =
      (action === 'cli-launch' && scope.cli) ||
      (['background', 'cloud-task', 'first-request', 'provider-switch'].includes(action) &&
        scope.application);
    if (proxyAffectsAction && xraySidecar.getView().status === 'ready') {
      proxyLeakAuditService.assertAccessAccepted(selectedProxyProfile());
    }
  }
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

const claudeCommands = new Map<string, boolean>([
  ['/agents', false],
  ['/clear', false],
  ['/compact', true],
  ['/context', true],
  ['/doctor', false],
  ['/help', false],
  ['/hooks', false],
  ['/mcp', false],
  ['/memory', false],
  ['/model', false],
  ['/permissions', false],
  ['/rename', true],
  ['/resume', false],
  ['/status', false],
  ['/theme', false],
  ['/usage', false],
]);

const claudeFailure = async (sessionId: string, error: unknown): Promise<ClaudeOperationResult> => {
  const runtime = requireClaudeRuntime();
  const status = workspace.getStatus(sessionId);
  return {
    error: error instanceof Error ? error.message : 'Claude Code 操作失败。',
    ok: false,
    state: await runtime.getState(sessionId, status.cwd),
  };
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
  return {
    error: message,
    message,
    ok: false,
    routerState: await requireClaudeRuntime().getRouterManagementState(),
  };
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

const routerInstallSources = new Set<ClaudeRouterInstallSource>(['github', 'npm', 'npmmirror']);
const claudeInstallSources = new Set<ClaudeCodeInstallSource>(['native', 'npm', 'npmmirror']);

const windowsBuildNumber = (): number => {
  const value = Number(release().split('.')[2]);
  return Number.isInteger(value) && value > 0 ? value : 0;
};

const launchRouterInstaller = async (): Promise<ClaudeRouterOperationResult> => {
  const runtime = requireClaudeRuntime();
  try {
    const installer = await runtime.downloadRouterInstaller();
    const launchError = await shell.openPath(installer.filePath);
    if (launchError) {
      throw new Error(`安装包已校验，但无法启动：${launchError}`);
    }
    return {
      message: `CCR ${installer.version} 官方安装程序已通过 SHA-256 校验并启动，请完成安装向导。`,
      ok: true,
      routerState: await runtime.getRouterManagementState(),
    };
  } catch (error) {
    return routerFailure(error, '无法下载或启动 CCR 官方安装程序。');
  }
};

const registerIpc = (): void => {
  ipcMain.handle('busy:list', (event) => {
    validateSender(event);
    if (!busyRegistry) {
      throw new Error('忙碌任务登记表尚未初始化。');
    }
    return busyRegistry.list();
  });
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
  ipcMain.handle('proxy:get-state', (event) => {
    validateSender(event);
    return proxyControlView();
  });
  ipcMain.handle('proxy:preview-import', (event, text: unknown) => {
    validateSender(event);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('代理导入内容必须小于 2 MiB。');
    }
    return parseProxyImportText(text);
  });
  ipcMain.handle('proxy:preview-subscription', async (event, url: unknown) => {
    validateSender(event);
    if (typeof url !== 'string' || url.length > 2048) {
      throw new Error('代理订阅地址无效。');
    }
    return downloadProxySubscription(requireDownloadEngine(), app.getPath('userData'), url);
  });
  ipcMain.handle('proxy:save-profiles', (event, profiles: unknown) => {
    validateSender(event);
    if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 100) {
      throw new Error('请选择 1–100 个代理节点导入。');
    }
    const { store } = requireProxyServices();
    for (const profile of profiles) {
      if (!profile || typeof profile !== 'object') {
        throw new Error('代理节点格式无效。');
      }
      store.saveProfile(profile as ProxyProfileInput);
    }
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
    return proxyControlView();
  });
  ipcMain.handle('proxy:remove-profile', async (event, profileId: unknown) => {
    validateSender(event);
    const { sidecar, store } = requireProxyServices();
    const validatedId = validateProxyProfileId(profileId);
    if (sidecar.getView().profileId === validatedId) {
      await sidecar.stop();
    }
    store.removeProfile(validatedId);
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
    return proxyControlView();
  });
  ipcMain.handle('proxy:select-profile', async (event, profileId: unknown) => {
    validateSender(event);
    const { sidecar, store } = requireProxyServices();
    const validatedId = validateProxyProfileId(profileId);
    if (sidecar.getView().status !== 'stopped') {
      await sidecar.stop();
    }
    store.setState({ selectedProfileId: validatedId });
    requireNetworkPreflightService().invalidate('built-in-proxy-profile-changed');
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
    return proxyControlView();
  });
  ipcMain.handle('proxy:set-scope', async (event, scope: unknown) => {
    validateSender(event);
    const record =
      scope && typeof scope === 'object' ? (scope as Partial<ProxyScopeSettings>) : undefined;
    if (typeof record?.cli !== 'boolean' || typeof record.application !== 'boolean') {
      throw new Error('代理作用域设置无效。');
    }
    if (
      record.bootstrapProxyUrl !== undefined &&
      (typeof record.bootstrapProxyUrl !== 'string' || record.bootstrapProxyUrl.length > 512)
    ) {
      throw new Error('引导代理地址无效。');
    }
    if (
      record.extraCoreSources !== undefined &&
      (!Array.isArray(record.extraCoreSources) ||
        record.extraCoreSources.length > 16 ||
        record.extraCoreSources.some((entry) => typeof entry !== 'string' || entry.length > 253))
    ) {
      throw new Error('自定义镜像来源无效。');
    }
    requireProxyServices().store.setScope({
      application: record.application,
      bootstrapProxyUrl: record.bootstrapProxyUrl,
      cli: record.cli,
      extraCoreSources: record.extraCoreSources,
    });
    await applyApplicationProxyScope();
    requireNetworkPreflightService().invalidate('built-in-proxy-scope-changed');
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
    return proxyControlView();
  });
  ipcMain.handle('proxy:probe-core-sources', async (event) => {
    validateSender(event);
    /*
     * The bootstrap proxy has to be live before the probe runs, or the probe measures a network path
     * the download will not take. `applyApplicationProxyScope` is a no-op when the rules are already
     * current, so this costs nothing on the common path.
     */
    await applyApplicationProxyScope();
    await requireProxyServices().sidecar.probeSources();
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
    return proxyControlView();
  });
  ipcMain.handle('proxy:install-core-file', async (event, filePath: unknown) => {
    validateSender(event);
    if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) {
      throw new Error('内核文件路径无效。');
    }
    if (!path.isAbsolute(filePath)) {
      throw new Error('内核文件路径必须是绝对路径。');
    }
    await requireProxyServices().sidecar.installCoreFromFile(filePath);
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
    return proxyControlView();
  });
  ipcMain.handle('proxy:detect-bootstrap-proxy', async (event) => {
    validateSender(event);
    return detectBootstrapProxyCandidates();
  });
  ipcMain.handle('proxy:start', async (event, manualCorePath: unknown) => {
    validateSender(event);
    if (
      manualCorePath !== undefined &&
      (typeof manualCorePath !== 'string' || manualCorePath.length > 4096)
    ) {
      throw new Error('Xray-core 路径无效。');
    }
    await startBuiltInProxy(
      typeof manualCorePath === 'string' ? manualCorePath || undefined : undefined,
    );
    return proxyControlView();
  });
  ipcMain.handle('proxy:stop', async (event) => {
    validateSender(event);
    await stopBuiltInProxy();
    return proxyControlView();
  });
  ipcMain.handle('proxy:run-audit', async (event) => {
    validateSender(event);
    return runSelectedProxyAudit();
  });
  ipcMain.handle('proxy:accept-audit', (event, recordId: unknown) => {
    validateSender(event);
    if (typeof recordId !== 'string' || !/^[a-f0-9-]{36}$/i.test(recordId)) {
      throw new Error('代理体检记录标识无效。');
    }
    const record = requireProxyServices().audit.accept(recordId);
    mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
    return record;
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
  ipcMain.handle('network-preflight:get-settings', (event) => {
    validateSender(event);
    return requireNetworkPreflightService().getSettings();
  });
  ipcMain.handle('network-preflight:set-settings', (event, settings: unknown) => {
    validateSender(event);
    const record =
      settings && typeof settings === 'object'
        ? (settings as Partial<NetworkPreflightSettings>)
        : undefined;
    if (typeof record?.enhancedPrivacyMode !== 'boolean') {
      throw new Error('网络预检隐私设置无效。');
    }
    return requireNetworkPreflightService().setSettings({
      enhancedPrivacyMode: record.enhancedPrivacyMode,
    });
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
      await assertOfficialProviderAllowed(officialProvider, 'first-request');
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
      const current = agentRuntimeStore.get(status.cwd);
      if (current !== selected) {
        const projectHasActiveAgent = workspace
          .sessionIdsForDirectory(status.cwd)
          .some(
            (candidateSessionId) =>
              requireClaudeRuntime().isActive(candidateSessionId) ||
              requireCodexRuntime().isActive(candidateSessionId),
          );
        if (projectHasActiveAgent) {
          throw new Error('请先结束当前开发会话，再切换开发引擎。');
        }
        if (
          selected === 'codex' ||
          (selected === 'claude' && requireClaudeRuntime().usesOfficialProvider(status.cwd))
        ) {
          await assertOfficialProviderAllowed(
            selected === 'codex' ? 'openai-codex' : 'anthropic-claude',
            'provider-switch',
            status.cwd,
          );
        }
        const rollback = new RollbackCoordinator();
        rollback.add(() => agentRuntimeStore.set(status.cwd, current));
        try {
          agentRuntimeStore.set(status.cwd, selected);
          rollback.commit();
        } catch (error) {
          await rollback.rollback();
          throw error;
        }
      }
      return { cwd: status.cwd, runtime: selected, sessionId: validatedSessionId };
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
  ipcMain.handle('project:close', (event, sessionId: unknown) => {
    validateSender(event);
    try {
      const validatedSessionId = validateSessionId(sessionId);
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
      const state = workspace.openConversation(resolved);
      workspaceStore.addProject(resolved);
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:close-folder', (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const target = validateProjectPath(projectPath);
      releaseRuntimeForSessions(workspace.sessionIdsForDirectory(target));
      const state = workspace.closeDirectory(target);
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:forget', (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const target = validateProjectPath(projectPath);
      releaseRuntimeForSessions(workspace.sessionIdsForDirectory(target));
      const state = workspace.closeDirectory(target);
      workspaceStore.removeProject(target);
      agentRuntimeStore.remove(target);
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
      if (claudeRuntime?.isActive(validatedSessionId)) {
        workspace.write(validatedSessionId, `/rename ${normalizedTitle}\r`);
      }
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle(
    'project:open-stored-conversation',
    async (event, projectPath: unknown, conversationId: unknown): Promise<WorkspaceResult> => {
      validateSender(event);
      let sessionId: string | undefined;
      try {
        if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
          throw new Error('会话标识无效。');
        }
        const resolved = resolveDirectory(validateProjectPath(projectPath));
        const runtime = requireClaudeRuntime();
        if (agentRuntimeStore.get(resolved) !== 'claude') {
          throw new Error('这是 Claude Code 历史会话，请先将该项目切换为 Claude Code。');
        }

        // A stored conversation always gets its own terminal, so several can resume side by side.
        workspace.openConversation(resolved, `历史 ${conversationId.slice(0, 8)}`);
        sessionId = workspace.getState().activeSessionId;
        workspaceStore.addProject(resolved);

        const prepared = await runtime.prepareLaunchWithSession(
          sessionId,
          resolved,
          conversationId,
        );
        const terminalStatus = workspace.restart(sessionId, prepared.environment);
        if (terminalStatus.phase === 'error') {
          throw new Error(terminalStatus.message ?? '无法为 Claude Code 启动安全终端。');
        }
        workspace.write(sessionId, `${prepared.command}\r`);
        return { ok: true, state: describeWorkspace() };
      } catch (error) {
        if (sessionId) {
          requireClaudeRuntime().setInactive(sessionId);
        }
        return failedWorkspaceResult(error);
      }
    },
  );
  ipcMain.handle('terminal:start', (event, sessionId: unknown) => {
    validateSender(event);
    try {
      return operationFromStatus(workspace.start(validateSessionId(sessionId)));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : '无法启动终端。',
        ok: false,
        status: workspace.getActiveStatus(),
      } satisfies OperationResult;
    }
  });
  ipcMain.handle('terminal:restart', (event, sessionId: unknown) => {
    validateSender(event);
    try {
      const validatedSessionId = validateSessionId(sessionId);
      requireClaudeRuntime().setInactive(validatedSessionId);
      requireCodexRuntime().setInactive(validatedSessionId);
      return operationFromStatus(workspace.restart(validatedSessionId));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : '无法重启终端。',
        ok: false,
        status: workspace.getActiveStatus(),
      } satisfies OperationResult;
    }
  });
  ipcMain.handle('terminal:stop', (event, sessionId: unknown) => {
    validateSender(event);
    try {
      const validatedSessionId = validateSessionId(sessionId);
      requireClaudeRuntime().setInactive(validatedSessionId);
      requireCodexRuntime().setInactive(validatedSessionId);
      return operationFromStatus(workspace.stop(validatedSessionId));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : '无法停止终端。',
        ok: false,
        status: workspace.getActiveStatus(),
      } satisfies OperationResult;
    }
  });
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
      let restartAttempted = false;
      try {
        if (agentRuntimeStore.get(status.cwd) !== 'codex') {
          throw new Error('当前项目尚未选择 Codex 开发引擎。');
        }
        await assertOfficialProviderAllowed('openai-codex', 'cli-launch', status.cwd);
        const prepared = await runtime.prepareLaunch(
          validatedSessionId,
          status.cwd,
          validateCodexLaunchMode(mode),
        );
        restartAttempted = true;
        const terminalStatus = workspace.restart(validatedSessionId, prepared.environment);
        if (terminalStatus.phase === 'error') {
          throw new Error(terminalStatus.message ?? '无法为 Codex 启动安全终端。');
        }
        workspace.write(validatedSessionId, `${prepared.command}\r`);
        return {
          ok: true,
          state: await runtime.getState(validatedSessionId, status.cwd),
        };
      } catch (error) {
        if (restartAttempted) {
          runtime.setInactive(validatedSessionId);
        }
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
      return launchRouterInstaller();
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
      if (source === 'github') {
        return launchRouterInstaller();
      }
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-install',
          '正在安装 Claude Code Router',
          () =>
            requireClaudeRuntime().installRouterPackage(
              source as Exclude<ClaudeRouterInstallSource, 'github'>,
            ),
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
          '正在彻底卸载 Claude Code Router',
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
          message: '路由器网关已停止，管理服务仍可用于修改配置。',
          ok: routerState.gatewayState === 'stopped',
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
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-repair',
          '正在修复 Claude Code Router 配置',
          () => requireClaudeRuntime().repairRouterFromProject(validatedSessionId, status.cwd),
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
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-save-provider',
          '正在保存 Claude Code Router 服务提供方',
          () =>
            requireClaudeRuntime().saveRouterProvider(
              validatedSessionId,
              status.cwd,
              validateClaudeRouterProviderInput(input),
            ),
        );
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
      const rollback = new RollbackCoordinator();
      try {
        const validatedInput = validateClaudeConfigInput(input);
        if (validatedInput.provider === 'anthropic' && validatedInput.protocol !== 'openai') {
          await assertOfficialProviderAllowed('anthropic-claude', 'provider-switch', status.cwd);
        }
        const snapshot = runtime.createConfigSnapshot(status.cwd);
        rollback.add(() => runtime.restoreConfigSnapshot(status.cwd, snapshot));
        const state = await runtime.saveConnectionConfig(
          validatedSessionId,
          status.cwd,
          validatedInput,
        );
        rollback.commit();
        return {
          ok: true,
          state,
        };
      } catch (error) {
        await rollback.rollback();
        return {
          error: error instanceof Error ? error.message : '无法保存 Claude 接入配置。',
          ok: false,
          state: await runtime.getState(validatedSessionId, status.cwd),
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
      const rollback = new RollbackCoordinator();
      try {
        const validatedEntryId = validateHistoryEntryId(entryId);
        if (runtime.connectionHistoryUsesOfficialProvider(status.cwd, validatedEntryId)) {
          await assertOfficialProviderAllowed('anthropic-claude', 'provider-switch', status.cwd);
        }
        const snapshot = runtime.createConfigSnapshot(status.cwd);
        rollback.add(() => runtime.restoreConfigSnapshot(status.cwd, snapshot));
        const state = await runtime.applyConnectionHistory(
          validatedSessionId,
          status.cwd,
          validatedEntryId,
        );
        rollback.commit();
        return { entries: runtime.getConnectionHistory(status.cwd), ok: true, state };
      } catch (error) {
        await rollback.rollback();
        return {
          entries: runtime.getConnectionHistory(status.cwd),
          error: error instanceof Error ? error.message : '无法应用这条接入记录。',
          ok: false,
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
          state: await requireClaudeRuntime().switchModel(
            validatedSessionId,
            status.cwd,
            validateModelOptionId(optionId),
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
      const rollback = new RollbackCoordinator();
      let restartAttempted = false;
      try {
        const validatedInput = validateClaudeRelaunchInput(input);
        const targetUsesOfficialProvider =
          runtime.usesOfficialProvider(status.cwd) ||
          Boolean(
            validatedInput.entryId &&
            runtime.connectionHistoryUsesOfficialProvider(status.cwd, validatedInput.entryId),
          );
        if (targetUsesOfficialProvider) {
          await assertOfficialProviderAllowed('anthropic-claude', 'cli-launch', status.cwd);
        }
        const snapshot = runtime.createConfigSnapshot(status.cwd);
        rollback.add(() => runtime.restoreConfigSnapshot(status.cwd, snapshot));
        const prepared = await runtime.relaunch(validatedSessionId, status.cwd, validatedInput);
        restartAttempted = true;
        const terminalStatus = workspace.restart(validatedSessionId, prepared.environment);
        if (terminalStatus.phase === 'error') {
          throw new Error(terminalStatus.message ?? '无法为 Claude Code 启动安全终端。');
        }
        workspace.write(validatedSessionId, `${prepared.command}\r`);
        rollback.commit();
        return {
          ok: true,
          state: await runtime.getState(validatedSessionId, status.cwd),
        };
      } catch (error) {
        await rollback.rollback();
        if (restartAttempted) {
          runtime.setInactive(validatedSessionId);
        }
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
          state: await requireClaudeRuntime().setPermissionMode(
            validatedSessionId,
            status.cwd,
            validateClaudePermissionMode(mode),
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
          state: await requireClaudeRuntime().setEffort(
            validatedSessionId,
            status.cwd,
            validateClaudeEffortRequest(effort),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.on('claude:permission-mode-observed', (event, sessionId: unknown, mode: unknown) => {
    validateSender(event);
    try {
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      requireClaudeRuntime().observePermissionModeFromScreen(
        validatedSessionId,
        status.cwd,
        validateClaudePermissionMode(mode),
      );
    } catch {
      // A queued xterm write can finish immediately after its project or Claude session is closed.
    }
  });
  ipcMain.on(
    'claude:permission-mode-probe-result',
    (event, sessionId: unknown, probeId: unknown, mode: unknown) => {
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
      try {
        validateSessionId(sessionId);
        validatedMode = mode === undefined ? undefined : validateClaudePermissionMode(mode);
      } catch {
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
      try {
        if (typeof allowed !== 'boolean') {
          throw new Error('放权开关的取值无效。');
        }
        return {
          ok: true,
          state: await requireClaudeRuntime().setAllowBypassPermissions(
            validatedSessionId,
            status.cwd,
            allowed,
          ),
        };
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
        if (validatedInput.provider === 'anthropic' && validatedInput.protocol !== 'openai') {
          await assertOfficialProviderAllowed('anthropic-claude', 'first-request', status.cwd);
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
      let restartAttempted = false;
      try {
        if (agentRuntimeStore.get(status.cwd) !== 'claude') {
          throw new Error('当前项目尚未选择 Claude Code 开发引擎。');
        }
        if (runtime.usesOfficialProvider(status.cwd)) {
          await assertOfficialProviderAllowed('anthropic-claude', 'cli-launch', status.cwd);
        }
        const prepared = await runtime.prepareLaunch(
          validatedSessionId,
          status.cwd,
          validateClaudeLaunchMode(mode),
        );
        restartAttempted = true;
        const terminalStatus = workspace.restart(validatedSessionId, prepared.environment);
        if (terminalStatus.phase === 'error') {
          throw new Error(terminalStatus.message ?? '无法为 Claude Code 启动安全终端。');
        }
        workspace.write(validatedSessionId, `${prepared.command}\r`);
        return {
          ok: true,
          state: await runtime.getState(validatedSessionId, status.cwd),
        };
      } catch (error) {
        if (restartAttempted) {
          runtime.setInactive(validatedSessionId);
        }
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
          state: await runtime.runCommand(
            validatedSessionId,
            status.cwd,
            `${command}${normalizedArgument ? ` ${normalizedArgument}` : ''}`,
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
    if (confirmed !== true) {
      return;
    }
    isQuitting = true;
    app.quit();
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
  ipcMain.on('terminal:write', (event, sessionId: unknown, data: unknown) => {
    validateSender(event);
    if (typeof data !== 'string' || data.length > 65_536) {
      return;
    }
    try {
      workspace.write(validateSessionId(sessionId), data);
    } catch {
      // A stale renderer event can arrive immediately after a project is closed.
    }
  });
  ipcMain.on('terminal:resize', (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    validateSender(event);
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      return;
    }
    try {
      const validatedSessionId = validateSessionId(sessionId);
      const applied = workspace.resize(validatedSessionId, cols, rows);
      /*
       * Echo back the size the PTY actually took. PSReadLine repaints with absolute cursor moves,
       * so xterm disagreeing with ConPTY by even one row makes that repaint overwrite the wrong
       * line and leaves the previous screen visible underneath.
       */
      mainWindow?.webContents.send('terminal:size', validatedSessionId, applied.cols, applied.rows);
    } catch {
      // A ResizeObserver callback can race with project closure.
    }
  });
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
    return sessionManager.getSessionsForProject(status.cwd);
  });
  ipcMain.handle('claude:get-sessions-for-path', async (event, projectPath: unknown) => {
    validateSender(event);
    return sessionManager.getSessionsForProject(validateProjectPath(projectPath));
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
    async (event, projectPath: unknown, conversationId: unknown) => {
      validateSender(event);
      if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
        throw new Error('会话标识无效。');
      }
      return sessionManager.deleteSession(validateProjectPath(projectPath), conversationId);
    },
  );
  ipcMain.handle(
    'claude:launch-with-session',
    async (event, sessionId: unknown, conversationId: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      let restartAttempted = false;
      try {
        if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
          throw new Error('会话标识无效。');
        }
        if (runtime.usesOfficialProvider(status.cwd)) {
          await assertOfficialProviderAllowed('anthropic-claude', 'cli-launch', status.cwd);
        }
        const prepared = await runtime.prepareLaunchWithSession(
          validatedSessionId,
          status.cwd,
          conversationId,
        );
        restartAttempted = true;
        const terminalStatus = workspace.restart(validatedSessionId, prepared.environment);
        if (terminalStatus.phase === 'error') {
          throw new Error(terminalStatus.message ?? '无法为 Claude Code 启动安全终端。');
        }
        workspace.write(validatedSessionId, `${prepared.command}\r`);
        return {
          ok: true,
          state: await runtime.getState(validatedSessionId, status.cwd),
        };
      } catch (error) {
        if (restartAttempted) {
          runtime.setInactive(validatedSessionId);
        }
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
        const release = busyRegistry?.acquire({
          cancellable: false,
          id: `plugin:${channel}:${identity}`,
          kind:
            channel.includes('uninstall') || channel.includes('remove') ? 'uninstall' : 'install',
          label: channel.includes('uninstall')
            ? '正在卸载 Claude Code 插件'
            : '正在修改 Claude Code 插件',
          severity: 'blocking',
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
    async (event, source: unknown): Promise<SoftwareUpdateOperationResult> => {
      validateSender(event);
      const runtime = requireClaudeRuntime();
      if (
        typeof source !== 'string' ||
        !claudeInstallSources.has(source as ClaudeCodeInstallSource)
      ) {
        const message = 'Claude Code 安装源无效。';
        return {
          error: message,
          message,
          ok: false,
          state: await runtime.getSoftwareUpdates(),
        };
      }
      try {
        const result = await runtime.installOrUpdateClaudeCode(source as ClaudeCodeInstallSource);
        return { message: result.message, ok: true, state: result.state };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法安装或更新 Claude Code。';
        return {
          error: message,
          message,
          ok: false,
          state: await runtime.getSoftwareUpdates(true),
        };
      }
    },
  );
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

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // A duplicate launch has nothing to protect and no window to ask through: leave immediately.
  isQuitting = true;
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId('cn.cheng.claudedock');
    artifactService.install();
    busyRegistry = new BusyRegistry((leases) => {
      mainWindow?.webContents.send('busy:changed', leases);
      updateTray();
    });
    mcpManager = new McpManager(homedir(), app.getPath('userData'), busyRegistry);
    downloadEngine = new DownloadEngine(
      session.defaultSession as unknown as DownloadSession,
      busyRegistry,
      app.getPath('userData'),
      (tasks) => {
        mainWindow?.webContents.send('download:changed', tasks);
      },
    );
    downloadEngine.install();
    downloadEngine.restoreInterrupted();
    ccSwitchAdapter = new CcSwitchAdapter(
      app.getPath('userData'),
      downloadEngine,
      busyRegistry,
      (url) => shell.openExternal(url),
    );
    proxyStore = new ProxyStore(app.getPath('userData'), safeStorage);
    xraySidecar = new XraySidecar({
      busyRegistry,
      downloadEngine,
      /*
       * Route probes travel the app session, so they inherit whatever `applyApplicationProxyScope`
       * has in force — including the user's bootstrap proxy. A route that probes green is therefore
       * a route the download can actually use, rather than one that merely exists.
       */
      fetchImpl: (url, init) => session.defaultSession.fetch(url, init),
      mirrorHosts: () => proxyStore?.getView().scope.extraCoreSources ?? [],
      onChange: (view) => {
        mainWindow?.webContents.send('proxy:runtime-changed', view);
        if (proxyLeakAuditService) {
          mainWindow?.webContents.send('proxy:state-changed', proxyControlView());
        }
        void applyApplicationProxyScope();
      },
      userDataPath: app.getPath('userData'),
    });
    /*
     * Record the resting rules before anything can start the tunnel. Without this the cached
     * signature is the empty string, so the first `setView({ status: 'starting' })` looked like a
     * change and fired a real `setProxy` + `closeAllConnections()` — landing milliseconds after
     * `downloadURL()` opened the socket for the Xray-core bootstrap and killing it at 0 bytes. A
     * starting sidecar resolves to the same `{ mode: 'system' }` as a stopped one, so once the
     * signature is primed the whole startup path is a no-op until the tunnel is genuinely ready.
     */
    await applyApplicationProxyScope();
    const directAuditSession = session.fromPartition('claudedock-proxy-audit-direct');
    const proxiedAuditSession = session.fromPartition('claudedock-proxy-audit-tunnel');
    await directAuditSession.setProxy({ mode: 'direct' });
    proxyLeakAuditService = new LeakAuditService({
      auditStore: new LeakAuditStore(app.getPath('userData')),
      directFetch: (url, init) => directAuditSession.fetch(url, init),
      onReport: (record) => {
        if (record.report.summary === 'risk' && !record.acceptedAt) {
          mainWindow?.webContents.send('proxy:audit-required', record);
        }
      },
      proxiedFetch: (proxyUrl) => async (url, init) => {
        await proxiedAuditSession.setProxy({
          mode: 'fixed_servers',
          proxyBypassRules: '127.0.0.1,localhost,[::1]',
          proxyRules: proxyUrl,
        });
        await proxiedAuditSession.closeAllConnections();
        return proxiedAuditSession.fetch(url, init);
      },
      webRtcAudit: auditWebRtc,
    });
    workspace.setEnvironmentProvider(() =>
      proxyStore && xraySidecar
        ? buildCliProxyEnvironment(xraySidecar.getView(), proxyStore.getView().scope)
        : {},
    );
    claudeRuntime = new ClaudeRuntime(
      app.getPath('userData'),
      runtimeAssetPath('claude-statusline.ps1'),
      runtimeAssetPath('claude-runtime-signal.ps1'),
      runtimeAssetPath('claude-web-search-guard.ps1'),
      () => advancedSettingsStore.get().webResearchIsolation,
      (state) => {
        const claudeTitle = state.metrics?.sessionName;
        if (claudeTitle && workspace.hasSession(state.sessionId)) {
          try {
            workspace.syncClaudeSessionTitle(state.sessionId, claudeTitle);
          } catch {
            // Ignore malformed or oversized names from a future Claude Code status-line schema.
          }
        }
        mainWindow?.webContents.send('claude:state', state);
      },
      (sessionId, data) => {
        workspace.write(sessionId, data);
      },
      requestPermissionModeFromScreen,
      downloadEngine,
      workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME,
    );
    codexRuntime = new CodexRuntime(
      app.getPath('userData'),
      (state) => {
        mainWindow?.webContents.send('codex:state', state);
      },
      downloadEngine,
      busyRegistry,
    );
    const networkPreflightSettingsStore = new NetworkPreflightSettingsStore(
      app.getPath('userData'),
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
          proxyStore && xraySidecar
            ? buildCliProxyEnvironment(xraySidecar.getView(), proxyStore.getView().scope)
            : {},
        resolveProxy: (url) => session.defaultSession.resolveProxy(url),
        builtInProxyUrl: () => xraySidecar?.getView().httpProxyUrl,
      }),
      settingsStore: networkPreflightSettingsStore,
    });
    providerAccessGuard = new ProviderAccessGuard(networkPreflightService);
    registerIpc();
    createTray();

    // Remembered folders are listed without a terminal each — otherwise every folder ever opened
    // would spawn a PowerShell at startup. Only the folder in use last time is reopened live.
    const lastActive = workspaceStore.getLastActiveProject();
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

    /*
     * If the tunnel was up when ClaudeDock last went away — tray quit, Alt+F4, a crash — bring it
     * back on its own. It runs after the window exists so the panel shows 启动中 and the failure
     * message, and it is deliberately not awaited: a slow core download must not block startup.
     */
    if (proxyStore?.getView().state.autoStart) {
      void startBuiltInProxy().catch(() => undefined);
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
  for (const buffer of outputBuffers.values()) {
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }
  }
  outputBuffers.clear();
  for (const pending of pendingPermissionModeProbes.values()) {
    clearTimeout(pending.timer);
    pending.resolve(undefined);
  }
  pendingPermissionModeProbes.clear();
  chatService.shutdown();
  void xraySidecar?.stop();
  claudeRuntime?.shutdown();
  codexRuntime?.dispose();
  workspace.shutdown();
});
