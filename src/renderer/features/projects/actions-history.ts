import type {
  ClaudeConversationModelChoice,
  ClaudeSessionMetadata,
} from '../../../shared/contracts';
import { orchestrateClaudeLaunchAttempt } from '../../platform/claude-launch-attempt';
import type { ProjectsActionsDependencies, ProjectsRowsApi } from './actions-dependencies';
import type { ProjectsState } from './state';
import type { WorkspaceRenderer } from './workspace';
import type { ConversationModelDialogResult } from './model-resolution-dialog';

type ModelResolution = Awaited<
  ReturnType<typeof window.controlPanel.inspectClaudeConversationModel>
>;
type RequestModelChoice = (
  resolution: ModelResolution,
  conversationLabel: string,
) => Promise<ConversationModelDialogResult | null>;

const resolveHistoryModelChoice = async (
  resolution: ModelResolution,
  label: string,
  requestModelChoice: RequestModelChoice,
  showToast: ProjectsActionsDependencies['showToast'],
): Promise<ClaudeConversationModelChoice | null | undefined> => {
  if (!resolution.mismatch) return undefined;
  if (resolution.preference === 'use-current') return 'use-current';
  if (resolution.preference === 'use-conversation' && resolution.restorable) {
    return 'use-conversation';
  }
  const decision = await requestModelChoice(resolution, label);
  if (!decision) return null;
  if (decision.remember) {
    try {
      const settings = await window.controlPanel.getAppSettings();
      await window.controlPanel.setConversationResumePreferences({
        ...settings.conversationResume,
        modelMismatchBehavior: decision.choice,
      });
    } catch {
      showToast('本次选择已生效，但“不再提示”设置未能保存。', 'error');
    }
  }
  return decision.choice;
};

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
  requestModelChoice: RequestModelChoice,
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
      const label = session.sessionName || session.conversationId.slice(0, 8);
      const resolution = await window.controlPanel.inspectClaudeConversationModel(
        projectPath,
        session.conversationId,
        session.modelId,
      );
      const modelChoice = await resolveHistoryModelChoice(
        resolution,
        label,
        requestModelChoice,
        dependencies.showToast,
      );
      if (modelChoice === null) return;

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
        prepare: async () => {
          if (modelChoice) {
            const phase =
              modelChoice === 'use-conversation' &&
              resolution.conversation.networkPresentation === 'foreign'
                ? 'checking-model-network'
                : 'switching-model';
            dependencies.setClaudeLaunchPresentationPhase(attempt, phase);
            const applied = await window.controlPanel.applyClaudeConversationModel(
              status.id,
              session.conversationId,
              modelChoice,
            );
            if (!applied.ok) {
              throw new Error(
                dependencies.resultFailureMessage(applied, '无法切换历史对话的模型接入。'),
              );
            }
          }
          dependencies.setClaudeLaunchPresentationPhase(attempt, 'restoring-conversation');
        },
        registry: dependencies.claudeLaunchAttempts,
        start: () => window.controlPanel.launchClaudeWithSession(status.id, session.conversationId),
        token: attempt,
      });
      if (outcome.status === 'rejected') {
        dependencies.showToast(
          outcome.error instanceof Error ? outcome.error.message : '恢复历史会话时发生异常。',
          'error',
        );
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
