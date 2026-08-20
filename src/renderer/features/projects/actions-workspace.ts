import type {
  TerminalStatus,
  WorkspaceProjectView,
  WorkspaceResult,
} from '../../../shared/contracts';
import type { ProjectsActionsDependencies, ProjectsRowsApi } from './actions-dependencies';
import type { ProjectsElements } from './elements';
import type { ProjectsState } from './state';
import type { WorkspaceRenderer } from './workspace';

export interface ProjectsWorkspaceActions {
  activateProject: (sessionId: string) => Promise<void>;
  addProject: (directoryPath: string) => Promise<void>;
  closeProject: (status: TerminalStatus) => Promise<void>;
  closeProjectFolder: (project: WorkspaceProjectView) => Promise<void>;
  forgetProject: (project: WorkspaceProjectView) => Promise<void>;
  openConversation: (projectPath: string) => Promise<void>;
  openDirectoryPicker: () => Promise<void>;
}

export const createProjectsWorkspaceActions = (
  elements: ProjectsElements,
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
  workspaceRenderer: WorkspaceRenderer,
  rowsApi: ProjectsRowsApi,
): ProjectsWorkspaceActions => {
  const activateProject = async (sessionId: string): Promise<void> => {
    const result = await window.controlPanel.activateProject(sessionId);
    if (!result.ok) {
      dependencies.showToast(dependencies.resultFailureMessage(result, '无法切换对话。'), 'error');
      return;
    }
    workspaceRenderer.renderWorkspace(result.state);
    dependencies.retryTerminalFitUntilMeasured();
    dependencies.requestComposerFocus(result.state.activeSessionId);
  };

  /**
   * Closing a running conversation is an archive, not a deletion: the terminal process stops, and the
   * conversation itself stays on disk under 历史对话. The folder is expanded and its history re-read
   * afterwards so the row visibly lands there instead of appearing to vanish.
   */
  const closeProject = async (status: TerminalStatus): Promise<void> => {
    if (
      status.phase === 'running' &&
      !(await dependencies.requestConfirmation({
        confirmLabel: '关闭并归档',
        message: `“${status.title}”还在运行。关闭会先停止它的终端进程，对话本身会归档到“历史对话”，随时可以恢复。`,
        title: '关闭正在运行的对话',
        tone: 'default',
      }))
    ) {
      return;
    }

    const projectPath = status.cwd;
    const result = await window.controlPanel.closeProject(status.id);
    if (!result.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '无法关闭这个对话。'),
        'error',
      );
      return;
    }
    workspaceRenderer.renderWorkspace(result.state);
    state.expandedFolders.add(projectPath.toLowerCase());
    await rowsApi.loadFolderHistory(projectPath, true);
    dependencies.showToast(`已关闭“${status.title}”，可在历史对话中恢复`);
  };

  const openConversation = async (projectPath: string): Promise<void> => {
    const result = await window.controlPanel.openConversation(projectPath);
    workspaceRenderer.renderWorkspace(result.state);
    if (!result.ok) {
      dependencies.showToast(dependencies.resultFailureMessage(result, '无法新建对话。'), 'error');
      return;
    }
    dependencies.showToast(`已在 ${dependencies.projectNameFromPath(projectPath)} 新开一个对话`);
    dependencies.retryTerminalFitUntilMeasured();
    dependencies.requestComposerFocus(result.state.activeSessionId);
  };

  const closeProjectFolder = async (project: WorkspaceProjectView): Promise<void> => {
    if (
      project.sessionIds.length > 0 &&
      !(await dependencies.requestConfirmation({
        confirmLabel: '关闭并归档',
        message: `关闭“${project.name}”的全部 ${project.sessionIds.length} 个对话？终端会停止，对话会归档到“历史对话”。`,
        title: '关闭项目对话',
        tone: 'danger',
      }))
    ) {
      return;
    }
    const result = await window.controlPanel.closeProjectFolder(project.path);
    workspaceRenderer.renderWorkspace(result.state);
    if (!result.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '无法关闭这个项目。'),
        'error',
      );
      return;
    }
    state.expandedFolders.add(project.path.toLowerCase());
    await rowsApi.loadFolderHistory(project.path, true);
    dependencies.showToast(`已关闭 ${project.name}，对话已归档到历史记录`);
  };

  const forgetProject = async (project: WorkspaceProjectView): Promise<void> => {
    if (
      !(await dependencies.requestConfirmation({
        confirmLabel: '从列表移除',
        message: `把“${project.name}”从列表中移除？磁盘上的文件不会被删除。`,
        title: '移除项目',
        tone: 'danger',
      }))
    ) {
      return;
    }
    const result = await window.controlPanel.forgetProject(project.path);
    workspaceRenderer.renderWorkspace(result.state);
    if (!result.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '无法移除这个项目。'),
        'error',
      );
      return;
    }
    const key = project.path.toLowerCase();
    state.folderHistoryLoads.invalidate(key);
    state.storedConversations.delete(key);
    state.expandedFolders.delete(key);
    state.historyScrollPositions.delete(key);
    dependencies.showToast(`已从列表中移除 ${project.name}`);
  };

  const handleWorkspaceResult = (result: WorkspaceResult, projectPath: string): boolean => {
    workspaceRenderer.renderWorkspace(result.state);
    if (!result.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '添加项目失败，请重试。'),
        'error',
      );
      return false;
    }
    const name = dependencies.projectNameFromPath(projectPath);
    dependencies.showToast(
      result.reused ? `${name} 已经打开，已切换到该项目` : `已添加并启动 ${name}`,
    );
    return true;
  };

  const addProject = async (directoryPath: string): Promise<void> => {
    elements.dropZone.disabled = true;
    elements.chooseDirectoryButton.disabled = true;
    elements.dropZone.classList.add('drop-zone--busy');

    try {
      const result = await window.controlPanel.addProject(directoryPath);
      if (handleWorkspaceResult(result, directoryPath)) {
        dependencies.retryTerminalFitUntilMeasured();
        dependencies.requestComposerFocus(result.state.activeSessionId);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      dependencies.showToast(detail || '添加项目失败，请重试。', 'error');
    } finally {
      elements.dropZone.disabled = false;
      elements.chooseDirectoryButton.disabled = false;
      elements.dropZone.classList.remove('drop-zone--busy');
    }
  };

  const openDirectoryPicker = async (): Promise<void> => {
    try {
      const choice = await window.controlPanel.chooseDirectory();
      if (choice.canceled) {
        if (choice.error) {
          dependencies.showToast(choice.error, 'error');
        }
        return;
      }
      await addProject(choice.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      dependencies.showToast(detail || '无法调用系统文件夹选择器。', 'error');
    }
  };

  return {
    activateProject,
    addProject,
    closeProject,
    closeProjectFolder,
    forgetProject,
    openConversation,
    openDirectoryPicker,
  };
};
