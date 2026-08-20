import type {
  ClaudeSessionMetadata,
  TerminalStatus,
  WorkspaceProjectView,
} from '../../../shared/contracts';
import { createProjectsContextMenuActions } from './actions-context-menu';
import { createProjectsHistoryActions } from './actions-history';
import { createProjectsRenameActions } from './actions-rename';
import { createProjectsWorkspaceActions } from './actions-workspace';
import type { ProjectsElements } from './elements';
import type { ConversationContextTarget, ProjectsState } from './state';
import type { WorkspaceRenderer } from './workspace';

export type {
  ProjectsActionsDependencies,
  ProjectsRowsApi,
  RenameDialogCopy,
} from './actions-dependencies';
import type {
  ProjectsActionsDependencies,
  ProjectsRowsApi,
  RenameDialogCopy,
} from './actions-dependencies';

export interface ProjectsActions {
  activateProject: (sessionId: string) => Promise<void>;
  addProject: (directoryPath: string) => Promise<void>;
  closeProject: (status: TerminalStatus) => Promise<void>;
  closeProjectFolder: (project: WorkspaceProjectView) => Promise<void>;
  deleteStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
  expandFolder: (folder: string) => void;
  forgetProject: (project: WorkspaceProjectView) => Promise<void>;
  getStoredConversations: (folder: string) => ClaudeSessionMetadata[] | undefined;
  hideConversationContextMenu: () => void;
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
  openConversation: (projectPath: string) => Promise<void>;
  openDirectoryPicker: () => Promise<void>;
  renameConversation: (status: TerminalStatus) => Promise<void>;
  renameStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
  requestConversationTitle: (currentTitle: string, historical: boolean) => Promise<string | null>;
  requestRenamedValue: (currentValue: string, copy: RenameDialogCopy) => Promise<string | null>;
  resumeStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
  showConversationContextMenu: (
    event: MouseEvent,
    target: Exclude<ConversationContextTarget, undefined>,
  ) => void;
}

export const createProjectsActions = (
  elements: ProjectsElements,
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
  workspaceRenderer: WorkspaceRenderer,
  rowsApi: ProjectsRowsApi,
): ProjectsActions => {
  const renameActions = createProjectsRenameActions(
    elements,
    state,
    dependencies,
    workspaceRenderer,
  );
  const contextMenuActions = createProjectsContextMenuActions(elements, state, dependencies);
  const workspaceActions = createProjectsWorkspaceActions(
    elements,
    state,
    dependencies,
    workspaceRenderer,
    rowsApi,
  );
  const historyActions = createProjectsHistoryActions(
    state,
    dependencies,
    workspaceRenderer,
    rowsApi,
    renameActions.requestConversationTitle,
  );

  elements.chooseDirectoryButton.addEventListener('click', () => {
    void workspaceActions.openDirectoryPicker();
  });
  elements.conversationRenameCancel.addEventListener('click', () => {
    elements.conversationRenameDialog.close('cancel');
  });
  elements.conversationContextMenu
    .querySelector<HTMLButtonElement>('[data-conversation-context-action="rename"]')
    ?.addEventListener('click', () => {
      const target = state.conversationContextTarget;
      contextMenuActions.hideConversationContextMenu();
      if (!target) {
        return;
      }
      if (target.kind === 'running') {
        void renameActions.renameConversation(target.status);
        return;
      }
      void historyActions.renameStoredConversation(target.projectPath, target.session);
    });
  elements.conversationContextMenu
    .querySelector<HTMLButtonElement>('[data-conversation-context-action="delete"]')
    ?.addEventListener('click', () => {
      const target = state.conversationContextTarget;
      contextMenuActions.hideConversationContextMenu();
      if (target?.kind === 'history') {
        void historyActions.deleteStoredConversation(target.projectPath, target.session);
      }
    });

  return {
    activateProject: workspaceActions.activateProject,
    addProject: workspaceActions.addProject,
    closeProject: workspaceActions.closeProject,
    closeProjectFolder: workspaceActions.closeProjectFolder,
    deleteStoredConversation: historyActions.deleteStoredConversation,
    expandFolder: (folder: string) => state.expandedFolders.add(folder),
    forgetProject: workspaceActions.forgetProject,
    getStoredConversations: (folder: string) => state.storedConversations.get(folder),
    hideConversationContextMenu: contextMenuActions.hideConversationContextMenu,
    loadFolderHistory: (projectPath, force) => rowsApi.loadFolderHistory(projectPath, force),
    openConversation: workspaceActions.openConversation,
    openDirectoryPicker: workspaceActions.openDirectoryPicker,
    renameConversation: renameActions.renameConversation,
    renameStoredConversation: historyActions.renameStoredConversation,
    requestConversationTitle: renameActions.requestConversationTitle,
    requestRenamedValue: renameActions.requestRenamedValue,
    resumeStoredConversation: historyActions.resumeStoredConversation,
    showConversationContextMenu: contextMenuActions.showConversationContextMenu,
  };
};
