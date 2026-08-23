import type { ClaudeSessionMetadata } from '../../../shared/contracts';
import { orchestrateClaudeLaunchAttempt } from '../../platform/claude-launch-attempt';
import type { ProjectsActionsDependencies, ProjectsRowsApi } from './actions-dependencies';
import type { ProjectsState } from './state';
import type { WorkspaceRenderer } from './workspace';

export interface ProjectsHistoryActions {
  deleteStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
  renameStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
  resumeStoredConversation: (projectPath: string, session: ClaudeSessionMetadata) => Promise<void>;
}

export const createProjectsHistoryActions = (
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
  workspaceRenderer: WorkspaceRenderer,
  rowsApi: ProjectsRowsApi,
  requestConversationTitle: (currentTitle: string, historical: boolean) => Promise<string | null>,
): ProjectsHistoryActions => {
  const renameStoredConversation = async (
    projectPath: string,
    session: ClaudeSessionMetadata,
  ): Promise<void> => {
    const currentTitle = session.sessionName || session.sessionId.slice(0, 8);
    const nextTitle = await requestConversationTitle(currentTitle, true);
    if (!nextTitle) {
      return;
    }
    try {
      const renamed = await window.controlPanel.renameClaudeSession(
        projectPath,
        session.sessionId,
        nextTitle,
      );
      if (!renamed) {
        dependencies.showToast('无法重命名这个历史对话。', 'error');
        return;
      }
      await rowsApi.loadFolderHistory(projectPath, true);
      dependencies.showToast(`历史对话已重命名为“${nextTitle}”`);
    } catch {
      dependencies.showToast('无法重命名这个历史对话。', 'error');
    }
  };

  const deleteStoredConversation = async (
    projectPath: string,
    session: ClaudeSessionMetadata,
  ): Promise<void> => {
    const title = session.sessionName || session.sessionId.slice(0, 8);
    if (
      !(await dependencies.requestConfirmation({
        confirmLabel: '永久删除',
        message: `永久删除历史对话“${title}”？此操作无法撤销；如果该对话仍在运行，会先关闭对应终端。`,
        title: '删除历史对话',
        tone: 'danger',
      }))
    ) {
      return;
    }

    try {
      const result = await window.controlPanel.deleteClaudeSession(projectPath, session.sessionId);
      workspaceRenderer.renderWorkspace(result.state);
      if (!result.ok || !result.deleted) {
        throw new Error(
          dependencies.resultFailureMessage(result, '历史对话文件已不存在或无法删除。'),
        );
      }
      await rowsApi.loadFolderHistory(projectPath, true);
      dependencies.showToast(`已删除历史对话“${title}”`);
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法删除这个历史对话。',
        'error',
      );
    }
  };

  /** Resumes a stored transcript in its canonical terminal owner. */
  const resumeStoredConversation = async (
    projectPath: string,
    session: ClaudeSessionMetadata,
  ): Promise<void> => {
    const restoreKey = `${projectPath.toLowerCase()}:${session.conversationId}`;
    if (state.storedConversationRestores.has(restoreKey)) {
      return;
    }
    state.storedConversationRestores.add(restoreKey);
    try {
      const opened = await window.controlPanel.openStoredConversation(
        projectPath,
        session.conversationId,
      );
      workspaceRenderer.renderWorkspace(opened.state);
      if (!opened.ok) {
        dependencies.showToast(
          dependencies.resultFailureMessage(opened, '无法恢复这个历史会话。'),
          'error',
        );
        return;
      }
      dependencies.setNativePanelVisible(false);
      dependencies.retryTerminalFitUntilMeasured();
      dependencies.requestComposerFocus(opened.state.activeSessionId);
      const label = session.sessionName || session.conversationId.slice(0, 8);
      if (opened.reused) {
        dependencies.showToast(`已切换到 ${label}`);
        return;
      }

      const status = opened.state.sessions.find(({ id }) => id === opened.state.activeSessionId);
      if (!status) {
        dependencies.showToast('无法找到刚创建的历史会话终端。', 'error');
        return;
      }
      const attempt = dependencies.beginClaudeLaunchAttempt(status);
      const outcome = await orchestrateClaudeLaunchAttempt({
        applyResult: (launchOutcome) =>
          launchOutcome.status === 'paused' ||
          dependencies.renderClaudeLaunchResult(
            attempt,
            launchOutcome.result.state,
            launchOutcome.result.ok ? 'success' : 'failure',
          ),
        onRelease: () => dependencies.refreshClaudeLaunchControls(attempt.sessionId),
        registry: dependencies.claudeLaunchAttempts,
        start: () => window.controlPanel.launchClaudeWithSession(status.id, session.conversationId),
        token: attempt,
      });
      if (outcome.status === 'rejected') {
        dependencies.showToast('恢复历史会话时发生异常。', 'error');
        return;
      }
      if (outcome.status !== 'resolved') return;

      let launchOutcome = outcome.result;
      if (launchOutcome.status === 'paused') {
        const decision = await dependencies.resolveClaudeLaunchDecision(attempt, launchOutcome);
        if (decision.status !== 'completed') return;
        launchOutcome = decision;
        if (
          !dependencies.renderClaudeLaunchResult(
            attempt,
            launchOutcome.result.state,
            launchOutcome.result.ok ? 'success' : 'failure',
          )
        ) {
          return;
        }
      }
      if (!launchOutcome.result.ok) {
        dependencies.failClaudeLaunchAttempt(attempt);
        dependencies.showToast(
          dependencies.resultFailureMessage(launchOutcome.result, '无法恢复这个历史会话。'),
          'error',
        );
        return;
      }
      dependencies.showToast(`已在安全终端恢复 ${label}`);
    } catch {
      dependencies.showToast('无法恢复这个历史会话。', 'error');
    } finally {
      state.storedConversationRestores.delete(restoreKey);
    }
  };

  return {
    deleteStoredConversation,
    renameStoredConversation,
    resumeStoredConversation,
  };
};
