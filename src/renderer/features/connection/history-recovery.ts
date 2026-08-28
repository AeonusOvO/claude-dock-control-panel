import type {
  ClaudeConnectionHistoryResult,
  ClaudeConnectionTestResult,
} from '../../../shared/contracts';
import { requiredElement } from '../../platform/dom';
import { historyDisplayName } from './history-labels';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';
import type { ConnectionHistoryMutationActions } from './history-mutations';

const recoverySurface = requiredElement<HTMLElement>('#connection-history-recovery');
const recoveryKicker = requiredElement<HTMLElement>('#connection-history-recovery-kicker');
const recoveryTitle = requiredElement<HTMLElement>('#connection-history-recovery-title');
const recoveryDetail = requiredElement<HTMLElement>('#connection-history-recovery-detail');
const recoveryDetails = requiredElement<HTMLUListElement>('#connection-history-recovery-details');
const cancelRecoveryButton = requiredElement<HTMLButtonElement>(
  '#cancel-connection-history-recovery',
);
const retryRecoveryButton = requiredElement<HTMLButtonElement>(
  '#retry-connection-history-recovery',
);
const returnRecoveryButton = requiredElement<HTMLButtonElement>(
  '#return-from-connection-history-recovery',
);

const normalConnectionSurfaces = [
  requiredElement<HTMLElement>('.connection-heading__intro'),
  requiredElement<HTMLElement>('#open-connection-history'),
  requiredElement<HTMLElement>('#connection-wizard-progress'),
  requiredElement<HTMLElement>('#connection-advice'),
  requiredElement<HTMLElement>('#environment-setup'),
  requiredElement<HTMLElement>('#connection-wizard-viewport'),
  requiredElement<HTMLElement>('#connection-wizard-actions'),
] as const;

interface SurfaceSnapshot {
  hidden: boolean;
  inert: boolean;
}

type RecoveryPhase = 'cancelling' | 'failure' | 'idle' | 'running' | 'success';

const stageStatusLabel: Record<ClaudeConnectionTestResult['stages'][number]['status'], string> = {
  failed: '失败',
  passed: '通过',
  skipped: '未执行',
  warning: '需确认',
};

const renderTestDetails = (test: ClaudeConnectionTestResult | undefined): void => {
  recoveryDetails.replaceChildren();
  if (!test) return;
  for (const stage of test.stages) {
    const item = document.createElement('li');
    item.dataset.status = stage.status;
    const heading = document.createElement('span');
    const label = document.createElement('strong');
    label.textContent = stage.label;
    const status = document.createElement('em');
    status.textContent = stageStatusLabel[stage.status];
    heading.append(label, status);
    const detail = document.createElement('small');
    detail.textContent = stage.detail;
    item.append(heading, detail);
    recoveryDetails.append(item);
  }
};

const nextVisualFrame = (): Promise<void> =>
  new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

export interface ConnectionHistoryRecoveryActions {
  reset: () => void;
  start: (entryId: string, restoreFocus?: () => void) => Promise<void>;
}

/** Owns the page-level history replay state; attempt fencing prevents late results from resurfacing. */
export const createConnectionHistoryRecoveryActions = (
  dependencies: ConnectionHistoryDependencies,
  state: ConnectionHistoryState,
  mutations: ConnectionHistoryMutationActions,
  renderCurrentConnection: () => void,
): ConnectionHistoryRecoveryActions => {
  const surfaceSnapshots = new Map<HTMLElement, SurfaceSnapshot>();
  let activeEntryId = '';
  let activeLabel = '';
  let attempt = 0;
  let phase: RecoveryPhase = 'idle';
  let cancelRequested = false;
  let cancelDecision: Promise<boolean> | undefined;
  let restoreFocusOnLeave: (() => void) | undefined;
  let successTimer: number | undefined;

  const clearSuccessTimer = (): void => {
    if (successTimer === undefined) return;
    window.clearTimeout(successTimer);
    successTimer = undefined;
  };

  const setNormalSurfacesHidden = (hidden: boolean): void => {
    if (hidden) {
      for (const surface of normalConnectionSurfaces) {
        surfaceSnapshots.set(surface, {
          hidden: surface.hasAttribute('hidden'),
          inert: surface.hasAttribute('inert'),
        });
        surface.hidden = true;
        surface.toggleAttribute('inert', true);
      }
      return;
    }
    for (const surface of normalConnectionSurfaces) {
      const snapshot = surfaceSnapshots.get(surface);
      if (!snapshot) continue;
      surface.hidden = snapshot.hidden;
      surface.toggleAttribute('inert', snapshot.inert);
    }
    surfaceSnapshots.clear();
  };

  const setActions = (nextPhase: RecoveryPhase): void => {
    const busy = nextPhase === 'running' || nextPhase === 'cancelling';
    cancelRecoveryButton.hidden = !busy;
    cancelRecoveryButton.disabled = nextPhase === 'cancelling';
    cancelRecoveryButton.textContent = nextPhase === 'cancelling' ? '正在取消…' : '取消接入';
    retryRecoveryButton.hidden = nextPhase !== 'failure';
    returnRecoveryButton.hidden = nextPhase !== 'failure';
  };

  const enterRecovery = (): void => {
    if (recoverySurface.hidden) {
      setNormalSurfacesHidden(true);
      recoverySurface.hidden = false;
      recoverySurface.toggleAttribute('inert', false);
    }
    recoverySurface.scrollIntoView({ behavior: userScrollBehavior(), block: 'start' });
    window.setTimeout(() => recoveryTitle.focus({ preventScroll: true }), 0);
  };

  const leaveRecovery = (restoreFocus = true): void => {
    const focus = restoreFocusOnLeave;
    clearSuccessTimer();
    phase = 'idle';
    recoverySurface.dataset.phase = 'idle';
    recoverySurface.setAttribute('aria-busy', 'false');
    recoverySurface.hidden = true;
    recoverySurface.toggleAttribute('inert', true);
    setNormalSurfacesHidden(false);
    renderTestDetails(undefined);
    restoreFocusOnLeave = undefined;
    if (restoreFocus) focus?.();
  };

  const renderRunning = (): void => {
    phase = 'running';
    recoverySurface.dataset.phase = phase;
    recoverySurface.setAttribute('aria-busy', 'true');
    recoveryKicker.textContent = '接入历史';
    recoveryTitle.textContent = `当前正在接入 ${activeLabel}`;
    recoveryDetail.textContent = '可能会消耗少量 token';
    renderTestDetails(undefined);
    setActions(phase);
  };

  const renderFailure = (result: ClaudeConnectionHistoryResult | undefined): void => {
    phase = 'failure';
    recoverySurface.dataset.phase = phase;
    recoverySurface.setAttribute('aria-busy', 'false');
    recoveryKicker.textContent = '接入未完成';
    recoveryTitle.textContent = `${activeLabel} 接入失败`;
    recoveryDetail.textContent = result
      ? dependencies.resultFailureMessage(result, '历史配置未通过连接测试，请检查后重试。')
      : '后台没有返回可确认的接入结果，请重新接入。';
    renderTestDetails(result?.connectionTest);
    setActions(phase);
    recoveryTitle.focus({ preventScroll: true });
  };

  const renderSuccess = (result: ClaudeConnectionHistoryResult): void => {
    phase = 'success';
    recoverySurface.dataset.phase = phase;
    recoverySurface.setAttribute('aria-busy', 'false');
    recoveryKicker.textContent = '接入完成';
    recoveryTitle.textContent = `${activeLabel} 已完成接入`;
    recoveryDetail.textContent =
      result.connectionTest?.ok === false
        ? '配置已恢复；官方账号认证由 Claude Code 管理，将在会话启动时继续确认。'
        : (result.connectionTest?.message ?? '网络、身份认证和模型响应测试均已完成。');
    renderTestDetails(result.connectionTest);
    setActions(phase);
    renderCurrentConnection();
    recoveryTitle.focus({ preventScroll: true });
  };

  const start = async (entryId: string, restoreFocus?: () => void): Promise<void> => {
    const entry = state.allEntries.find((candidate) => candidate.id === entryId);
    if (!entry || state.mutationInProgress) return;

    clearSuccessTimer();
    const currentAttempt = ++attempt;
    activeEntryId = entryId;
    activeLabel = historyDisplayName(entry);
    if (restoreFocus) restoreFocusOnLeave = restoreFocus;
    cancelRequested = false;
    cancelDecision = undefined;
    enterRecovery();
    renderRunning();

    const resultPromise = mutations.applyConnectionHistory(entryId);
    await nextVisualFrame();
    const result = await resultPromise;
    if (currentAttempt !== attempt) return;

    if (cancelRequested) {
      const cancelled = await cancelDecision;
      if (currentAttempt !== attempt) return;
      if (cancelled) {
        dependencies.showToast(`已取消接入 ${activeLabel}`);
        leaveRecovery();
        return;
      }
    }

    if (!result?.ok) {
      renderFailure(result);
      return;
    }

    if (result.connectionTest?.ok) {
      leaveRecovery(false);
      renderCurrentConnection();
      dependencies.connectionSucceeded();
      return;
    }

    renderSuccess(result);
    successTimer = window.setTimeout(() => {
      if (currentAttempt !== attempt || phase !== 'success') return;
      leaveRecovery();
    }, 1_500);
  };

  const cancel = (): void => {
    if (phase !== 'running' || cancelRequested) return;
    cancelRequested = true;
    phase = 'cancelling';
    recoverySurface.dataset.phase = phase;
    recoveryTitle.textContent = `正在取消 ${activeLabel} 的接入`;
    recoveryDetail.textContent = '正在等待后台安全退出并恢复原有项目配置…';
    setActions(phase);
    cancelDecision = mutations.cancelConnectionHistoryApply();
  };

  const reset = (): void => {
    attempt += 1;
    activeEntryId = '';
    activeLabel = '';
    cancelRequested = false;
    cancelDecision = undefined;
    leaveRecovery(false);
  };

  cancelRecoveryButton.addEventListener('click', cancel);
  retryRecoveryButton.addEventListener('click', () => {
    void start(activeEntryId);
  });
  returnRecoveryButton.addEventListener('click', () => {
    attempt += 1;
    leaveRecovery();
  });

  return { reset, start };
};
import { userScrollBehavior } from '../../platform/motion';
