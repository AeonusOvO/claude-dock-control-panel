import type {
  ClaudeSessionMetadata,
  TerminalStatus,
  WorkspaceProjectView,
} from '../../../shared/contracts';
import type { ProjectsElements } from './elements';
import { createProjectsRowFolderActions } from './rows-folder';
import { createProjectsRowItemsActions } from './rows-items';
import { createProjectsRowListActions } from './rows-list';
import type { ProjectsState } from './state';
import type { PendingConversation } from './state';
import type { ProjectsTitleView } from './view';

export type { ProjectsRowHandlers, ProjectsRowsDependencies } from './rows-dependencies';
import type { ProjectsRowHandlers, ProjectsRowsDependencies } from './rows-dependencies';

export interface ProjectsRows {
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
  renderConversationRow: (status: TerminalStatus) => HTMLElement;
  renderHistoryRow: (projectPath: string, session: ClaudeSessionMetadata) => HTMLElement;
  renderPendingConversationRow: (pending: PendingConversation) => HTMLElement;
  renderProjectFolder: (project: WorkspaceProjectView) => HTMLElement;
  renderProjectList: () => void;
}

export const createProjectsRows = (
  state: ProjectsState,
  elements: ProjectsElements,
  dependencies: ProjectsRowsDependencies,
  handlers: ProjectsRowHandlers,
  titleView: ProjectsTitleView,
): ProjectsRows => {
  const itemsActions = createProjectsRowItemsActions(state, dependencies, handlers, titleView);
  const folderActions = createProjectsRowFolderActions(
    state,
    dependencies,
    handlers,
    itemsActions,
    () => listActions.renderProjectList(),
  );
  const listActions = createProjectsRowListActions(state, elements, dependencies, (project) =>
    folderActions.renderProjectFolder(project),
  );

  return {
    loadFolderHistory: listActions.loadFolderHistory,
    renderConversationRow: itemsActions.renderConversationRow,
    renderHistoryRow: itemsActions.renderHistoryRow,
    renderPendingConversationRow: itemsActions.renderPendingConversationRow,
    renderProjectFolder: folderActions.renderProjectFolder,
    renderProjectList: listActions.renderProjectList,
  };
};
