import { ipcRenderer } from 'electron';
import type { ControlPanelApi, ApplicationProxyState } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const applicationProxyBridge = {
  getApplicationProxyState: () => ipcRenderer.invoke(CHANNELS.APPLICATION_PROXY_GET),
  saveApplicationProxy: (input) => ipcRenderer.invoke(CHANNELS.APPLICATION_PROXY_SAVE, input),
  testApplicationProxy: () => ipcRenderer.invoke(CHANNELS.APPLICATION_PROXY_TEST),
  detectApplicationProxyCandidates: () => ipcRenderer.invoke(CHANNELS.APPLICATION_PROXY_DETECT),
  onApplicationProxyChanged: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: ApplicationProxyState): void => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.APPLICATION_PROXY_CHANGED, callback);
    return () => ipcRenderer.removeListener(CHANNELS.APPLICATION_PROXY_CHANGED, callback);
  },
} satisfies Partial<ControlPanelApi>;
