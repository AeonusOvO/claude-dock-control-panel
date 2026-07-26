import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ClaudeConfigResult,
  ClaudeConnectionTestResult,
  ClaudeLaunchMode,
  ClaudeOperationResult,
  ClaudeRouterOperationResult,
  DirectoryChoiceResult,
  OperationResult,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
  TerminalStatus,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';
import { ClaudeRuntime } from './claude-runtime';
import { ClaudeSessionManager, isValidClaudeSessionId } from './claude-session-manager';
import { resolveDirectory } from './directory';
import { TerminalWorkspace } from './terminal-workspace';
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

const workspace = new TerminalWorkspace(
  homedir(),
  (sessionId, data) => {
    const filtered = claudeRuntime?.consumeTerminalOutput(sessionId, data) ?? data;
    if (filtered) {
      mainWindow?.webContents.send('terminal:data', sessionId, filtered);
    }
  },
  (state) => {
    mainWindow?.webContents.send('workspace:state', state);
    updateTray(state);
  },
);

const workspaceStore = new WorkspaceStore(app.getPath('userData'));
const sessionManager = new ClaudeSessionManager();

const statusText = (status: TerminalStatus): string => {
  switch (status.phase) {
    case 'starting':
      return 'PowerShell 启动中';
    case 'running':
      return 'PowerShell 运行中';
    case 'error':
      return 'PowerShell 出错';
    case 'stopped':
      return 'PowerShell 已停止';
  }
};

const projectName = (status: TerminalStatus): string => path.basename(status.cwd) || status.cwd;

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

const chooseDirectory = async (): Promise<DirectoryChoiceResult> => {
  const options: Electron.OpenDialogOptions = {
    buttonLabel: '添加此项目',
    defaultPath: workspace.getActiveStatus().cwd,
    properties: ['openDirectory'],
    title: '添加项目文件夹',
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }

  return {
    canceled: false,
    path: resolveDirectory(result.filePaths[0]),
  };
};

const operationFromStatus = (status: TerminalStatus): OperationResult => ({
  error: status.phase === 'error' ? status.message : undefined,
  ok: status.phase !== 'error',
  status,
});

const failedWorkspaceResult = (error: unknown): WorkspaceResult => ({
  error: error instanceof Error ? error.message : '项目操作失败。',
  ok: false,
  state: workspace.getState(),
});

const addProject = (directoryPath: string): WorkspaceResult => {
  try {
    const resolved = resolveDirectory(directoryPath);
    const result = workspace.openProject(resolved);

    // Save to persistent workspace
    workspaceStore.addProject(resolved);

    return {
      ok: true,
      reused: result.reused,
      state: result.state,
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
  return state;
};

const pickDirectoryFromTray = async (): Promise<void> => {
  try {
    const choice = await chooseDirectory();
    if (!choice.canceled) {
      addProject(choice.path);
      showMainWindow();
    }
  } catch (error) {
    await dialog.showMessageBox({
      message: error instanceof Error ? error.message : '无法打开该文件夹。',
      title: '添加项目失败',
      type: 'error',
    });
  }
};

function updateTray(state = workspace.getState()): void {
  if (!tray) {
    return;
  }

  const activeStatus =
    state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0];
  if (!activeStatus) {
    return;
  }

  const runningCount = state.sessions.filter((session) => session.phase === 'running').length;
  const projectMenu: MenuItemConstructorOptions[] = state.sessions.map((status) => ({
    checked: status.id === state.activeSessionId,
    click: () => {
      activateProject(status.id);
      showMainWindow();
    },
    label: `${projectName(status)} · ${statusText(status)}`,
    type: 'radio',
  }));

  const icon = nativeImage.createFromPath(trayIconForState(state));
  tray.setImage(icon);
  tray.setToolTip(
    `ClaudeDock · ${runningCount}/${state.sessions.length} 个项目运行中\n${activeStatus.cwd}`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        enabled: false,
        label: `项目：${state.sessions.length} 个 · 运行中：${runningCount} 个`,
      },
      {
        label: '切换项目',
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
        label: `重启 ${projectName(activeStatus)}`,
      },
      {
        click: () => {
          if (activeStatus.phase === 'running') {
            workspace.stop(activeStatus.id);
          } else {
            workspace.start(activeStatus.id);
          }
        },
        label: activeStatus.phase === 'running' ? '停止当前 PowerShell' : '启动当前 PowerShell',
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
    throw new Error('Router Provider 配置格式无效。');
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
    throw new Error('Router Provider 配置包含无效字段。');
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

const registerIpc = (): void => {
  ipcMain.handle('workspace:get-state', (event) => {
    validateSender(event);
    return workspace.getState();
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
      const status = workspace.getStatus(validatedSessionId);
      requireClaudeRuntime().closeSession(validatedSessionId);
      workspaceStore.removeProject(status.cwd);
      const state = workspace.close(validatedSessionId);
      const active = state.sessions.find((session) => session.id === state.activeSessionId);
      if (active) {
        workspaceStore.updateLastActive(active.cwd);
      }
      return {
        ok: true,
        state,
      } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('terminal:start', (event, sessionId: unknown) => {
    validateSender(event);
    try {
      return operationFromStatus(workspace.start(validateSessionId(sessionId)));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : '无法启动 PowerShell。',
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
        error: error instanceof Error ? error.message : '无法重启 PowerShell。',
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
        error: error instanceof Error ? error.message : '无法停止 PowerShell。',
        ok: false,
        status: workspace.getActiveStatus(),
      } satisfies OperationResult;
    }
  });
  ipcMain.handle('directory:choose', async (event) => {
    validateSender(event);
    return chooseDirectory();
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
            routerState.gatewayState === 'running' ? 'Router 网关已启动。' : routerState.message,
          ok: routerState.gatewayState === 'running',
          routerState,
        };
      } catch (error) {
        return routerFailure(error, '无法启动 Router。');
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
          message: 'Router 网关已停止，管理服务仍可用于修改配置。',
          ok: routerState.gatewayState === 'stopped',
          routerState,
        };
      } catch (error) {
        return routerFailure(error, '无法停止 Router。');
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
          message: `已用当前项目配置创建 Provider ${result.saved.provider.name}，启动 3456，并将当前项目安全切换到 Router。`,
          ok: true,
          projectState: result.projectState,
          provider: result.saved.provider,
          routerState: result.saved.state,
        };
      } catch (error) {
        return routerFailure(error, '无法用当前项目配置修复 Router。');
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
            ? `Provider ${result.saved.provider.name} 已保存，并已安全接入当前项目。`
            : `Provider ${result.saved.provider.name} 已保存。`,
          ok: true,
          projectState: result.projectState,
          provider: result.saved.provider,
          routerState: result.saved.state,
        };
      } catch (error) {
        return routerFailure(error, '无法保存 Router Provider。');
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
        return routerFailure(new Error('Provider 标识无效。'), '无法删除 Provider。');
      }
      try {
        return {
          message: 'Provider 已从 Router 删除。',
          ok: true,
          routerState: await requireClaudeRuntime().deleteRouterProvider(providerId),
        };
      } catch (error) {
        return routerFailure(error, '无法删除 Router Provider。');
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
      workspace.resize(validateSessionId(sessionId), cols, rows);
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
  ipcMain.handle('claude:get-sessions', async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return sessionManager.getSessionsForProject(status.cwd);
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
};

const createTray = (): void => {
  tray = new Tray(nativeImage.createFromPath(trayIconForState(workspace.getState())));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTray();
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#080c10',
    height: 760,
    icon: assetPath('app-icon-256.png'),
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: 'ClaudeDock 控制面板',
    titleBarOverlay: {
      color: '#0a0e13',
      height: 48,
      symbolColor: '#dce9f0',
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
        mainWindow?.webContents.send('claude:state', state);
      },
    );
    registerIpc();
    createTray();

    // Restore workspace projects from persistent storage
    const lastActive = workspaceStore.getLastActiveProject();
    const storedProjects = workspaceStore.getProjects();
    for (const project of storedProjects) {
      if (existsSync(project.path)) {
        try {
          workspace.openProject(project.path);
        } catch {
          // Skip projects that can't be opened
        }
      }
    }

    // If last active project exists, activate it
    if (lastActive && existsSync(lastActive)) {
      const state = workspace.getState();
      const session = state.sessions.find(
        (s) => path.resolve(s.cwd).toLowerCase() === path.resolve(lastActive).toLowerCase(),
      );
      if (session) {
        activateProject(session.id);
      }
    }

    await createWindow();
  });
}

app.on('activate', showMainWindow);
app.on('before-quit', () => {
  isQuitting = true;
  claudeRuntime?.shutdown();
  workspace.shutdown();
});
