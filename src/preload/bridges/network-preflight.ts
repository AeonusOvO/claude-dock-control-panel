import { ipcRenderer } from 'electron';
import type { ControlPanelApi } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const networkPreflightBridge = {
  getNetworkPreflight: (provider) => ipcRenderer.invoke(CHANNELS.NETWORK_PREFLIGHT_GET, provider),
  runNetworkPreflight: (input) => ipcRenderer.invoke(CHANNELS.NETWORK_PREFLIGHT_RUN, input),
  invalidateNetworkPreflight: (reason) =>
    ipcRenderer.invoke(CHANNELS.NETWORK_PREFLIGHT_INVALIDATE, reason),
  getNetworkPreflightHistory: () => ipcRenderer.invoke(CHANNELS.NETWORK_PREFLIGHT_GET_HISTORY),
  clearNetworkPreflightHistory: () => ipcRenderer.invoke(CHANNELS.NETWORK_PREFLIGHT_CLEAR_HISTORY),
  onNetworkPreflight: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      result: Parameters<typeof listener>[0],
    ): void => {
      listener(result);
    };
    ipcRenderer.on(CHANNELS.NETWORK_PREFLIGHT_RESULT, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.NETWORK_PREFLIGHT_RESULT, callback);
    };
  },
} satisfies Partial<ControlPanelApi>;
