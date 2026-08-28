import { ipcRenderer } from 'electron';
import type { ModelUsageApi, ModelUsageSnapshot } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const modelUsageBridge: ModelUsageApi = {
  getModelUsage: () => ipcRenderer.invoke(CHANNELS.MODEL_USAGE_GET),
  setModelUsageFloating: (visible) =>
    ipcRenderer.invoke(CHANNELS.MODEL_USAGE_SET_FLOATING, visible),
  onModelUsage: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, snapshot: ModelUsageSnapshot): void =>
      listener(snapshot);
    ipcRenderer.on(CHANNELS.MODEL_USAGE_CHANGED, callback);
    return () => ipcRenderer.removeListener(CHANNELS.MODEL_USAGE_CHANGED, callback);
  },
};
