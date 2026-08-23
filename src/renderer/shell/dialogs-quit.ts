import { requiredElement } from '../platform/dom';
import type { AppQuitDecision, AppQuitRequest } from '../../shared/contracts';
import type { ConfirmationDialogActions } from './dialogs-confirmation';

export interface QuitConfirmationDialogActions {
  dispose: () => void;
}

export const createQuitConfirmationDialogActions = (
  confirmationActions: ConfirmationDialogActions,
): QuitConfirmationDialogActions => {
  const quitConfirmationDialog = requiredElement<HTMLDialogElement>('#quit-confirmation-dialog');
  const quitConfirmationTitle = requiredElement<HTMLElement>('#quit-confirmation-title');
  const quitConfirmationMessage = requiredElement<HTMLElement>('#quit-confirmation-message');
  const quitConfirmationList = requiredElement<HTMLUListElement>('#quit-confirmation-list');
  const quitMinimizeButton = requiredElement<HTMLButtonElement>('#quit-minimize');
  const quitForceButton = requiredElement<HTMLButtonElement>('#quit-force');
  const quitCancelButton = requiredElement<HTMLButtonElement>('#quit-cancel');
  let pendingForceRequestId: string | undefined;
  let pendingQuitRequest: AppQuitRequest | undefined;

  const invalidateQuitConfirmation = (requestId: string): void => {
    if (pendingQuitRequest?.requestId !== requestId) return;
    pendingQuitRequest = undefined;
    if (pendingForceRequestId === requestId) {
      pendingForceRequestId = undefined;
      confirmationActions.cancelPending();
    }
    if (quitConfirmationDialog.open) {
      quitConfirmationDialog.close('invalidated');
    }
  };

  const closeQuitConfirmation = (requestId: string, decision: AppQuitDecision): boolean => {
    if (pendingQuitRequest?.requestId !== requestId) return false;
    pendingQuitRequest = undefined;
    if (pendingForceRequestId === requestId) pendingForceRequestId = undefined;
    if (quitConfirmationDialog.open) {
      quitConfirmationDialog.close(decision === true ? 'quit' : String(decision));
    }
    window.controlPanel.confirmQuit({ decision, requestId });
    return true;
  };

  const renderQuitConfirmation = (request: AppQuitRequest): void => {
    if (pendingQuitRequest && pendingQuitRequest.requestId !== request.requestId) {
      invalidateQuitConfirmation(pendingQuitRequest.requestId);
    }
    pendingQuitRequest = request;
    quitConfirmationTitle.textContent = request.runtimeCleanupFailed
      ? '仍有会话或派生进程未能安全结束'
      : request.hasBlocking
        ? '有操作正在进行，不建议退出'
        : request.leases.length > 0
          ? '还有后台任务未完成'
          : '确认退出 ClaudeDock？';
    quitConfirmationMessage.textContent = request.runtimeCleanupFailed
      ? '安全清理尚未完成。请重试；只有明确确认仍要退出，才会留下列出的会话或进程。'
      : request.leases.length > 0
        ? '退出会结束下列会话或任务；也可以最小化到托盘，让它们继续运行。'
        : '确认要彻底退出吗？所有 ClaudeDock 窗口和终端都会关闭。';
    quitMinimizeButton.textContent = request.runtimeCleanupFailed
      ? '重试安全清理'
      : '最小化到托盘，继续运行';
    quitCancelButton.hidden = request.runtimeCleanupFailed === true;
    quitForceButton.dataset.tone = request.hasBlocking ? 'danger' : 'neutral';
    quitConfirmationList.hidden = request.leases.length === 0;
    quitConfirmationList.replaceChildren(
      ...request.leases.map((lease) => {
        const item = document.createElement('li');
        const label = document.createElement('strong');
        const badge = document.createElement('span');
        item.dataset.severity = lease.severity;
        label.textContent = lease.label;
        badge.textContent = lease.severity === 'blocking' ? '中断会留下不完整状态' : '可稍后继续';
        item.append(label, badge);
        return item;
      }),
    );
    if (!quitConfirmationDialog.open) {
      quitConfirmationDialog.showModal();
    }
    quitMinimizeButton.focus();
  };

  /* Every path answers the exact main-process handshake, including Esc and the safe action. */
  const unsubscribeAppQuitRequested =
    window.controlPanel.onAppQuitRequested(renderQuitConfirmation);
  const unsubscribeAppQuitRequestInvalidated = window.controlPanel.onAppQuitRequestInvalidated(
    invalidateQuitConfirmation,
  );
  quitMinimizeButton.addEventListener('click', () => {
    const request = pendingQuitRequest;
    if (!request) return;
    if (request.runtimeCleanupFailed) {
      closeQuitConfirmation(request.requestId, 'retry');
      return;
    }
    closeQuitConfirmation(request.requestId, 'minimize');
  });
  quitCancelButton.addEventListener('click', () => {
    const request = pendingQuitRequest;
    if (!request || request.runtimeCleanupFailed) return;
    closeQuitConfirmation(request.requestId, false);
  });
  quitConfirmationDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    const request = pendingQuitRequest;
    if (!request || request.runtimeCleanupFailed) return;
    closeQuitConfirmation(request.requestId, false);
  });
  quitConfirmationDialog.addEventListener('click', (event) => {
    const request = pendingQuitRequest;
    if (event.target === quitConfirmationDialog && request && !request.runtimeCleanupFailed) {
      closeQuitConfirmation(request.requestId, false);
    }
  });
  quitForceButton.addEventListener('click', () => {
    const request = pendingQuitRequest;
    if (!request) return;
    quitConfirmationDialog.close('force-requested');
    if (!request.hasBlocking) {
      closeQuitConfirmation(request.requestId, true);
      return;
    }
    pendingForceRequestId = request.requestId;
    void confirmationActions
      .requestConfirmation({
        confirmLabel: '仍要退出',
        message: request.runtimeCleanupFailed
          ? '安全清理仍未完成。退出可能留下上方列出的会话或派生进程，确认仍要退出吗？'
          : '退出会中断不可恢复的安装或配置操作，并可能留下不完整状态。确认仍要退出吗？',
        title: request.runtimeCleanupFailed ? '确认带残留强制退出' : '确认中断关键操作',
        tone: 'danger',
      })
      .then((confirmed) => {
        if (pendingForceRequestId === request.requestId) pendingForceRequestId = undefined;
        if (pendingQuitRequest?.requestId !== request.requestId) return;
        if (!confirmed && request.runtimeCleanupFailed) {
          if (!quitConfirmationDialog.open) quitConfirmationDialog.showModal();
          quitMinimizeButton.focus();
          return;
        }
        closeQuitConfirmation(request.requestId, confirmed);
      });
  });

  return {
    dispose: () => {
      if (pendingForceRequestId) confirmationActions.cancelPending();
      pendingForceRequestId = undefined;
      pendingQuitRequest = undefined;
      unsubscribeAppQuitRequestInvalidated();
      unsubscribeAppQuitRequested();
    },
  };
};
