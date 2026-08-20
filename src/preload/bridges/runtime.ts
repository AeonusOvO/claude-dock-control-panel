import { ipcRenderer } from 'electron';
import type { ControlPanelApi } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const runtimeBridge = {
  getRuntimeActivity: (sessionId) => ipcRenderer.invoke(CHANNELS.RUNTIME_GET_ACTIVITY, sessionId),
  onRuntimeActivityChanged: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof listener>[0],
    ): void => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.RUNTIME_ACTIVITY_CHANGED, callback);
    return () => ipcRenderer.removeListener(CHANNELS.RUNTIME_ACTIVITY_CHANGED, callback);
  },
  terminateRuntimeProcess: (sessionId, processKey) =>
    ipcRenderer.invoke(CHANNELS.RUNTIME_TERMINATE_PROCESS, sessionId, processKey),
} satisfies Partial<ControlPanelApi>;
