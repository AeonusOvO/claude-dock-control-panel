import { ipcRenderer } from 'electron';
import type { ControlPanelApi, DownloadTaskView } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const downloadBridge = {
  cancelDownload: (taskId) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_CANCEL, taskId),
  clearDownloadHistory: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_HISTORY_CLEAR),
  deleteDownloadHistory: (taskId) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_HISTORY_DELETE, taskId),
  listDownloads: () => ipcRenderer.invoke(CHANNELS.DOWNLOAD_LIST) as Promise<DownloadTaskView[]>,
  onDownloadsChanged: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, tasks: DownloadTaskView[]): void => {
      listener(tasks);
    };
    ipcRenderer.on(CHANNELS.DOWNLOAD_CHANGED, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.DOWNLOAD_CHANGED, callback);
    };
  },
  pauseDownload: (taskId) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_PAUSE, taskId),
  resumeDownload: (taskId) => ipcRenderer.invoke(CHANNELS.DOWNLOAD_RESUME, taskId),
} satisfies Partial<ControlPanelApi>;
