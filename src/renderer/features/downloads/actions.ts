import type { BusyLease, DownloadTaskView } from '../../../shared/contracts';
import type { DownloadsElements } from './elements';
import { ACTIVE_DOWNLOAD_STATES, type DownloadsState } from './state';

export interface DownloadConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface DownloadsActionsDependencies {
  isRouterOperationInProgress: () => boolean;
  requestConfirmation: (request: DownloadConfirmationRequest) => Promise<boolean>;
  setRouterOperationStage: (stage: string, detail: string, percent?: number) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface DownloadsActions {
  bind: () => () => void;
  deleteHistory: (task: DownloadTaskView, button: HTMLButtonElement) => void;
  load: () => Promise<void>;
  open: () => void;
  runTaskAction: (taskId: string, action: 'cancel' | 'pause' | 'resume') => Promise<void>;
}

export const createDownloadsActions = (
  elements: DownloadsElements,
  state: DownloadsState,
  dependencies: DownloadsActionsDependencies,
  render: () => void,
): DownloadsActions => {
  const applyDownloads = (tasks: DownloadTaskView[]): void => {
    state.tasks = tasks;
    render();
    const routerDownload = tasks.find(
      (task) =>
        ACTIVE_DOWNLOAD_STATES.has(task.state) &&
        /CCR|CC Switch|Claude Code Router|路由器/i.test(task.label),
    );
    if (routerDownload && dependencies.isRouterOperationInProgress()) {
      dependencies.setRouterOperationStage(
        routerDownload.state === 'verifying' ? '校验下载' : '下载组件',
        `${routerDownload.label} · ${
          routerDownload.totalBytes > 0 ? `${Math.round(routerDownload.percent)}%` : '正在接收…'
        }`,
        routerDownload.totalBytes > 0
          ? Math.max(5, Math.min(70, routerDownload.percent * 0.7))
          : undefined,
      );
    }
  };

  const applyBusyLeases = (leases: BusyLease[]): void => {
    state.busyLeases = leases;
    render();
  };

  const runTaskAction = async (
    taskId: string,
    action: 'cancel' | 'pause' | 'resume',
  ): Promise<void> => {
    try {
      if (action === 'cancel') {
        await window.controlPanel.cancelDownload(taskId);
      } else if (action === 'pause') {
        await window.controlPanel.pauseDownload(taskId);
      } else {
        await window.controlPanel.resumeDownload(taskId);
      }
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法更新下载任务。',
        'error',
      );
    }
  };

  const deleteHistory = (task: DownloadTaskView, button: HTMLButtonElement): void => {
    void (async () => {
      const confirmed = await dependencies.requestConfirmation({
        confirmLabel: '删除记录',
        message: `删除“${task.label}”的下载历史？这不会删除已经安装的软件。`,
        title: '删除下载历史',
        tone: 'danger',
      });
      if (!confirmed) return;
      button.disabled = true;
      try {
        applyDownloads(await window.controlPanel.deleteDownloadHistory(task.id));
      } catch (error) {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法删除下载历史。',
          'error',
        );
        button.disabled = false;
      }
    })();
  };

  const clearHistory = (): void => {
    void (async () => {
      const confirmed = await dependencies.requestConfirmation({
        confirmLabel: '清空历史',
        message: '清空全部下载历史？这不会删除已经下载或安装的软件。',
        title: '清空下载历史',
        tone: 'danger',
      });
      if (!confirmed) return;
      elements.clearHistoryButton.disabled = true;
      try {
        applyDownloads(await window.controlPanel.clearDownloadHistory());
      } catch (error) {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法清空下载历史。',
          'error',
        );
        elements.clearHistoryButton.disabled = false;
      }
    })();
  };

  const open = (): void => {
    if (!elements.centerDialog.open) {
      elements.centerDialog.showModal();
    }
    elements.closeCenterButton.focus();
  };

  const load = async (): Promise<void> => {
    try {
      applyDownloads(await window.controlPanel.listDownloads());
    } catch {
      applyDownloads([]);
    }
    try {
      applyBusyLeases(await window.controlPanel.listBusyLeases());
    } catch {
      state.busyLeases = [];
    }
  };

  const bind = (): (() => void) => {
    const unsubscribeDownloadsChanged = window.controlPanel.onDownloadsChanged(applyDownloads);
    const unsubscribeBusyChanged = window.controlPanel.onBusyChanged(applyBusyLeases);
    const unsubscribeOpenRequested = window.controlPanel.onOpenDownloadCenterRequested(open);
    const handleOpen = (): void => open();
    const handleClose = (): void => elements.centerDialog.close('close');
    const handleBackdrop = (event: MouseEvent): void => {
      if (event.target === elements.centerDialog) {
        elements.centerDialog.close('backdrop');
      }
    };
    const handleDialogClose = (): void => elements.openCenterButton.focus();
    const handleClearHistory = (): void => clearHistory();

    elements.openCenterButton.addEventListener('click', handleOpen);
    elements.closeCenterButton.addEventListener('click', handleClose);
    elements.centerDialog.addEventListener('click', handleBackdrop);
    elements.centerDialog.addEventListener('close', handleDialogClose);
    elements.clearHistoryButton.addEventListener('click', handleClearHistory);

    return () => {
      unsubscribeDownloadsChanged();
      unsubscribeBusyChanged();
      unsubscribeOpenRequested();
      elements.openCenterButton.removeEventListener('click', handleOpen);
      elements.closeCenterButton.removeEventListener('click', handleClose);
      elements.centerDialog.removeEventListener('click', handleBackdrop);
      elements.centerDialog.removeEventListener('close', handleDialogClose);
      elements.clearHistoryButton.removeEventListener('click', handleClearHistory);
    };
  };

  return { bind, deleteHistory, load, open, runTaskAction };
};
