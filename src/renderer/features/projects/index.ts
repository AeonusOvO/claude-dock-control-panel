import type {
  ConversationResumePreferences,
  ClaudeSessionMetadata,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';
import { createRegistryToken, type Registry } from '../../platform/registry';
import {
  createProjectsActions,
  type ProjectsActionsDependencies,
  type RenameDialogCopy,
} from './actions';
import { createProjectsElements } from './elements';
import {
  createProjectsRows,
  type ProjectsRowHandlers,
  type ProjectsRowsDependencies,
} from './rows';
import { createProjectsState } from './state';
import { createProjectsTitleView, type ProjectsViewDependencies } from './view';
import { createWorkspaceRenderer, type WorkspaceRendererDependencies } from './workspace';

export type ProjectsFeatureDependencies = ProjectsActionsDependencies &
  ProjectsRowsDependencies &
  ProjectsViewDependencies &
  WorkspaceRendererDependencies;

export interface ProjectsFeature {
  addProject: (directoryPath: string) => Promise<void>;
  conversationContextMenu: HTMLElement;
  displayedConversationTitle: (status: TerminalStatus) => string;
  expandFolder: (folder: string) => void;
  getStoredConversations: (folder: string) => ClaudeSessionMetadata[] | undefined;
  hideConversationContextMenu: () => void;
  isTitleAnimating: (sessionId: string) => boolean;
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
  openDirectoryPicker: () => Promise<void>;
  reconcileWorkspaceAfterActivation: () => Promise<void>;
  renderWorkspace: (state: WorkspaceState) => void;
  requestConversationTitle: (currentTitle: string, historical: boolean) => Promise<string | null>;
  requestRenamedValue: (currentValue: string, copy: RenameDialogCopy) => Promise<string | null>;
  restoreLastConversationOnStartup: (
    preferences: ConversationResumePreferences,
  ) => Promise<boolean>;
}

export const PROJECTS_FEATURE = createRegistryToken<ProjectsFeature>('renderer.feature.projects');

const createProjectsFeature = (dependencies: ProjectsFeatureDependencies): ProjectsFeature => {
  const elements = createProjectsElements();
  const state = createProjectsState();
  const titleView = createProjectsTitleView(state, elements, dependencies);

  const workspaceRenderer = createWorkspaceRenderer(
    state,
    dependencies,
    () => rows.renderProjectList(),
    titleView,
  );

  const actions = createProjectsActions(elements, state, dependencies, workspaceRenderer, {
    loadFolderHistory: (projectPath, force) => rows.loadFolderHistory(projectPath, force),
  });

  const handlers: ProjectsRowHandlers = {
    activateProject: (sessionId) => actions.activateProject(sessionId),
    closeProject: (status) => actions.closeProject(status),
    closeProjectFolder: (project) => actions.closeProjectFolder(project),
    deleteStoredConversation: (projectPath, session) =>
      actions.deleteStoredConversation(projectPath, session),
    forgetProject: (project) => actions.forgetProject(project),
    loadFolderHistory: (projectPath, force) => rows.loadFolderHistory(projectPath, force),
    openConversation: (projectPath) => actions.openConversation(projectPath),
    renameConversation: (status) => actions.renameConversation(status),
    resumeStoredConversation: (projectPath, session) =>
      actions.resumeStoredConversation(projectPath, session),
    showConversationContextMenu: (event, target) =>
      actions.showConversationContextMenu(event, target),
  };

  const restoreLastConversationOnStartup = async (
    preferences: ConversationResumePreferences,
  ): Promise<boolean> => {
    if (!preferences.autoLoadLastConversationOnStartup) {
      return false;
    }
    try {
      const project = [...dependencies.getWorkspaceState().projects]
        .filter((candidate) => !candidate.missing)
        .sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0))[0];
      if (!project) {
        return false;
      }
      const session = (await window.controlPanel.getClaudeSessionsForPath(project.path))[0];
      if (!session) {
        return false;
      }
      await actions.resumeStoredConversation(project.path, session, {
        autoLoadConversationModel: preferences.autoLoadLastConversationModelOnStartup,
        source: 'startup',
      });
      return true;
    } catch {
      dependencies.showToast('无法自动恢复上次对话，请从历史列表手动重试。', 'error');
      return false;
    }
  };

  const rows = createProjectsRows(state, elements, dependencies, handlers, titleView);

  return {
    addProject: actions.addProject,
    conversationContextMenu: elements.conversationContextMenu,
    displayedConversationTitle: titleView.displayedConversationTitle,
    expandFolder: actions.expandFolder,
    getStoredConversations: actions.getStoredConversations,
    hideConversationContextMenu: actions.hideConversationContextMenu,
    isTitleAnimating: titleView.isTitleAnimating,
    loadFolderHistory: (projectPath, force) => rows.loadFolderHistory(projectPath, force),
    openDirectoryPicker: actions.openDirectoryPicker,
    reconcileWorkspaceAfterActivation: workspaceRenderer.reconcileWorkspaceAfterActivation,
    renderWorkspace: workspaceRenderer.renderWorkspace,
    requestConversationTitle: actions.requestConversationTitle,
    requestRenamedValue: actions.requestRenamedValue,
    restoreLastConversationOnStartup,
  };
};

export const registerProjectsFeature = (
  registry: Registry,
  dependencies: ProjectsFeatureDependencies,
): void => {
  registry.register(PROJECTS_FEATURE, () => createProjectsFeature(dependencies));
};
