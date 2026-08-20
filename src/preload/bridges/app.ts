import { ipcRenderer, webUtils } from 'electron';
import type { ControlPanelApi, AppQuitRequest } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const appBridge = {
  getAppSettings: () => ipcRenderer.invoke(CHANNELS.APP_GET_SETTINGS),
  getDiagnostics: (query) => ipcRenderer.invoke(CHANNELS.APP_GET_DIAGNOSTICS, query),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke(CHANNELS.APP_SET_LAUNCH_AT_LOGIN, enabled),
  setFooterResourcePreference: (preference) =>
    ipcRenderer.invoke(CHANNELS.APP_SET_FOOTER_RESOURCE_PREFERENCE, preference),
  setManagedChatGptContextWindowMode: (mode) =>
    ipcRenderer.invoke(CHANNELS.APP_SET_MANAGED_CHATGPT_CONTEXT_WINDOW_MODE, mode),
  setClaudeContextWindowMode: (mode, customTokens) =>
    ipcRenderer.invoke(CHANNELS.APP_SET_CLAUDE_CONTEXT_WINDOW_MODE, mode, customTokens),
  setAdvancedSettings: (settings) =>
    ipcRenderer.invoke(CHANNELS.APP_SET_ADVANCED_SETTINGS, settings),
  setCloseBehavior: (behavior) => ipcRenderer.invoke(CHANNELS.APP_SET_CLOSE_BEHAVIOR, behavior),
  openMarkdownExternal: (url) => ipcRenderer.invoke(CHANNELS.MARKDOWN_OPEN_EXTERNAL, url),
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  onAppQuitRequested: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, request: AppQuitRequest): void => {
      ipcRenderer.send(CHANNELS.APP_QUIT_REQUEST_RECEIVED);
      listener(request);
    };
    ipcRenderer.on(CHANNELS.APP_QUIT_REQUESTED, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.APP_QUIT_REQUESTED, callback);
    };
  },
  confirmQuit: (confirmed) => {
    ipcRenderer.send(CHANNELS.APP_CONFIRM_QUIT, confirmed);
  },
  minimizeToTray: () => {
    ipcRenderer.send(CHANNELS.APP_MINIMIZE_TO_TRAY);
  },
  onOpenDownloadCenterRequested: (listener) => {
    const callback = (): void => {
      listener();
    };
    ipcRenderer.on(CHANNELS.APP_OPEN_DOWNLOAD_CENTER, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.APP_OPEN_DOWNLOAD_CENTER, callback);
    };
  },
  onAppWindowRestored: (listener) => {
    const callback = (): void => {
      listener();
    };
    ipcRenderer.on(CHANNELS.APP_WINDOW_RESTORED, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.APP_WINDOW_RESTORED, callback);
    };
  },
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.APP_OPEN_EXTERNAL, url) as Promise<boolean>,
  setAppTheme: (themeId) => ipcRenderer.invoke(CHANNELS.UI_SET_THEME, themeId) as Promise<void>,
  readClipboardText: () => ipcRenderer.invoke(CHANNELS.APP_CLIPBOARD_READ) as Promise<string>,
  writeClipboardText: (text) =>
    ipcRenderer.invoke(CHANNELS.APP_CLIPBOARD_WRITE, text) as Promise<boolean>,
} satisfies Partial<ControlPanelApi>;
