import { ipcRenderer } from 'electron';
import type { ControlPanelApi, ArtifactNetworkLogEntry } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const artifactBridge = {
  createArtifact: (html) => ipcRenderer.invoke(CHANNELS.ARTIFACT_CREATE, html),
  destroyArtifact: (artifactId) => ipcRenderer.invoke(CHANNELS.ARTIFACT_DESTROY, artifactId),
  getArtifactNetworkState: () => ipcRenderer.invoke(CHANNELS.ARTIFACT_GET_NETWORK_STATE),
  setArtifactNetworkAllowed: (allowed) =>
    ipcRenderer.invoke(CHANNELS.ARTIFACT_SET_NETWORK_ALLOWED, allowed),
  onArtifactNetworkLog: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, entry: ArtifactNetworkLogEntry): void => {
      listener(entry);
    };
    ipcRenderer.on(CHANNELS.ARTIFACT_NETWORK_LOG, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.ARTIFACT_NETWORK_LOG, callback);
    };
  },
} satisfies Partial<ControlPanelApi>;
