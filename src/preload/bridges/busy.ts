import { ipcRenderer } from 'electron';
import type { ControlPanelApi, BusyLease } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const busyBridge = {
  listBusyLeases: () => ipcRenderer.invoke(CHANNELS.BUSY_LIST) as Promise<BusyLease[]>,
  onBusyChanged: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, leases: BusyLease[]): void => {
      listener(leases);
    };
    ipcRenderer.on(CHANNELS.BUSY_CHANGED, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.BUSY_CHANGED, callback);
    };
  },
  setConversationBusy: (busy) => ipcRenderer.invoke(CHANNELS.BUSY_SET_CONVERSATION, busy),
} satisfies Partial<ControlPanelApi>;
