import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ClaudeConfigResult,
  ClaudeConnectionTestResult,
  ClaudeGatewayDiagnostics,
  ClaudeOperationResult,
  ClaudeProjectState,
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
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
  getClaudeProjectState: (sessionId: string) =>
    ipcRenderer.invoke('claude:get-state', sessionId) as Promise<ClaudeProjectState>,
  getClaudeGatewayDiagnostics: (sessionId: string) =>
    ipcRenderer.invoke(
      'claude:get-gateway-diagnostics',
      sessionId,
    ) as Promise<ClaudeGatewayDiagnostics>,
  getClaudeRouterManagementState: (sessionId: string) =>
    ipcRenderer.invoke(
      'claude:router-get-state',
      sessionId,
    ) as Promise<ClaudeRouterManagementState>,
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  getWorkspace: () => ipcRenderer.invoke('workspace:get-state') as Promise<WorkspaceState>,
  deleteClaudeRouterProvider: (sessionId, providerId) =>
    ipcRenderer.invoke(
      'claude:router-delete-provider',
      sessionId,
      providerId,
    ) as Promise<ClaudeRouterOperationResult>,
  installClaudeRouter: (sessionId) =>
    ipcRenderer.invoke('claude:router-install', sessionId) as Promise<ClaudeRouterOperationResult>,
  launchClaude: (sessionId, mode) =>
    ipcRenderer.invoke('claude:launch', sessionId, mode) as Promise<ClaudeOperationResult>,
  onClaudeState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: ClaudeProjectState): void => {
      listener(state);
    };
    ipcRenderer.on('claude:state', callback);
    return () => {
      ipcRenderer.removeListener('claude:state', callback);
    };
  },
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
  runClaudeCommand: (sessionId, command, argument) =>
    ipcRenderer.invoke(
      'claude:command',
      sessionId,
      command,
      argument,
    ) as Promise<ClaudeOperationResult>,
  saveClaudeConfig: (sessionId, input) =>
    ipcRenderer.invoke('claude:save-config', sessionId, input) as Promise<ClaudeConfigResult>,
  saveClaudeRouterProvider: (sessionId, input) =>
    ipcRenderer.invoke(
      'claude:router-save-provider',
      sessionId,
      input,
    ) as Promise<ClaudeRouterOperationResult>,
  startClaudeRouter: (sessionId) =>
    ipcRenderer.invoke('claude:router-start', sessionId) as Promise<ClaudeRouterOperationResult>,
  stopClaudeRouter: (sessionId) =>
    ipcRenderer.invoke('claude:router-stop', sessionId) as Promise<ClaudeRouterOperationResult>,
  openClaudeRouterManagement: (sessionId) =>
    ipcRenderer.invoke(
      'claude:router-open-management',
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  testClaudeConnection: (sessionId, input) =>
    ipcRenderer.invoke(
      'claude:test-connection',
      sessionId,
      input,
    ) as Promise<ClaudeConnectionTestResult>,
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url) as Promise<boolean>,
  startTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:start', sessionId) as Promise<OperationResult>,
  stopTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:stop', sessionId) as Promise<OperationResult>,
  writeTerminal: (sessionId, data) => {
    ipcRenderer.send('terminal:write', sessionId, data);
  },
};

contextBridge.exposeInMainWorld('controlPanel', api);
