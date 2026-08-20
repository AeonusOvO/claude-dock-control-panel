import { ipcRenderer } from 'electron';
import type { ControlPanelApi } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const softwareUpdateBridge = {
  getSoftwareUpdates: (refresh) =>
    ipcRenderer.invoke(CHANNELS.SOFTWARE_UPDATES_GET, refresh ?? false),
  installOrUpdateClaudeCode: () => ipcRenderer.invoke(CHANNELS.SOFTWARE_CLAUDE_INSTALL_UPDATE),
  getApplicationUpdaterState: () => ipcRenderer.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET),
  downloadApplicationUpdate: () =>
    ipcRenderer.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD),
  installApplicationUpdate: () => ipcRenderer.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_INSTALL),
  onApplicationUpdaterChanged: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof listener>[0],
    ): void => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.SOFTWARE_APPLICATION_UPDATER_CHANGED, callback);
    return () =>
      ipcRenderer.removeListener(CHANNELS.SOFTWARE_APPLICATION_UPDATER_CHANGED, callback);
  },
} satisfies Partial<ControlPanelApi>;
