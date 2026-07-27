import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ClaudeConfigResult,
  ClaudeConnectionTestResult,
  ClaudeConnectionHistoryResult,
  ClaudeCodeInstallSource,
  ClaudeLaunchMode,
  ClaudeOperationResult,
  ClaudePluginCatalog,
  ClaudePluginOperationResult,
  ClaudeRouterOperationResult,
  ClaudeRouterInstallSource,
  SoftwareUpdateOperationResult,
  DirectoryChoiceResult,
  OperationResult,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
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
import {
  ClaudePluginManager,
  isValidMarketplaceName,
  isValidMarketplaceSource,
  isValidPluginId,
} from './claude-plugin-manager';
import { ClaudeRuntime } from './claude-runtime';
import {
  ClaudeSessionManager,
  isValidClaudeSessionId,
  normalizeClaudeSessionTitle,
} from './claude-session-manager';
import { resolveDirectory } from './directory';
import { directoryDialogDefaultPath, directoryDialogError } from './directory-picker';
import { sameDirectory, TerminalWorkspace } from './terminal-workspace';
import { WorkspaceStore } from './workspace-store';
app.enableSandbox();

let isQuitting = false;
let claudeRuntime: ClaudeRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let minimizedNoticeShown = false;
let tray: Tray | null = null;

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
    const filtered = claudeRuntime?.consumeTerminalOutput(sessionId, data) ?? data;
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
const sessionManager = new ClaudeSessionManager();
const pluginManager = new ClaudePluginManager(homedir());

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

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
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

/** Drops every runtime session bound to a folder so its Claude state does not leak into a reopen. */
const releaseRuntimeForSessions = (sessionIds: string[]): void => {
  for (const sessionId of sessionIds) {
    claudeRuntime?.closeSession(sessionId);
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
  if (!activeStatus) {
    return;
  }

  const runningCount = state.sessions.filter((session) => session.phase === 'running').length;
  const openProjects = state.projects.filter((project) => project.open);
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
  tray.setToolTip(
    `ClaudeDock · ${openProjects.length} 个项目 · ${runningCount}/${state.sessions.length} 个对话运行中\n${activeStatus.cwd}`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        enabled: false,
        label: `项目：${openProjects.length} 个 · 对话：${state.sessions.length} 个 · 运行中：${runningCount} 个`,
      },
      {
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
      {
        click: () => {
          workspace.restart(activeStatus.id);
        },
        label: `重启 ${sessionLabel(activeStatus)}`,
      },
      {
        click: () => {
          if (activeStatus.phase === 'running') {
            workspace.stop(activeStatus.id);
          } else {
            workspace.start(activeStatus.id);
          }
        },
        label: activeStatus.phase === 'running' ? '停止当前终端' : '启动当前终端',
      },
      { type: 'separator' },
      {
        click: () => {
          isQuitting = true;
          app.quit();
        },
        label: '退出 ClaudeDock',
      },
    ]),
  );
}

const validateSender = (event: IpcMainEvent | IpcMainInvokeEvent): void => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
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

const validateClaudeLaunchMode = (mode: unknown): ClaudeLaunchMode => {
  if (mode !== 'new' && mode !== 'continue' && mode !== 'resume') {
    throw new Error('Claude 会话启动方式无效。');
  }
  return mode;
};

const validateClaudeConfigInput = (input: unknown): SaveClaudeConfigInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('Claude 接入配置格式无效。');
  }
  const value = input as Record<string, unknown>;
  if (
    (value.provider !== 'anthropic' && value.provider !== 'gateway') ||
    (value.preset !== 'anthropic' &&
      value.preset !== 'custom' &&
      value.preset !== 'deepseek' &&
      value.preset !== 'gateway') ||
    (value.authMode !== 'apiKey' &&
      value.authMode !== 'authToken' &&
      value.authMode !== 'existing' &&
      value.authMode !== 'none') ||
    (value.credentialAction !== 'clear' &&
      value.credentialAction !== 'keep' &&
      value.credentialAction !== 'replace') ||
    typeof value.baseUrl !== 'string' ||
    typeof value.model !== 'string' ||
    (value.credential !== undefined && typeof value.credential !== 'string')
  ) {
    throw new Error('Claude 接入配置包含无效字段。');
  }

  return {
    authMode: value.authMode,
    baseUrl: value.baseUrl,
    credential: value.credential,
    credentialAction: value.credentialAction,
    model: value.model,
    preset: value.preset,
    provider: value.provider,
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
    (value.credentialAction !== 'keep' && value.credentialAction !== 'replace') ||
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
  ipcMain.handle('workspace:get-state', (event) => {
    validateSender(event);
    return describeWorkspace();
  });
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
        const result = await requireClaudeRuntime().installRouterPackage(
          source as Exclude<ClaudeRouterInstallSource, 'github'>,
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
        const result = await requireClaudeRuntime().uninstallRouter();
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
        const result = await requireClaudeRuntime().repairRouterFromProject(
          validatedSessionId,
          status.cwd,
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
        const result = await requireClaudeRuntime().saveRouterProvider(
          validatedSessionId,
          status.cwd,
          validateClaudeRouterProviderInput(input),
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
          routerState: await requireClaudeRuntime().deleteRouterProvider(providerId),
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
      try {
        return {
          ok: true,
          state: await requireClaudeRuntime().saveConfig(
            validatedSessionId,
            status.cwd,
            validateClaudeConfigInput(input),
          ),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : '无法保存 Claude 接入配置。',
          ok: false,
          state: await requireClaudeRuntime().getState(validatedSessionId, status.cwd),
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
        const state = await runtime.applyConnectionHistory(
          validatedSessionId,
          status.cwd,
          validateHistoryEntryId(entryId),
        );
        return { entries: runtime.getConnectionHistory(status.cwd), ok: true, state };
      } catch (error) {
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
    'claude:test-connection',
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeConnectionTestResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        return await requireClaudeRuntime().testConnection(
          status.cwd,
          validateClaudeConfigInput(input),
        );
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
        const prepared = await runtime.prepareLaunch(
          validatedSessionId,
          status.cwd,
          validateClaudeLaunchMode(mode),
        );
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
        runtime.setInactive(validatedSessionId);
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
        workspace.write(
          validatedSessionId,
          `${command}${normalizedArgument ? ` ${normalizedArgument}` : ''}\r`,
        );
        const status = workspace.getStatus(validatedSessionId);
        return {
          ok: true,
          state: await runtime.getState(validatedSessionId, status.cwd),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
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
      if (applied.cols !== cols || applied.rows !== rows) {
        mainWindow?.webContents.send(
          'terminal:size',
          validatedSessionId,
          applied.cols,
          applied.rows,
        );
      }
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
    async (event, sessionId: unknown, conversationId: unknown) => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
        throw new Error('会话标识无效。');
      }
      const status = workspace.getStatus(validatedSessionId);
      return sessionManager.deleteSession(status.cwd, conversationId);
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
        if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
          throw new Error('会话标识无效。');
        }
        const prepared = await runtime.prepareLaunchWithSession(
          validatedSessionId,
          status.cwd,
          conversationId,
        );
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
        runtime.setInactive(validatedSessionId);
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
      return runPluginMutation(() => run(argument, flag));
    });
  }
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
    mainWindow?.hide();

    if (!minimizedNoticeShown && tray) {
      minimizedNoticeShown = true;
      tray.displayBalloon({
        content: '所有项目终端仍在后台运行，可从托盘恢复窗口。',
        iconType: 'info',
        title: 'ClaudeDock 已进入后台',
      });
    }
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
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(async () => {
    app.setAppUserModelId('cn.cheng.claudedock');
    claudeRuntime = new ClaudeRuntime(
      app.getPath('userData'),
      runtimeAssetPath('claude-statusline.ps1'),
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
    );
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
  });
}

app.on('activate', showMainWindow);
app.on('before-quit', () => {
  isQuitting = true;
  for (const buffer of outputBuffers.values()) {
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }
  }
  outputBuffers.clear();
  claudeRuntime?.shutdown();
  workspace.shutdown();
});
