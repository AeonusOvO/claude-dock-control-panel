import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ControlPanelApi,
  DirectoryChoiceResult,
  OperationResult,
  TerminalStatus,
} from '../shared/contracts';

const api: ControlPanelApi = {
  changeDirectory: (directoryPath: string) =>
    ipcRenderer.invoke('directory:change', directoryPath) as Promise<OperationResult>,
  chooseDirectory: () => ipcRenderer.invoke('directory:choose') as Promise<DirectoryChoiceResult>,
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  getStatus: () => ipcRenderer.invoke('terminal:get-status') as Promise<TerminalStatus>,
  onTerminalData: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      if (typeof data === 'string') {
        listener(data);
      }
    };
    ipcRenderer.on('terminal:data', callback);
    return () => {
      ipcRenderer.removeListener('terminal:data', callback);
    };
  },
  onTerminalStatus: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, status: TerminalStatus): void => {
      listener(status);
    };
    ipcRenderer.on('terminal:status', callback);
    return () => {
      ipcRenderer.removeListener('terminal:status', callback);
    };
  },
  resizeTerminal: (cols, rows) => {
    ipcRenderer.send('terminal:resize', cols, rows);
  },
  restartTerminal: (cwd) => ipcRenderer.invoke('terminal:restart', cwd) as Promise<OperationResult>,
  startTerminal: (cwd) => ipcRenderer.invoke('terminal:start', cwd) as Promise<OperationResult>,
  stopTerminal: () => ipcRenderer.invoke('terminal:stop') as Promise<OperationResult>,
  writeTerminal: (data) => {
    ipcRenderer.send('terminal:write', data);
  },
};

contextBridge.exposeInMainWorld('controlPanel', api);
