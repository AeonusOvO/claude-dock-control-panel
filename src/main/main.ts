import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  DirectoryChoiceResult,
  OperationResult,
  TerminalStatus,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';
import { resolveDirectory } from './directory';
import { TerminalWorkspace } from './terminal-workspace';

app.enableSandbox();

let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let minimizedNoticeShown = false;
let tray: Tray | null = null;

const assetPath = (fileName: string): string =>
  path.join(app.getAppPath(), 'assets', 'generated', fileName);

const workspace = new TerminalWorkspace(
  homedir(),
  (sessionId, data) => {
    mainWindow?.webContents.send('terminal:data', sessionId, data);
  },
  (state) => {
    mainWindow?.webContents.send('workspace:state', state);
    updateTray(state);
  },
);

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
    return {
      ok: true,
      reused: result.reused,
      state: result.state,
    };
  } catch (error) {
    return failedWorkspaceResult(error);
  }
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
      workspace.activate(status.id);
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
        state: workspace.activate(validateSessionId(sessionId)),
      } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle('project:close', (event, sessionId: unknown) => {
    validateSender(event);
    try {
      return {
        ok: true,
        state: workspace.close(validateSessionId(sessionId)),
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
      return operationFromStatus(workspace.restart(validateSessionId(sessionId)));
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
      return operationFromStatus(workspace.stop(validateSessionId(sessionId)));
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
    registerIpc();
    createTray();
    await createWindow();
  });
}

app.on('activate', showMainWindow);
app.on('before-quit', () => {
  isQuitting = true;
  workspace.shutdown();
});
