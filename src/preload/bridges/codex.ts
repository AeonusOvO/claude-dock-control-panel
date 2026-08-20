import { ipcRenderer } from 'electron';
import type { ControlPanelApi, CodexProjectState } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const codexBridge = {
  getCodexProjectState: (sessionId) =>
    ipcRenderer.invoke(CHANNELS.CODEX_GET_STATE, sessionId) as Promise<CodexProjectState>,
  installOrUpdateCodex: (sessionId) => ipcRenderer.invoke(CHANNELS.CODEX_INSTALL_UPDATE, sessionId),
  startCodexLogin: (sessionId, method) =>
    ipcRenderer.invoke(CHANNELS.CODEX_LOGIN_START, sessionId, method),
  cancelCodexLogin: (sessionId) => ipcRenderer.invoke(CHANNELS.CODEX_LOGIN_CANCEL, sessionId),
  logoutCodex: (sessionId) => ipcRenderer.invoke(CHANNELS.CODEX_LOGOUT, sessionId),
  launchCodex: (sessionId, mode) => ipcRenderer.invoke(CHANNELS.CODEX_LAUNCH, sessionId, mode),
  onCodexState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: CodexProjectState): void => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.CODEX_STATE, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.CODEX_STATE, callback);
    };
  },
} satisfies Partial<ControlPanelApi>;
