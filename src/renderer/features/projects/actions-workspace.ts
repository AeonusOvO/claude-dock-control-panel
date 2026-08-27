import type {
  TerminalStatus,
  WorkspaceProjectView,
  WorkspaceResult,
  WorkspaceState,
} from '../../../shared/contracts';
import type { ProjectsActionsDependencies, ProjectsRowsApi } from './actions-dependencies';
import type { ConversationTransitionQueueState } from './conversation-transition-queue';
import type { ProjectsElements } from './elements';
import type { PendingConversation, ProjectsState } from './state';
import type { WorkspaceRenderer } from './workspace';
import { beginWorkspaceConversationTransition } from './transition-busy';

export interface ProjectsWorkspaceActions {
  activateProject: (sessionId: string) => Promise<void>;
  addProject: (directoryPath: string) => Promise<void>;
  closeProject: (status: TerminalStatus) => Promise<void>;
  closeProjectFolder: (project: WorkspaceProjectView) => Promise<void>;
  forgetProject: (project: WorkspaceProjectView) => Promise<void>;
  openConversation: (projectPath: string) => Promise<void>;
  openDirectoryPicker: () => Promise<void>;
}

const beginOptimisticConversation = (
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
  rowsApi: ProjectsRowsApi,
  projectPath: string,
  title: string,
): {
  finish: (render?: boolean) => void;
  pending: PendingConversation;
  setCancel: (cancel: () => boolean) => void;
  updateQueueState: (queueState: ConversationTransitionQueueState) => void;
} => {
  const id = `pending-conversation-${++state.pendingConversationSequence}`;
  const pending: PendingConversation = {
    id,
    kind: 'creating',
    phase: 'queued',
    projectPath,
    title,
  };
  state.pendingConversations.set(id, pending);
  state.expandedFolders.add(projectPath.toLowerCase());
  rowsApi.renderProjectList();
  const releasePreview = dependencies.beginWorkspaceTerminalPreview('正在新建会话…');
  let finished = false;
  return {
    finish: (render = true) => {
      if (finished) return;
      finished = true;
      state.pendingConversations.delete(id);
      releasePreview();
      if (render) rowsApi.renderProjectList();
    },
    pending,
    setCancel: (cancel) => {
      pending.cancel = cancel;
      rowsApi.renderProjectList();
    },
    updateQueueState: (queueState) => {
      if (finished) return;
      pending.phase = queueState.phase === 'queued' ? 'queued' : 'starting';
      pending.queuePosition = queueState.phase === 'queued' ? queueState.position : undefined;
      pending.queueTotal = queueState.phase === 'queued' ? queueState.total : undefined;
      rowsApi.renderProjectList();
    },
  };
};

interface LaunchCreatedConversationInput {
  dependencies: ProjectsActionsDependencies;
  onSettled?: () => void;
  projectPath: string;
  result: WorkspaceResult;
  rowsApi: ProjectsRowsApi;
  state: ProjectsState;
  workspaceRenderer: WorkspaceRenderer;
}

const launchCreatedConversation = async ({
  dependencies,
  onSettled = () => undefined,
  projectPath,
  result,
  rowsApi,
  state,
  workspaceRenderer,
}: LaunchCreatedConversationInput): Promise<boolean> => {
  if (!result.createdSessionId || !result.runtime) return false;
  const { createdSessionId, runtime } = result;
  state.transitioningConversations.set(createdSessionId, 'creating');
  rowsApi.renderProjectList();
  const releaseMask = dependencies.beginTerminalMask(createdSessionId, '正在新建会话…');
  const rollback = async (reason: string): Promise<void> => {
    try {
      const rolledBack = await window.controlPanel.closeProject(createdSessionId);
      workspaceRenderer.renderWorkspace(rolledBack.state);
      if (!rolledBack.ok) {
        throw new Error(dependencies.resultFailureMessage(rolledBack, '自动回滚没有完成。'));
      }
      state.failedConversationTransitions.delete(createdSessionId);
      dependencies.showToast(`${reason} 已撤销本次新建，对话列表已恢复。`, 'error');
    } catch (error) {
      state.failedConversationTransitions.set(createdSessionId, 'creating');
      rowsApi.renderProjectList();
      dependencies.showToast(
        `${reason} 自动回滚未完成，临时终端仍保留，请手动关闭。${
          error instanceof Error && error.message ? ` ${error.message}` : ''
        }`,
        'error',
      );
    }
  };
  try {
    const started = await dependencies.launchCreatedConversation(createdSessionId, runtime);
    if (started) {
      state.failedConversationTransitions.delete(createdSessionId);
      dependencies.showToast(
        `已在 ${dependencies.projectNameFromPath(projectPath)} 新建 ${
          runtime === 'codex' ? 'Codex' : 'Claude Code'
        } 对话`,
      );
    } else {
      await rollback(runtime === 'codex' ? 'Codex 对话准备失败。' : 'Claude Code 对话启动失败。');
    }
  } catch (error) {
    await rollback(error instanceof Error ? `${error.message}。` : '新对话启动失败。');
  } finally {
    state.transitioningConversations.delete(createdSessionId);
    releaseMask();
    rowsApi.renderProjectList();
    onSettled();
  }
  return true;
};

const requestActiveTerminalFocus = (
  dependencies: ProjectsActionsDependencies,
  workspace: WorkspaceState,
): void => {
  const status = workspace.sessions.find((candidate) => candidate.id === workspace.activeSessionId);
  if (!status || (status.phase !== 'running' && status.phase !== 'starting')) return;
  dependencies.retryTerminalFitUntilMeasured();
  dependencies.requestComposerFocus(status.id);
};

const closeProjectFolderWithDependencies = async (
  project: WorkspaceProjectView,
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
  workspaceRenderer: WorkspaceRenderer,
  rowsApi: ProjectsRowsApi,
): Promise<void> => {
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
  for (const sessionId of project.sessionIds) {
    state.failedConversationTransitions.delete(sessionId);
  }
  state.expandedFolders.add(project.path.toLowerCase());
  await rowsApi.loadFolderHistory(project.path, true);
  dependencies.showToast(`已关闭 ${project.name}，对话已归档到历史记录`);
};

const handleAddedProjectResult = (
  result: WorkspaceResult,
  projectPath: string,
  dependencies: ProjectsActionsDependencies,
  workspaceRenderer: WorkspaceRenderer,
): boolean => {
  workspaceRenderer.renderWorkspace(result.state);
  if (!result.ok) {
    dependencies.showToast(
      dependencies.resultFailureMessage(result, '添加项目失败，请重试。'),
      'error',
    );
    return false;
  }
  const name = dependencies.projectNameFromPath(projectPath);
  dependencies.showToast(result.reused ? `${name} 已经打开，已切换到该项目` : `已添加 ${name}`);
  return true;
};

interface OpenConversationInput {
  dependencies: ProjectsActionsDependencies;
  projectPath: string;
  rowsApi: ProjectsRowsApi;
  state: ProjectsState;
  workspaceRenderer: WorkspaceRenderer;
}

/** Queues one independently owned conversation and retains its continuation across navigation. */
const openConversationWithDependencies = async ({
  dependencies,
  projectPath,
  rowsApi,
  state,
  workspaceRenderer,
}: OpenConversationInput): Promise<void> => {
  const releaseTransition = beginWorkspaceConversationTransition(state);
  const optimistic = beginOptimisticConversation(
    state,
    dependencies,
    rowsApi,
    projectPath,
    '新对话',
  );
  const ticket = state.conversationTransitionQueue.enqueue(async () => {
    let result: WorkspaceResult;
    try {
      result = await window.controlPanel.openConversation(projectPath);
    } catch (error) {
      optimistic.finish();
      releaseTransition();
      dependencies.showToast(error instanceof Error ? error.message : '无法新建对话。', 'error');
      return;
    }
    optimistic.finish(false);
    workspaceRenderer.renderWorkspace(result.state);
    if (!result.ok) {
      releaseTransition();
      dependencies.showToast(dependencies.resultFailureMessage(result, '无法新建对话。'), 'error');
      return;
    }

    if (
      !(await launchCreatedConversation({
        dependencies,
        onSettled: releaseTransition,
        projectPath,
        result,
        rowsApi,
        state,
        workspaceRenderer,
      }))
    ) {
      releaseTransition();
      dependencies.showToast('新对话已打开，但没有取得对应的后台启动标识。', 'error');
    }
    requestActiveTerminalFocus(dependencies, result.state);
  }, optimistic.updateQueueState);
  optimistic.setCancel(ticket.cancel);
  try {
    const outcome = await ticket.result;
    if (outcome.status === 'cancelled') {
      optimistic.finish();
      releaseTransition();
      dependencies.showToast('已取消排队中的新建对话');
    }
  } catch (error) {
    optimistic.finish();
    releaseTransition();
    dependencies.showToast(error instanceof Error ? error.message : '无法新建对话。', 'error');
  }
};

export const createProjectsWorkspaceActions = (
  elements: ProjectsElements,
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
  workspaceRenderer: WorkspaceRenderer,
  rowsApi: ProjectsRowsApi,
): ProjectsWorkspaceActions => {
  /**
   * Runs `task` unless the same target already has a call in flight.
   *
   * The rows these actions are bound to are recreated by every workspace re-render, so the button
   * the user pressed is gone — and replaced by an enabled one — long before the request resolves.
   * Guarding on the target is what actually holds. Mirrors `storedConversationRestores` in
   * `actions-history.ts`.
   */
  const runOnce = async (key: string, task: () => Promise<void>): Promise<void> => {
    if (state.workspaceMutations.has(key)) {
      return;
    }
    state.workspaceMutations.add(key);
    try {
      await task();
    } finally {
      state.workspaceMutations.delete(key);
    }
  };

  const activateProject = async (sessionId: string): Promise<void> => {
    const result = await window.controlPanel.activateProject(sessionId);
    if (!result.ok) {
      dependencies.showToast(dependencies.resultFailureMessage(result, '无法切换对话。'), 'error');
      return;
    }
    workspaceRenderer.renderWorkspace(result.state);
    requestActiveTerminalFocus(dependencies, result.state);
  };

  /**
   * Closing a running conversation is an archive, not a deletion: the terminal process stops, and the
   * conversation itself stays on disk under 历史对话. The folder is expanded and its history re-read
   * afterwards so the row visibly lands there instead of appearing to vanish.
   */
  const closeProject = async (status: TerminalStatus): Promise<void> =>
    runOnce(`close:${status.id}`, async () => {
      const transitionFailure = state.failedConversationTransitions.get(status.id);
      if (
        !transitionFailure &&
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
      state.failedConversationTransitions.delete(status.id);
      state.expandedFolders.add(projectPath.toLowerCase());
      await rowsApi.loadFolderHistory(projectPath, true);
      dependencies.showToast(
        transitionFailure
          ? `已移除“${status.title}”的失败临时会话`
          : `已关闭“${status.title}”，可在历史对话中恢复`,
      );
    });

  /**
   * Every click owns a distinct main-process session. There is intentionally no folder-level
   * debounce: ten clicks create ten terminal owners, and each engine launch continues even when a
   * later click makes another tab active.
   */
  const openConversation = (projectPath: string): Promise<void> =>
    openConversationWithDependencies({
      dependencies,
      projectPath,
      rowsApi,
      state,
      workspaceRenderer,
    });

  const closeProjectFolder = (project: WorkspaceProjectView): Promise<void> =>
    closeProjectFolderWithDependencies(project, state, dependencies, workspaceRenderer, rowsApi);

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

  const addProject = async (directoryPath: string): Promise<void> => {
    elements.dropZone.disabled = true;
    elements.chooseDirectoryButton.disabled = true;
    elements.dropZone.classList.add('drop-zone--busy');

    try {
      const result = await window.controlPanel.addProject(directoryPath);
      if (handleAddedProjectResult(result, directoryPath, dependencies, workspaceRenderer)) {
        if (!result.reused) {
          const releaseTransition = beginWorkspaceConversationTransition(state);
          if (
            !(await launchCreatedConversation({
              dependencies,
              onSettled: releaseTransition,
              projectPath: directoryPath,
              result,
              rowsApi,
              state,
              workspaceRenderer,
            }))
          ) {
            releaseTransition();
          }
        }
        requestActiveTerminalFocus(dependencies, result.state);
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
