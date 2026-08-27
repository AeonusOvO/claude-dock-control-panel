import type {
  ClaudeConversationModelChoice,
  ClaudeSessionMetadata,
  TerminalStatus,
} from '../../../shared/contracts';
import { orchestrateClaudeLaunchAttempt } from '../../platform/claude-launch-attempt';
import type { ProjectsActionsDependencies, ProjectsRowsApi } from './actions-dependencies';
import type { ConversationTransitionQueueState } from './conversation-transition-queue';
import type { PendingConversation, ProjectsState } from './state';
import { storedConversationRestoreKey } from './state';
import type { WorkspaceRenderer } from './workspace';
import type { ConversationModelDialogResult } from './model-resolution-dialog';
import { beginWorkspaceConversationTransition } from './transition-busy';

type ModelResolution = Awaited<
  ReturnType<typeof window.controlPanel.inspectClaudeConversationModel>
>;
type RequestModelChoice = (
  resolution: ModelResolution,
  conversationLabel: string,
) => Promise<ConversationModelDialogResult | null>;

export interface StoredConversationResumeOptions {
  autoLoadConversationModel: boolean;
  source: 'startup';
}

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
  resumeStoredConversation: (
    projectPath: string,
    session: ClaudeSessionMetadata,
    options?: StoredConversationResumeOptions,
  ) => Promise<void>;
}

interface ResumeStoredConversationInput {
  dependencies: ProjectsActionsDependencies;
  options?: StoredConversationResumeOptions;
  projectPath: string;
  requestModelChoice: RequestModelChoice;
  rowsApi: ProjectsRowsApi;
  session: ClaudeSessionMetadata;
  state: ProjectsState;
  workspaceRenderer: WorkspaceRenderer;
}

interface OptimisticHistoryMove {
  finish: (render?: boolean) => void;
  pending: PendingConversation;
  setCancel: (cancel: () => boolean) => void;
  updateQueueState: (queueState: ConversationTransitionQueueState) => void;
}

const beginOptimisticHistoryMove = (
  dependencies: ProjectsActionsDependencies,
  rowsApi: ProjectsRowsApi,
  state: ProjectsState,
  projectPath: string,
  label: string,
  startup: boolean,
): OptimisticHistoryMove => {
  const pendingId = `pending-conversation-${++state.pendingConversationSequence}`;
  const pending: PendingConversation = {
    id: pendingId,
    kind: 'restoring',
    phase: 'queued',
    projectPath,
    title: label,
  };
  state.pendingConversations.set(pendingId, pending);
  const releasePreview = dependencies.beginWorkspaceTerminalPreview(
    startup ? '正在恢复上次对话…' : '正在恢复历史对话…',
  );
  rowsApi.renderProjectList();
  let finished = false;
  return {
    finish: (render = true) => {
      if (finished) return;
      finished = true;
      state.pendingConversations.delete(pendingId);
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

interface FailedHistoryResumeRollbackInput {
  dependencies: ProjectsActionsDependencies;
  openedNewSession: boolean;
  openedSessionId?: string;
  projectPath: string;
  rowsApi: ProjectsRowsApi;
  state: ProjectsState;
  workspaceRenderer: WorkspaceRenderer;
}

const rollbackFailedHistoryResume = async ({
  dependencies,
  openedNewSession,
  openedSessionId,
  projectPath,
  rowsApi,
  state,
  workspaceRenderer,
}: FailedHistoryResumeRollbackInput): Promise<void> => {
  let rollbackFailure: string | undefined;
  if (
    openedNewSession &&
    openedSessionId &&
    dependencies.getWorkspaceState().sessions.some(({ id }) => id === openedSessionId)
  ) {
    try {
      const rolledBack = await window.controlPanel.closeProject(openedSessionId);
      workspaceRenderer.renderWorkspace(rolledBack.state);
      if (!rolledBack.ok) {
        rollbackFailure = dependencies.resultFailureMessage(rolledBack, '临时终端未能关闭。');
      }
    } catch (error) {
      rollbackFailure =
        error instanceof Error && error.message ? error.message : '临时终端未能关闭。';
    }
  }
  try {
    await rowsApi.loadFolderHistory(projectPath, true);
  } catch {
    // The authoritative cache was never edited by the optimistic move. A later expansion retries.
  }
  if (!rollbackFailure) return;
  if (openedSessionId) {
    state.failedConversationTransitions.set(openedSessionId, 'restoring');
    rowsApi.renderProjectList();
  }
  dependencies.showToast(
    `恢复失败，历史记录已保留，但自动回滚未完成：${rollbackFailure} 请手动关闭临时终端。`,
    'error',
  );
};

const beginRestoringSessionPresentation = (
  dependencies: ProjectsActionsDependencies,
  rowsApi: ProjectsRowsApi,
  state: ProjectsState,
  status: TerminalStatus,
  options?: StoredConversationResumeOptions,
): {
  attempt: ReturnType<ProjectsActionsDependencies['beginClaudeLaunchAttempt']>;
  finish: () => void;
} => {
  const attempt = dependencies.beginClaudeLaunchAttempt(status);
  state.transitioningConversations.set(status.id, 'restoring');
  rowsApi.renderProjectList();
  const releaseMask = dependencies.beginTerminalMask(
    status.id,
    options
      ? options.autoLoadConversationModel
        ? '正在连接模型…'
        : '正在恢复上次对话…'
      : '正在恢复历史对话…',
  );
  return {
    attempt,
    finish: () => {
      state.transitioningConversations.delete(status.id);
      releaseMask();
      rowsApi.renderProjectList();
    },
  };
};

interface AdmittedHistoryRestoreInput extends ResumeStoredConversationInput {
  label: string;
  optimistic: OptimisticHistoryMove;
  releaseTransition: () => void;
  restoreKey: string;
}

const runAdmittedHistoryRestore = async ({
  dependencies,
  label,
  optimistic,
  options,
  projectPath,
  releaseTransition,
  requestModelChoice,
  restoreKey,
  rowsApi,
  session,
  state,
  workspaceRenderer,
}: AdmittedHistoryRestoreInput): Promise<void> => {
  let committed = false;
  let openedSessionId: string | undefined;
  let openedNewSession = false;
  try {
    // The transcript stays on disk; only its visible row moves, so a crash cannot erase history.
    const opened = await window.controlPanel.openStoredConversation(
      projectPath,
      session.conversationId,
    );
    optimistic.finish(false);
    workspaceRenderer.renderWorkspace(opened.state);
    if (!opened.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(opened, '无法恢复这个历史会话。'),
        'error',
      );
      return;
    }
    openedSessionId = opened.createdSessionId ?? opened.state.activeSessionId;
    openedNewSession = !opened.reused;
    if (dependencies.getWorkspaceState().activeSessionId === openedSessionId) {
      dependencies.setNativePanelVisible(false);
      dependencies.retryTerminalFitUntilMeasured();
    }
    if (opened.reused) {
      committed = true;
      state.restoredConversationSessions.set(restoreKey, openedSessionId);
      await rowsApi.loadFolderHistory(projectPath, true);
      if (dependencies.getWorkspaceState().activeSessionId === openedSessionId) {
        dependencies.requestComposerFocus(openedSessionId);
      }
      dependencies.showToast(`已切换到 ${label}`);
      return;
    }

    const status = opened.state.sessions.find(({ id }) => id === openedSessionId);
    if (!status) {
      dependencies.showToast('无法找到刚创建的历史会话终端。', 'error');
      return;
    }
    const presentation = beginRestoringSessionPresentation(
      dependencies,
      rowsApi,
      state,
      status,
      options,
    );
    const { attempt } = presentation;
    try {
      const resolution =
        options && !options.autoLoadConversationModel
          ? undefined
          : await window.controlPanel.inspectClaudeConversationModel(
              projectPath,
              session.conversationId,
              session.modelId,
            );
      const modelChoice = options
        ? options.autoLoadConversationModel && resolution?.mismatch
          ? resolution.restorable
            ? ('use-conversation' as const)
            : null
          : undefined
        : await resolveHistoryModelChoice(
            resolution!,
            label,
            requestModelChoice,
            dependencies.showToast,
          );
      if (modelChoice === null) {
        if (options) {
          throw new Error('上次对话的模型接入信息不完整，已取消自动恢复。');
        }
        return;
      }
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
          const effectiveModelChoice = options
            ? options.autoLoadConversationModel && resolution?.mismatch
              ? 'use-conversation'
              : undefined
            : modelChoice;
          if (effectiveModelChoice && resolution) {
            const phase =
              effectiveModelChoice === 'use-conversation' &&
              resolution.conversation.networkPresentation === 'foreign'
                ? 'checking-model-network'
                : 'switching-model';
            dependencies.setClaudeLaunchPresentationPhase(attempt, phase);
            const applied = await window.controlPanel.applyClaudeConversationModel(
              status.id,
              session.conversationId,
              effectiveModelChoice,
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
      committed = true;
      state.restoredConversationSessions.set(restoreKey, status.id);
      await rowsApi.loadFolderHistory(projectPath, true);
      if (dependencies.getWorkspaceState().activeSessionId === status.id) {
        dependencies.requestComposerFocus(status.id);
      }
      dependencies.showToast(options ? `已自动恢复 ${label}` : `已恢复 ${label}`);
    } finally {
      if (!committed && dependencies.claudeLaunchAttempts.isCurrent(attempt)) {
        dependencies.failClaudeLaunchAttempt(attempt);
      }
      presentation.finish();
    }
  } catch (error) {
    dependencies.showToast(
      error instanceof Error ? error.message : '无法恢复这个历史会话。',
      'error',
    );
  } finally {
    optimistic.finish();
    if (!committed) {
      await rollbackFailedHistoryResume({
        dependencies,
        openedNewSession,
        openedSessionId,
        projectPath,
        rowsApi,
        state,
        workspaceRenderer,
      });
    }
    state.storedConversationRestores.delete(restoreKey);
    rowsApi.renderProjectList();
    releaseTransition();
  }
};

/** Resumes a stored transcript in its canonical terminal owner. */
const resumeStoredConversationWithDependencies = async ({
  dependencies,
  options,
  projectPath,
  requestModelChoice,
  rowsApi,
  session,
  state,
  workspaceRenderer,
}: ResumeStoredConversationInput): Promise<void> => {
  const restoreKey = storedConversationRestoreKey(projectPath, session.conversationId);
  if (state.storedConversationRestores.has(restoreKey)) {
    return;
  }
  state.storedConversationRestores.add(restoreKey);
  const releaseTransition = beginWorkspaceConversationTransition(state);
  const label = session.sessionName || session.conversationId.slice(0, 8);
  const optimistic = beginOptimisticHistoryMove(
    dependencies,
    rowsApi,
    state,
    projectPath,
    label,
    Boolean(options),
  );
  const ticket = state.conversationTransitionQueue.enqueue(
    () =>
      runAdmittedHistoryRestore({
        dependencies,
        label,
        optimistic,
        options,
        projectPath,
        releaseTransition,
        requestModelChoice,
        restoreKey,
        rowsApi,
        session,
        state,
        workspaceRenderer,
      }),
    optimistic.updateQueueState,
  );
  optimistic.setCancel(ticket.cancel);
  const outcome = await ticket.result;
  if (outcome.status === 'cancelled') {
    optimistic.finish(false);
    state.storedConversationRestores.delete(restoreKey);
    rowsApi.renderProjectList();
    releaseTransition();
    dependencies.showToast(`已取消排队中的历史对话“${label}”`);
  }
};

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

  const resumeStoredConversation = async (
    projectPath: string,
    session: ClaudeSessionMetadata,
    options?: StoredConversationResumeOptions,
  ): Promise<void> =>
    resumeStoredConversationWithDependencies({
      dependencies,
      ...(options ? { options } : {}),
      projectPath,
      requestModelChoice,
      rowsApi,
      session,
      state,
      workspaceRenderer,
    });

  return {
    deleteStoredConversation,
    renameStoredConversation,
    resumeStoredConversation,
  };
};
