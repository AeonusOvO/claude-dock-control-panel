import { requiredElement } from '../platform/dom';
import type { AppQuitRequest } from '../../shared/contracts';
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
  let pendingQuitRequest: AppQuitRequest | undefined;

  const closeQuitConfirmation = (decision: boolean | 'retry'): void => {
    pendingQuitRequest = undefined;
    if (quitConfirmationDialog.open) {
      quitConfirmationDialog.close(decision === true ? 'quit' : String(decision));
    }
    window.controlPanel.confirmQuit(decision);
  };

  const renderQuitConfirmation = (request: AppQuitRequest): void => {
    pendingQuitRequest = request;
    quitConfirmationTitle.textContent = request.runtimeCleanupFailed
      ? '仍有派生 Web 进程未能安全结束'
      : request.hasBlocking
        ? '有操作正在进行，不建议退出'
        : request.leases.length > 0
          ? '还有后台任务未完成'
          : '确认退出 ClaudeDock？';
    quitConfirmationMessage.textContent = request.runtimeCleanupFailed
      ? '安全清理尚未完成。请重试；只有明确强制退出才会留下列出的进程。'
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

  /* Every path answers the main-process handshake, including Esc and the default safe action. */
  const unsubscribeAppQuitRequested =
    window.controlPanel.onAppQuitRequested(renderQuitConfirmation);
  quitMinimizeButton.addEventListener('click', () => {
    if (pendingQuitRequest?.runtimeCleanupFailed) {
      closeQuitConfirmation('retry');
      return;
    }
    closeQuitConfirmation(false);
    window.controlPanel.minimizeToTray();
  });
  quitCancelButton.addEventListener('click', () => {
    if (pendingQuitRequest?.runtimeCleanupFailed) return;
    closeQuitConfirmation(false);
  });
  quitConfirmationDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (pendingQuitRequest?.runtimeCleanupFailed) return;
    closeQuitConfirmation(false);
  });
  quitConfirmationDialog.addEventListener('click', (event) => {
    if (event.target === quitConfirmationDialog && !pendingQuitRequest?.runtimeCleanupFailed) {
      closeQuitConfirmation(false);
    }
  });
  quitForceButton.addEventListener('click', () => {
    const request = pendingQuitRequest;
    if (!request) {
      return;
    }
    quitConfirmationDialog.close('force-requested');
    if (!request.hasBlocking) {
      closeQuitConfirmation(true);
      return;
    }
    void confirmationActions
      .requestConfirmation({
        confirmLabel: '仍要退出',
        message: request.runtimeCleanupFailed
          ? '安全清理仍未完成。强制退出可能留下上方列出的派生 Web 进程，确认仍要退出吗？'
          : '退出会中断不可恢复的安装或配置操作，并可能留下不完整状态。确认仍要退出吗？',
        title: request.runtimeCleanupFailed ? '确认带残留强制退出' : '确认中断关键操作',
        tone: 'danger',
      })
      .then((confirmed) => {
        closeQuitConfirmation(confirmed);
      });
  });

  return {
    dispose: () => {
      unsubscribeAppQuitRequested();
    },
  };
};
