import { ipcRenderer } from 'electron';
import type {
  ControlPanelApi,
  DirectoryChoiceResult,
  WorkspaceProject,
  WorkspaceResult,
  WorkspaceState,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const workspaceBridge = {
  activateProject: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.PROJECT_ACTIVATE, sessionId) as Promise<WorkspaceResult>,
  addProject: (directoryPath: string) =>
    ipcRenderer.invoke(CHANNELS.PROJECT_ADD, directoryPath) as Promise<WorkspaceResult>,
  chooseDirectory: () =>
    ipcRenderer.invoke(CHANNELS.DIRECTORY_CHOOSE) as Promise<DirectoryChoiceResult>,
  closeProject: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.PROJECT_CLOSE, sessionId) as Promise<WorkspaceResult>,
  closeProjectFolder: (projectPath: string) =>
    ipcRenderer.invoke(CHANNELS.PROJECT_CLOSE_FOLDER, projectPath) as Promise<WorkspaceResult>,
  openConversation: (projectPath: string) =>
    ipcRenderer.invoke(CHANNELS.PROJECT_OPEN_CONVERSATION, projectPath) as Promise<WorkspaceResult>,
  openStoredConversation: (projectPath: string, conversationId: string) =>
    ipcRenderer.invoke(
      CHANNELS.PROJECT_OPEN_STORED_CONVERSATION,
      projectPath,
      conversationId,
    ) as Promise<WorkspaceResult>,
  renameConversation: (sessionId: string, title: string) =>
    ipcRenderer.invoke(
      CHANNELS.PROJECT_RENAME_CONVERSATION,
      sessionId,
      title,
    ) as Promise<WorkspaceResult>,
  forgetProject: (projectPath: string) =>
    ipcRenderer.invoke(CHANNELS.PROJECT_FORGET, projectPath) as Promise<WorkspaceResult>,
  getWorkspace: () => ipcRenderer.invoke(CHANNELS.WORKSPACE_GET_STATE) as Promise<WorkspaceState>,
  getDevelopmentRuntime: (sessionId) => ipcRenderer.invoke(CHANNELS.RUNTIME_GET, sessionId),
  setDevelopmentRuntime: (sessionId, runtime) =>
    ipcRenderer.invoke(CHANNELS.RUNTIME_SET, sessionId, runtime),
  onWorkspaceState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: WorkspaceState): void => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.WORKSPACE_STATE, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.WORKSPACE_STATE, callback);
    };
  },
  getStoredProjects: () =>
    ipcRenderer.invoke(CHANNELS.WORKSPACE_GET_STORED_PROJECTS) as Promise<WorkspaceProject[]>,
  removeStoredProject: (projectPath) =>
    ipcRenderer.invoke(CHANNELS.WORKSPACE_REMOVE_STORED_PROJECT, projectPath) as Promise<void>,
} satisfies Partial<ControlPanelApi>;
