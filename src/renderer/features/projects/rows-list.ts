import type { WorkspaceProjectView } from '../../../shared/contracts';
import { EASE_OUT_CUBIC, prefersReducedMotion, SCROLL_DURATION_MS } from '../../platform/motion';
import type { ProjectsElements } from './elements';
import type { ProjectsRowsDependencies } from './rows-dependencies';
import type { ProjectsState } from './state';

export interface ProjectsRowListActions {
  loadFolderHistory: (projectPath: string, force?: boolean) => Promise<void>;
  renderProjectList: () => void;
}

export const createProjectsRowListActions = (
  state: ProjectsState,
  elements: ProjectsElements,
  dependencies: ProjectsRowsDependencies,
  renderProjectFolder: (project: WorkspaceProjectView) => HTMLElement,
): ProjectsRowListActions => {
  let hasRendered = false;
  let listAnimation: Animation | undefined;
  let animationTargetHeight = 0;
  const workspaceContainsProject = (projectKey: string): boolean =>
    dependencies
      .getWorkspaceState()
      .projects.some((project) => project.path.toLowerCase() === projectKey);

  /** Loads a folder's Claude conversation history without requiring a live terminal for it. */
  const loadFolderHistory = async (projectPath: string, force = false): Promise<void> => {
    const key = projectPath.toLowerCase();
    // A previous failure is remembered rather than cached as an empty history, so re-rendering the
    // project list must not turn it into an IPC retry storm; only an explicit retry forces a reread.
    if (!force && (state.storedConversations.has(key) || state.folderHistoryLoads.hasFailed(key))) {
      return;
    }
    const token = state.folderHistoryLoads.request(key, force);
    if (!token) {
      return;
    }

    try {
      const conversations = await window.controlPanel.getClaudeSessionsForPath(projectPath);
      if (!state.folderHistoryLoads.isCurrent(token) || !workspaceContainsProject(key)) {
        return;
      }
      state.storedConversations.set(key, conversations);
      state.folderHistoryLoads.markLoaded(key);
      renderProjectList();
    } catch {
      // Caching `[]` here would report a failed read as "this folder has no conversations" and, via
      // the short-circuit above, make that permanent. Record it as a retryable failure instead.
      if (state.folderHistoryLoads.isCurrent(token) && workspaceContainsProject(key)) {
        state.folderHistoryLoads.markFailed(key);
        renderProjectList();
      }
    } finally {
      const completion = state.folderHistoryLoads.finish(token);
      if (completion.current && completion.reloadRequested && workspaceContainsProject(key)) {
        void loadFolderHistory(projectPath, true);
      }
    }
  };

  const renderProjectList = (): void => {
    const liveSessionIds = new Set(dependencies.getWorkspaceState().sessions.map(({ id }) => id));
    for (const [restoreKey, sessionId] of state.restoredConversationSessions) {
      if (!liveSessionIds.has(sessionId)) state.restoredConversationSessions.delete(restoreKey);
    }
    for (const sessionId of state.failedConversationTransitions.keys()) {
      if (!liveSessionIds.has(sessionId)) state.failedConversationTransitions.delete(sessionId);
    }
    const list = elements.projectList;
    const previousHeight = list.getBoundingClientRect().height;
    const previousScrollTop = list.scrollTop;
    const previousAnimation = listAnimation;
    const previousTime = previousAnimation?.currentTime;
    const wasAnimating = previousAnimation?.playState === 'running';
    listAnimation?.cancel();
    listAnimation = undefined;
    const openFolders = dependencies
      .getWorkspaceState()
      .projects.filter((project) => project.open).length;
    const pendingCount = state.pendingConversations.size;
    elements.projectCount.textContent = `${openFolders} 个项目 · ${
      dependencies.getWorkspaceState().sessions.length + pendingCount
    } 个对话${pendingCount > 0 ? ` · ${pendingCount} 个准备中` : ''}`;

    // Replace once: emptying a live scroller first clamps its position to zero on every status push.
    list.replaceChildren(...dependencies.getWorkspaceState().projects.map(renderProjectFolder));
    const nextHeight = list.getBoundingClientRect().height;
    list.scrollTop = previousScrollTop;
    if (hasRendered && !prefersReducedMotion() && list.animate) {
      // Animate the actual list height so the footer follows it without overlapping new rows.
      // Retarget from the currently painted height when another session arrives mid-animation.
      if (
        wasAnimating &&
        previousAnimation &&
        previousTime != null &&
        Math.abs(animationTargetHeight - nextHeight) <= 1
      ) {
        // Status pushes often rebuild identical rows. Keep elapsed time rather than restarting the
        // same destination on every push, which could indefinitely postpone the footer settling.
        previousAnimation.currentTime = previousTime;
        previousAnimation.play();
        listAnimation = previousAnimation;
      } else if (Math.abs(previousHeight - nextHeight) > 1) {
        animationTargetHeight = nextHeight;
        listAnimation = list.animate(
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          { duration: SCROLL_DURATION_MS, easing: EASE_OUT_CUBIC },
        );
      }
    }
    hasRendered = true;
  };

  return {
    loadFolderHistory,
    renderProjectList,
  };
};
