import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ControlPanelApi,
  DirectoryChoiceResult,
  OperationResult,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';

const api: ControlPanelApi = {
  activateProject: (sessionId: string) =>
    ipcRenderer.invoke('project:activate', sessionId) as Promise<WorkspaceResult>,
  addProject: (directoryPath: string) =>
    ipcRenderer.invoke('project:add', directoryPath) as Promise<WorkspaceResult>,
  chooseDirectory: () => ipcRenderer.invoke('directory:choose') as Promise<DirectoryChoiceResult>,
  closeProject: (sessionId: string) =>
    ipcRenderer.invoke('project:close', sessionId) as Promise<WorkspaceResult>,
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  getWorkspace: () => ipcRenderer.invoke('workspace:get-state') as Promise<WorkspaceState>,
  onTerminalData: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      sessionId: unknown,
      data: unknown,
    ): void => {
      if (typeof sessionId === 'string' && typeof data === 'string') {
        listener(sessionId, data);
      }
    };
    ipcRenderer.on('terminal:data', callback);
    return () => {
      ipcRenderer.removeListener('terminal:data', callback);
    };
  },
  onWorkspaceState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: WorkspaceState): void => {
      listener(state);
    };
    ipcRenderer.on('workspace:state', callback);
    return () => {
      ipcRenderer.removeListener('workspace:state', callback);
    };
  },
  resizeTerminal: (sessionId, cols, rows) => {
    ipcRenderer.send('terminal:resize', sessionId, cols, rows);
  },
  restartTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:restart', sessionId) as Promise<OperationResult>,
  startTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:start', sessionId) as Promise<OperationResult>,
  stopTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:stop', sessionId) as Promise<OperationResult>,
  writeTerminal: (sessionId, data) => {
    ipcRenderer.send('terminal:write', sessionId, data);
  },
};

contextBridge.exposeInMainWorld('controlPanel', api);
