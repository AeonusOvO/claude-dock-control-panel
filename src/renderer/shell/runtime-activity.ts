import { requiredElement } from '../platform/dom';
import type { RuntimeActivitySnapshot } from '../../shared/contracts';
import { RUNTIME_PHASE_LABELS, runtimeTaskIsUnfinished } from './runtime-activity-labels';
import { createRuntimeActivityListsActions } from './runtime-activity-lists';
import {
  createRuntimeActivityPanelActions,
  runtimeActivityTrigger,
} from './runtime-activity-panel';

export type { RuntimeActivityShellDeps } from './runtime-activity-dependencies';
import type { RuntimeActivityShellDeps } from './runtime-activity-dependencies';

const runtimeActivityPresentationKey = (
  active: ReturnType<RuntimeActivityShellDeps['activeStatus']>,
  nativeSnapshot: ReturnType<RuntimeActivityShellDeps['getActiveConversationSnapshot']>,
  state: RuntimeActivitySnapshot | undefined,
): string =>
  JSON.stringify({
    active: active
      ? [
          active.id,
          active.cwd,
          active.title,
          active.phase,
          active.ptyGeneration,
          active.pid,
          active.shell,
          active.message,
          active.diagnosticCode,
        ]
      : undefined,
    native: nativeSnapshot
      ? {
          conversationId: nativeSnapshot.conversationId,
          model: nativeSnapshot.capabilities?.model,
          phase: nativeSnapshot.phase,
          tasks: nativeSnapshot.tasks.map((task) => [
            task.id,
            task.kind,
            task.status,
            task.description,
            task.summary,
            task.cancellable,
          ]),
        }
      : undefined,
    runtime: state
      ? {
          phase: state.phase,
          sessionId: state.sessionId,
          tasks: state.tasks.map((task) => [
            task.id,
            task.kind,
            task.status,
            task.description,
            task.agentType,
            task.tokenUse,
            task.willWakeParent,
          ]),
          webProcesses: state.webProcesses.map((process) => [
            process.processKey,
            process.name,
            process.pid,
            process.status,
            process.commandSummary,
            process.exposureWarning,
            process.urls.map(({ confirmed, url }) => [url, confirmed]),
          ]),
        }
      : undefined,
  });

const runtimeActivityLabel = requiredElement<HTMLElement>('#runtime-activity-label');
const runtimeActivitySummary = requiredElement<HTMLElement>('#runtime-activity-summary');
const runtimeEnvironmentMeta = requiredElement<HTMLElement>('#runtime-environment-meta');
const runtimeTaskMeta = requiredElement<HTMLElement>('#runtime-task-meta');

export interface RuntimeActivityShell {
  readonly runtimeActivityTrigger: HTMLButtonElement;
  readonly runtimeActivityPanel: HTMLElement;
  setRuntimeSummaryOpen: (open: boolean, restoreFocus?: boolean) => void;
  renderRuntimeActivity: (snapshot?: RuntimeActivitySnapshot) => void;
  loadActiveRuntimeActivity: () => Promise<void>;
}

export const createRuntimeActivityShell = (
  deps: RuntimeActivityShellDeps,
): RuntimeActivityShell => {
  const {
    getActiveSessionId,
    runtimeActivityStates,
    getActiveConversationSnapshot,
    activeStatus,
    renderActiveStatus,
    renderNoActiveSession,
    footerStatus,
    titleStatus,
    nativePhaseLabel,
    openExternal,
    showToast,
  } = deps;

  const panelActions = createRuntimeActivityPanelActions();
  const listsActions = createRuntimeActivityListsActions(
    { nativePhaseLabel, openExternal, showToast },
    (snapshot?: RuntimeActivitySnapshot) => renderRuntimeActivity(snapshot),
  );
  let lastPresentationKey = '';

  const renderRuntimeActivity = (snapshot?: RuntimeActivitySnapshot): void => {
    const activeSessionId = getActiveSessionId();
    const state = snapshot ?? runtimeActivityStates.get(activeSessionId);
    if (state) runtimeActivityStates.set(state.sessionId, state);
    const nativeSnapshot = getActiveConversationSnapshot();
    const active = activeStatus();
    const presentationKey = runtimeActivityPresentationKey(active, nativeSnapshot, state);
    if (presentationKey === lastPresentationKey) return;
    lastPresentationKey = presentationKey;
    const nativeTasks = nativeSnapshot?.tasks ?? [];
    const unfinished = state?.tasks.filter(runtimeTaskIsUnfinished) ?? [];
    const nativeUnfinished = nativeTasks.filter((task) =>
      ['queued', 'running', 'waiting'].includes(task.status),
    );
    const webProcesses = state?.webProcesses ?? [];
    const activityCount = unfinished.length + nativeUnfinished.length + webProcesses.length;
    const completedCount =
      (state?.tasks.filter((task) => task.status === 'completed').length ?? 0) +
      nativeTasks.filter((task) => task.status === 'completed' || task.status === 'stopped').length;
    const attentionCount =
      (state?.tasks.filter((task) => task.status === 'failed' || task.status === 'orphaned')
        .length ?? 0) +
      nativeTasks.filter((task) => task.status === 'failed' || task.status === 'lost').length;
    runtimeActivityTrigger.hidden = false;
    runtimeActivityTrigger.dataset.active = String(activityCount > 0);
    runtimeActivityTrigger.dataset.phase = state?.phase ?? nativeSnapshot?.phase ?? 'stopped';
    runtimeActivityLabel.textContent = activityCount > 0 ? `活动 ${activityCount}` : '对话摘要';
    const phaseLabel = nativeSnapshot
      ? nativePhaseLabel(nativeSnapshot.phase)
      : state
        ? RUNTIME_PHASE_LABELS[state.phase]
        : '当前没有运行中的对话';
    runtimeActivitySummary.textContent =
      activityCount > 0 ? `${phaseLabel} · ${activityCount} 项活动` : phaseLabel;
    runtimeEnvironmentMeta.textContent = nativeSnapshot
      ? '原生对话'
      : state
        ? '安全终端'
        : '未连接';
    runtimeTaskMeta.textContent =
      activityCount > 0
        ? `${activityCount} 运行${completedCount > 0 ? ` · ${completedCount} 完成` : ''}`
        : attentionCount > 0
          ? `${attentionCount} 待处理`
          : completedCount > 0
            ? `${completedCount} 完成`
            : '无活动';

    if (active) renderActiveStatus(active);
    else renderNoActiveSession();
    if (state?.phase === 'waiting-background' || state?.phase === 'resuming') {
      titleStatus.textContent =
        state.phase === 'waiting-background'
          ? `后台任务仍在运行 · ${unfinished.length} 项`
          : '后台任务已返回 · 正在恢复主对话';
      footerStatus.textContent = RUNTIME_PHASE_LABELS[state.phase];
    } else if (state?.phase === 'failed') {
      titleStatus.textContent = '本轮响应失败 · 终端上下文已保留';
      footerStatus.textContent = '需要手动继续';
    }

    listsActions.renderRuntimeActivityLists({
      active,
      nativeSnapshot,
      nativeTasks,
      state,
      webProcesses,
    });
  };

  const loadActiveRuntimeActivity = async (): Promise<void> => {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
      renderRuntimeActivity();
      return;
    }
    try {
      const state = await window.controlPanel.getRuntimeActivity(sessionId);
      if (getActiveSessionId() === sessionId) renderRuntimeActivity(state);
    } catch {
      renderRuntimeActivity();
    }
  };

  return {
    runtimeActivityTrigger: panelActions.runtimeActivityTrigger,
    runtimeActivityPanel: panelActions.runtimeActivityPanel,
    setRuntimeSummaryOpen: panelActions.setRuntimeSummaryOpen,
    renderRuntimeActivity,
    loadActiveRuntimeActivity,
  };
};
