import type { StartupModelConnectionState } from '../../../shared/contracts';
import { requiredElement } from '../../platform/dom';

export interface StartupModelConnectionOverlayDependencies {
  refreshConnection: () => Promise<unknown>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface StartupModelConnectionOverlay {
  dispose: () => void;
  initialize: () => Promise<void>;
}

const page = requiredElement<HTMLElement>(".rail-page[data-rail-page='connection']");
const overlay = requiredElement<HTMLElement>('#startup-model-connection');
const title = requiredElement<HTMLElement>('#startup-model-connection-title');
const detail = requiredElement<HTMLElement>('#startup-model-connection-detail');
const step = requiredElement<HTMLElement>('#startup-model-connection-step');
const accountRow = requiredElement<HTMLElement>('#startup-model-connection-account-row');
const account = requiredElement<HTMLElement>('#startup-model-connection-account');
const timing = requiredElement<HTMLElement>('#startup-model-connection-timing');
const cancelButton = requiredElement<HTMLButtonElement>('#cancel-startup-model-connection');

const durationLabel = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  if (seconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
};

const settlementToast = (
  state: StartupModelConnectionState,
): { message: string; tone?: 'error' | 'success' } | undefined => {
  if (state.phase === 'connected') return { message: state.detail, tone: 'success' };
  if (state.phase === 'failed' || state.phase === 'timed-out') {
    return { message: state.detail, tone: 'error' };
  }
  if (state.phase === 'cancelled') return { message: state.detail };
  return undefined;
};

export const createStartupModelConnectionOverlay = (
  dependencies: StartupModelConnectionOverlayDependencies,
): StartupModelConnectionOverlay => {
  let current: StartupModelConnectionState | undefined;
  let countdownTimer: number | undefined;
  let disposed = false;
  const previousInert = new Map<HTMLElement, boolean>();

  const setPageLocked = (locked: boolean): void => {
    page.dataset.startupConnection = locked ? 'active' : 'idle';
    page.setAttribute('aria-busy', String(locked));
    for (const child of Array.from(page.children)) {
      if (!(child instanceof HTMLElement) || child === overlay) continue;
      if (locked) {
        if (!previousInert.has(child)) previousInert.set(child, child.inert);
        child.inert = true;
      } else {
        child.inert = previousInert.get(child) ?? false;
        previousInert.delete(child);
      }
    }
  };

  const renderTiming = (): void => {
    if (!current?.active) return;
    if (current.phase === 'cancelling') {
      timing.textContent = '正在等待后台事务回滚完成；完成前不会提交迟到结果。';
      cancelButton.hidden = true;
      return;
    }
    const now = Date.now();
    const canCancel = current.cancelAvailableAt !== undefined && now >= current.cancelAvailableAt;
    cancelButton.hidden = !canCancel;
    cancelButton.disabled = false;
    cancelButton.textContent = '取消接入';
    if (!canCancel && current.cancelAvailableAt !== undefined) {
      timing.textContent = `后台正在安全验证，${durationLabel(current.cancelAvailableAt - now)}后可取消。`;
      return;
    }
    if (current.forceStopAt !== undefined) {
      timing.textContent = `仍在处理中；你现在可以取消，最晚将在 ${durationLabel(current.forceStopAt - now)}后自动结束。`;
      return;
    }
    timing.textContent = '仍在处理中；你现在可以取消本次接入。';
  };

  const stopCountdown = (): void => {
    if (countdownTimer === undefined) return;
    window.clearInterval(countdownTimer);
    countdownTimer = undefined;
  };

  const applyState = (state: StartupModelConnectionState): void => {
    if (disposed || (current && state.updatedAt < current.updatedAt)) return;
    const wasActive = current?.active === true;
    current = { ...state };
    if (!state.active) {
      stopCountdown();
      overlay.hidden = true;
      setPageLocked(false);
      if (wasActive) {
        void dependencies.refreshConnection().catch(() => undefined);
        const toast = settlementToast(state);
        if (toast) dependencies.showToast(toast.message, toast.tone);
      }
      return;
    }
    overlay.hidden = false;
    setPageLocked(true);
    title.textContent = state.phase === 'cancelling' ? '正在结束模型接入' : '正在接入模型';
    detail.textContent = state.detail;
    step.textContent = state.phase === 'cancelling' ? '安全取消与回滚' : (state.step ?? '正在连接');
    accountRow.hidden = !state.accountLabel;
    account.textContent = state.accountLabel ?? '';
    renderTiming();
    if (countdownTimer === undefined) {
      countdownTimer = window.setInterval(renderTiming, 1_000);
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (!current?.active || cancelButton.hidden || cancelButton.disabled) return;
    cancelButton.disabled = true;
    cancelButton.textContent = '正在取消…';
    timing.textContent = '正在请求后台终止并回滚本次接入…';
    try {
      const result = await window.controlPanel.cancelStartupModelConnection();
      applyState(result.state);
      if (!result.ok) dependencies.showToast(result.message, 'error');
    } catch {
      dependencies.showToast('无法取消自动接入；已重新读取后台状态。', 'error');
      try {
        applyState(await window.controlPanel.getStartupModelConnection());
      } catch {
        cancelButton.disabled = false;
        cancelButton.textContent = '重试取消';
      }
    }
  };

  const handleCancelClick = (): void => {
    void handleCancel();
  };
  cancelButton.addEventListener('click', handleCancelClick);
  const unsubscribe = window.controlPanel.onStartupModelConnectionChanged(applyState);

  return {
    dispose: () => {
      disposed = true;
      stopCountdown();
      cancelButton.removeEventListener('click', handleCancelClick);
      unsubscribe();
      overlay.hidden = true;
      setPageLocked(false);
    },
    initialize: async () => {
      try {
        applyState(await window.controlPanel.getStartupModelConnection());
      } catch {
        overlay.hidden = true;
        setPageLocked(false);
        dependencies.showToast('无法读取启动模型接入状态；接入页已恢复为可操作状态。', 'error');
      }
    },
  };
};
