import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DirectoryChoiceResult, OperationResult, TerminalStatus } from '../shared/contracts';
import { resolveDirectory } from './directory';
import { TerminalSession } from './terminal-session';

app.enableSandbox();

let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let minimizedNoticeShown = false;
let tray: Tray | null = null;

const assetPath = (fileName: string): string =>
  path.join(app.getAppPath(), 'assets', 'generated', fileName);

const terminal = new TerminalSession(
  homedir(),
  (data) => {
    mainWindow?.webContents.send('terminal:data', data);
  },
  (status) => {
    mainWindow?.webContents.send('terminal:status', status);
    updateTray(status);
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

const trayIconForStatus = (status: TerminalStatus): string => {
  if (status.phase === 'running') {
    return assetPath('tray-running.png');
  }
  if (status.phase === 'error') {
    return assetPath('tray-error.png');
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
    buttonLabel: '定位到此项目',
    defaultPath: terminal.getStatus().cwd,
    properties: ['openDirectory'],
    title: '选择项目文件夹',
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

const switchDirectory = (directoryPath: string): OperationResult => {
  try {
    const resolved = resolveDirectory(directoryPath);
    return operationFromStatus(terminal.restart(resolved));
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : '无法切换到该文件夹。',
      ok: false,
      status: terminal.getStatus(),
    };
  }
};

const pickDirectoryFromTray = async (): Promise<void> => {
  try {
    const choice = await chooseDirectory();
    if (!choice.canceled) {
      switchDirectory(choice.path);
      showMainWindow();
    }
  } catch (error) {
    await dialog.showMessageBox({
      message: error instanceof Error ? error.message : '无法打开该文件夹。',
      title: '目录定位失败',
      type: 'error',
    });
  }
};

function updateTray(status = terminal.getStatus()): void {
  if (!tray) {
    return;
  }

  const icon = nativeImage.createFromPath(trayIconForStatus(status));
  tray.setImage(icon);
  tray.setToolTip(`ClaudeDock · ${statusText(status)}\n${status.cwd}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        enabled: false,
        label: `状态：${statusText(status)}`,
      },
      {
        enabled: false,
        label: `目录：${status.cwd}`,
      },
      { type: 'separator' },
      {
        click: showMainWindow,
        label: '显示控制面板',
      },
      {
        click: () => {
          void pickDirectoryFromTray();
        },
        label: '切换项目文件夹…',
      },
      { type: 'separator' },
      {
        click: () => {
          terminal.restart();
        },
        label: '重启 PowerShell',
      },
      {
        click: () => {
          if (terminal.getStatus().phase === 'running') {
            terminal.stop();
          } else {
            terminal.start();
          }
        },
        label: status.phase === 'running' ? '停止 PowerShell' : '启动 PowerShell',
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

const registerIpc = (): void => {
  ipcMain.handle('terminal:get-status', (event) => {
    validateSender(event);
    return terminal.getStatus();
  });
  ipcMain.handle('terminal:start', (event, cwd?: unknown) => {
    validateSender(event);
    try {
      const resolved = typeof cwd === 'string' ? resolveDirectory(cwd) : terminal.getStatus().cwd;
      return operationFromStatus(terminal.start(resolved));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : '无法启动 PowerShell。',
        ok: false,
        status: terminal.getStatus(),
      } satisfies OperationResult;
    }
  });
  ipcMain.handle('terminal:restart', (event, cwd?: unknown) => {
    validateSender(event);
    try {
      const resolved = typeof cwd === 'string' ? resolveDirectory(cwd) : terminal.getStatus().cwd;
      return operationFromStatus(terminal.restart(resolved));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : '无法重启 PowerShell。',
        ok: false,
        status: terminal.getStatus(),
      } satisfies OperationResult;
    }
  });
  ipcMain.handle('terminal:stop', (event) => {
    validateSender(event);
    return operationFromStatus(terminal.stop());
  });
  ipcMain.handle('directory:choose', async (event) => {
    validateSender(event);
    return chooseDirectory();
  });
  ipcMain.handle('directory:change', (event, directoryPath: unknown) => {
    validateSender(event);
    if (typeof directoryPath !== 'string') {
      return {
        error: '文件夹路径格式无效。',
        ok: false,
        status: terminal.getStatus(),
      } satisfies OperationResult;
    }
    return switchDirectory(directoryPath);
  });
  ipcMain.on('terminal:write', (event, data: unknown) => {
    validateSender(event);
    if (typeof data === 'string' && data.length <= 65_536) {
      terminal.write(data);
    }
  });
  ipcMain.on('terminal:resize', (event, cols: unknown, rows: unknown) => {
    validateSender(event);
    if (typeof cols === 'number' && typeof rows === 'number') {
      terminal.resize(cols, rows);
    }
  });
};

const createTray = (): void => {
  tray = new Tray(nativeImage.createFromPath(trayIconForStatus(terminal.getStatus())));
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
        content: '终端会话仍在后台运行，可从托盘恢复窗口。',
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
  terminal.stop(false);
});
