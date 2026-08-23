import { CHANNELS } from '../../shared/ipc/channels';
import { BrowserWindow } from 'electron';
import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../../shared/ui/terminal-themes';
import { mainLogger } from '../infra/logger';
import type { Registry } from '../infra/registry';
import {
  CLAUDE_PERMISSION_BRIDGE,
  DOWNLOAD_ENGINE,
  MAIN_WINDOW,
  TRAY,
} from '../infra/service-tokens';
import type { MainState } from '../ipc/context';
import type { AppPreferencesStore } from '../stores/app-preferences';
import type { WorkspaceStore } from '../stores/workspace';
import { assetPath, preloadScriptPath, rendererEntryPath } from './paths';

export interface WindowControllerDependencies {
  appPreferencesStore: AppPreferencesStore;
  invalidateLaunchPreflightDecisions: () => void;
  /* Injected rather than imported: the quit handshake needs the window, so the edge runs both ways. */
  requestQuit: () => void;
  services: Registry;
  state: MainState;
  workspaceStore: WorkspaceStore;
}

/** The window operations the rest of the process drives, and the only writers of `MAIN_WINDOW`. */
export interface WindowController {
  applyWindowTheme: (themeId: TerminalThemeId) => void;
  createWindow: () => Promise<void>;
  hideMainWindowToTray: () => void;
  showMainWindow: () => void;
}

export const createWindowController = ({
  appPreferencesStore,
  invalidateLaunchPreflightDecisions,
  requestQuit,
  services,
  state,
  workspaceStore,
}: WindowControllerDependencies): WindowController => {
  const showMainWindow = (): void => {
    const mainWindow = services.resolve(MAIN_WINDOW).current;
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
      mainWindow.webContents.send(CHANNELS.APP_WINDOW_RESTORED);
    }
  };

  const hideMainWindowToTray = (): void => {
    invalidateLaunchPreflightDecisions();
    services.resolve(MAIN_WINDOW).current?.hide();
    /*
     * Hiding to the tray must never surface as a crash dialog. The balloon and the "already told you"
     * flag are both conveniences, so a storage failure downgrades to a log line instead of an
     * uncaught exception in the main process.
     */
    try {
      const preferences = appPreferencesStore.get();
      if (!preferences.closeToTrayNoticeShown) {
        const tray = services.resolve(TRAY).current;
        if (tray) {
          tray.displayBalloon({
            content: 'ClaudeDock 已最小化到托盘，后台继续运行。可在 设置 → 通用 中修改关闭行为。',
            iconType: 'info',
            title: 'ClaudeDock 仍在后台运行',
          });
          appPreferencesStore.set({ closeToTrayNoticeShown: true });
        }
      }
    } catch (error) {
      mainLogger.error('tray', '记录托盘提示状态失败。', error, 'environment');
    }
  };

  /**
   * The native frame is drawn by Windows, not by CSS, so the theme has to be pushed into Electron as
   * well — otherwise the chosen colour stops at the document edge and the window keeps a dark ring.
   */
  const applyWindowTheme = (themeId: TerminalThemeId): void => {
    const { shell } = TERMINAL_THEMES[themeId];
    const mainWindow = services.resolve(MAIN_WINDOW).current;
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
    const mainWindowReference = services.resolve(MAIN_WINDOW);
    const mainWindow = new BrowserWindow({
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
        preload: preloadScriptPath(),
        sandbox: true,
      },
      width: 1180,
    });
    mainWindowReference.current = mainWindow;

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on(
      'did-start-navigation',
      (_event, _url, _isSameDocument, isMainFrame) => {
        if (isMainFrame) invalidateLaunchPreflightDecisions();
      },
    );
    mainWindow.webContents.once('destroyed', invalidateLaunchPreflightDecisions);
    mainWindow.webContents.on('render-process-gone', () => {
      const quitConfirmationWasPending = state.quitConfirmation?.owner === 'renderer';
      if (quitConfirmationWasPending) {
        if (state.quitConfirmationTimer) {
          clearTimeout(state.quitConfirmationTimer);
          state.quitConfirmationTimer = undefined;
        }
        state.quitConfirmation = undefined;
      }
      invalidateLaunchPreflightDecisions();
      services.resolve(CLAUDE_PERMISSION_BRIDGE).fallbackPending();
      if (quitConfirmationWasPending) {
        const retryQuit = setImmediate(requestQuit);
        retryQuit.unref();
      }
    });
    /*
     * The OS is logging out or shutting down. Windows gives an app very little time here and kills it
     * regardless, so this is the one quit that must not be questioned: latch the flag so the following
     * `before-quit` runs its teardown straight through instead of asking.
     */
    mainWindow.on('session-end', () => {
      invalidateLaunchPreflightDecisions();
      services.resolve(DOWNLOAD_ENGINE).flushJournal();
      if (state.quitConfirmationTimer) {
        clearTimeout(state.quitConfirmationTimer);
        state.quitConfirmationTimer = undefined;
      }
      state.isQuitting = true;
      state.quitConfirmation = undefined;
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url !== services.resolve(MAIN_WINDOW).current?.webContents.getURL()) {
        event.preventDefault();
      }
    });
    mainWindow.on('close', (event) => {
      invalidateLaunchPreflightDecisions();
      if (state.isQuitting) {
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
      invalidateLaunchPreflightDecisions();
      mainWindowReference.current = null;
    });
    mainWindow.once('ready-to-show', () => {
      showMainWindow();
    });

    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (developmentUrl) {
      await mainWindow.loadURL(developmentUrl);
    } else {
      await mainWindow.loadFile(rendererEntryPath());
    }
  };

  return { applyWindowTheme, createWindow, hideMainWindowToTray, showMainWindow };
};
