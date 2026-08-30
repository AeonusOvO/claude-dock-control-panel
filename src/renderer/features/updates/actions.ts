import type { ClaudePluginCatalog } from '../../../shared/contracts';
import { deriveUpdateActionState } from '../../../shared/ui/update-actions';
import type { UpdatesElements } from './elements';
import type { UpdatesState } from './state';
import type { UpdateCenterItem, UpdatesView } from './view';

export interface UpdateConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface UpdatesActionsDependencies {
  downloadsIsOpen: () => boolean;
  getActiveSessionId: () => string | undefined;
  getPluginCatalog: () => ClaudePluginCatalog | undefined;
  loadClaudeState: (sessionId: string) => Promise<void>;
  loadMcpCatalog: (refreshRegistry: boolean) => Promise<void>;
  openDownloads: () => void;
  refreshPluginUpdates: () => Promise<boolean>;
  requestConfirmation: (request: UpdateConfirmationRequest) => Promise<boolean>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  runAllPluginUpdates: () => Promise<void>;
  runRouterUpdate: () => Promise<void>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface UpdatesActions {
  bind: () => () => void;
  loadSoftwareUpdates: (refresh?: boolean) => Promise<void>;
  refreshAvailableUpdates: (manual: boolean) => Promise<void>;
  runAllUpdates: () => Promise<void>;
  runApplicationUpdateAction: () => Promise<void>;
  runClaudeInstallUpdate: () => Promise<void>;
  runUpdateCenterAction: (item: UpdateCenterItem) => Promise<void>;
}

interface UpdatesActionsContext {
  dependencies: UpdatesActionsDependencies;
  elements: UpdatesElements;
  state: UpdatesState;
  view: UpdatesView;
}

const runApplicationUpdateAction = async (context: UpdatesActionsContext): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  elements.applicationUpdateAction.disabled = true;
  elements.applicationUpdateAction.textContent = '正在检查…';
  try {
    view.renderApplicationUpdater(await window.controlPanel.downloadApplicationUpdate());
  } catch (error) {
    dependencies.showToast(error instanceof Error ? error.message : '无法下载应用更新。', 'error');
  } finally {
    if (state.applicationUpdaterState) {
      view.renderApplicationUpdater(state.applicationUpdaterState);
    }
  }
};

const loadSoftwareUpdates = (context: UpdatesActionsContext, refresh = false): Promise<void> => {
  const { elements, state, view } = context;
  if (state.softwareUpdatePromise) {
    return state.softwareUpdatePromise;
  }
  if (state.softwareUpdateInProgress) {
    return Promise.resolve();
  }
  state.softwareUpdateInProgress = true;
  state.softwareUpdatePromise = (async () => {
    try {
      const [updates, updater] = await Promise.all([
        window.controlPanel.getSoftwareUpdates(refresh),
        window.controlPanel.getApplicationUpdaterState(
          refresh || state.applicationUpdaterState === undefined,
        ),
      ]);
      view.renderApplicationUpdater(updater);
      view.renderSoftwareUpdates(updates);
    } catch {
      elements.claudeUpdateDetail.textContent = '暂时无法读取软件版本，请检查网络后重试。';
    } finally {
      state.softwareUpdateInProgress = false;
      state.softwareUpdatePromise = undefined;
      elements.installUpdateClaudeButton.disabled = false;
      view.syncUpdateActionVisibility();
    }
  })();
  return state.softwareUpdatePromise;
};

const runClaudeInstallUpdate = async (context: UpdatesActionsContext): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.softwareUpdateInProgress) {
    return;
  }
  state.softwareUpdateInProgress = true;
  elements.installUpdateClaudeButton.disabled = true;
  const original = elements.installUpdateClaudeButton.textContent;
  elements.installUpdateClaudeButton.textContent = '正在安装，请稍候…';
  try {
    const result = await window.controlPanel.installOrUpdateClaudeCode();
    view.renderSoftwareUpdates(result.state);
    dependencies.showToast(
      result.ok ? result.message : dependencies.resultFailureMessage(result, result.message),
      result.ok ? 'success' : 'error',
    );
    const sessionId = dependencies.getActiveSessionId();
    if (sessionId) {
      void dependencies.loadClaudeState(sessionId);
    }
  } catch {
    dependencies.showToast('Claude Code 安装或更新发生异常。', 'error');
  } finally {
    state.softwareUpdateInProgress = false;
    elements.installUpdateClaudeButton.textContent = original;
    elements.installUpdateClaudeButton.disabled = false;
    view.syncUpdateActionVisibility();
  }
};

const runUpdateCenterAction = async (
  context: UpdatesActionsContext,
  item: UpdateCenterItem,
): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.updateCenterOperationInProgress || item.disabled) return;
  state.updateCenterOperationInProgress = true;
  view.renderUpdateCenter();
  elements.updateCenterDialog.close('start-update');
  dependencies.openDownloads();
  try {
    await item.run();
  } finally {
    state.updateCenterOperationInProgress = false;
    await loadSoftwareUpdates(context, true);
    view.renderUpdateCenter();
  }
};

const runAllUpdates = async (context: UpdatesActionsContext): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.updateCenterOperationInProgress) return;
  const actions = deriveUpdateActionState(
    state.softwareUpdates,
    dependencies.getPluginCatalog(),
    state.applicationUpdaterState,
  );
  const hasProject = Boolean(dependencies.getActiveSessionId());
  state.updateCenterOperationInProgress = true;
  view.renderUpdateCenter();
  elements.updateCenterDialog.close('start-all-updates');
  dependencies.openDownloads();
  try {
    if (actions.claudeCode === 'update') await runClaudeInstallUpdate(context);
    if (actions.router === 'update' && hasProject) {
      await dependencies.runRouterUpdate();
    }
    if (actions.plugins) {
      await dependencies.runAllPluginUpdates();
    }
    // ClaudeDock is deliberately last: a successful download exits into the NSIS installer, so no
    // later mutation may remain queued after the application has entered its one-way quit latch.
    if (actions.application) {
      try {
        view.renderApplicationUpdater(await window.controlPanel.downloadApplicationUpdate());
      } catch (error) {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法下载 ClaudeDock 更新。',
          'error',
        );
      }
    }
  } finally {
    state.updateCenterOperationInProgress = false;
    await loadSoftwareUpdates(context, true);
    view.renderUpdateCenter();
  }
};

const resolveDownloadRecoveries = async (context: UpdatesActionsContext): Promise<void> => {
  const { dependencies, state } = context;
  let pending: unknown;
  try {
    // Recovery decisions belong to the main-process journal, not to a possibly stale renderer
    // history snapshot. This also surfaces records restored during startup before the next refresh.
    pending = await window.controlPanel.listDownloadRecoveryPending();
  } catch {
    // The update center can still show software updates when recovery metadata is unavailable.
    return;
  }
  if (!Array.isArray(pending)) return;
  for (const task of pending) {
    const shouldResume = await dependencies.requestConfirmation({
      confirmLabel: '恢复更新',
      message: `检测到“${task.label}”上次下载被中断，已保留 ${Math.round(
        Math.max(0, task.percent),
      )}% 的安全快照。选择“恢复更新”会从上次位置继续；取消将删除该任务的残留片段和恢复记录。`,
      title: '恢复中断的更新？',
    });
    try {
      if (shouldResume) {
        await window.controlPanel.resumeDownloadRecovery(task.id);
      } else {
        await window.controlPanel.discardDownloadRecovery(task.id);
      }
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : `无法处理“${task.label}”的恢复记录。`,
        'error',
      );
    }
  }
  try {
    state.downloadHistory = await window.controlPanel.listDownloads();
  } catch {
    // The update center can still show software updates when download history is unavailable.
  }
};

const refreshAvailableUpdates = async (
  context: UpdatesActionsContext,
  manual: boolean,
): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.updateRefreshInProgress) {
    return;
  }
  state.updateRefreshInProgress = true;
  elements.refreshUpdatesButton.disabled = true;
  elements.refreshUpdatesButton.classList.add('titlebar__refresh--busy');
  elements.refreshUpdatesButton.setAttribute('aria-busy', 'true');
  if (manual) {
    state.updateCenterTab = 'pending';
    if (!elements.updateCenterDialog.open) elements.updateCenterDialog.showModal();
    view.renderUpdateCenter();
    elements.closeUpdateCenterButton.focus();
  }

  try {
    const results = await Promise.allSettled([
      loadSoftwareUpdates(context, manual),
      // Plugin update flags are only trustworthy after the local marketplace checkout is refreshed.
      // This remains a background CLI task on first load and only becomes user-visible through the
      // titlebar busy state.
      dependencies.refreshPluginUpdates(),
      // MCP refresh only re-discovers configuration and synchronizes the trusted Registry endpoint;
      // it is never consent to execute or contact a project-defined MCP server.
      dependencies.getActiveSessionId() ? dependencies.loadMcpCatalog(true) : Promise.resolve(),
      window.controlPanel.listDownloads().then((tasks) => {
        state.downloadHistory = tasks;
      }),
    ]);
    const pluginsOk = results[1]?.status === 'fulfilled' && results[1].value;
    const failedSources = results.filter(({ status }) => status === 'rejected').length;
    await resolveDownloadRecoveries(context);
    state.updateRefreshInProgress = false;
    view.syncUpdateActionVisibility();
    if (manual) {
      const actions = deriveUpdateActionState(
        state.softwareUpdates,
        dependencies.getPluginCatalog(),
        state.applicationUpdaterState,
      );
      if (!pluginsOk || failedSources > 0) {
        dependencies.showToast('全局检查已完成，但至少一个更新来源暂时不可用。', 'error');
      }
      view.renderUpdateCenter();
      if (!elements.updateCenterDialog.open) elements.updateCenterDialog.showModal();
      elements.closeUpdateCenterButton.focus();
      if (pluginsOk && failedSources === 0) {
        dependencies.showToast(
          actions.totalAvailable > 0
            ? `检查完成，发现 ${actions.totalAvailable} 项可更新。`
            : '检查完成，当前没有发现可用更新。',
        );
      }
    }
  } finally {
    state.updateRefreshInProgress = false;
    elements.refreshUpdatesButton.disabled = false;
    elements.refreshUpdatesButton.classList.remove('titlebar__refresh--busy');
    elements.refreshUpdatesButton.setAttribute('aria-busy', 'false');
  }
};

const bindUpdatesActions = (context: UpdatesActionsContext): (() => void) => {
  const { dependencies, elements, state, view } = context;
  const unsubscribeApplicationUpdaterChanged = window.controlPanel.onApplicationUpdaterChanged(
    view.renderApplicationUpdater,
  );
  const handleRefresh = (): void => void refreshAvailableUpdates(context, true);
  const handlePendingTab = (): void => {
    state.updateCenterTab = 'pending';
    view.renderUpdateCenter();
    elements.updateCenterPendingTab.focus();
  };
  const handleHistoryTab = (): void => {
    state.updateCenterTab = 'history';
    view.renderUpdateCenter();
    elements.updateCenterHistoryTab.focus();
  };
  const handleClose = (): void => elements.updateCenterDialog.close('close');
  const handleCancel = (): void => elements.updateCenterDialog.close('cancel');
  const handleAll = (): void => void runAllUpdates(context);
  const handleBackdrop = (event: MouseEvent): void => {
    if (event.target === elements.updateCenterDialog) {
      elements.updateCenterDialog.close('backdrop');
    }
  };
  const handleDialogClose = (): void => {
    if (!dependencies.downloadsIsOpen()) elements.refreshUpdatesButton.focus();
  };
  const handleSoftwareRefresh = (): void => {
    elements.refreshSoftwareUpdatesButton.disabled = true;
    void loadSoftwareUpdates(context, true).finally(() => {
      elements.refreshSoftwareUpdatesButton.disabled = false;
    });
  };
  const handleApplicationAction = (): void => void runApplicationUpdateAction(context);

  elements.refreshUpdatesButton.addEventListener('click', handleRefresh);
  elements.updateCenterPendingTab.addEventListener('click', handlePendingTab);
  elements.updateCenterHistoryTab.addEventListener('click', handleHistoryTab);
  elements.closeUpdateCenterButton.addEventListener('click', handleClose);
  elements.cancelUpdateCenterButton.addEventListener('click', handleCancel);
  elements.updateCenterAllButton.addEventListener('click', handleAll);
  elements.updateCenterDialog.addEventListener('click', handleBackdrop);
  elements.updateCenterDialog.addEventListener('close', handleDialogClose);
  elements.refreshSoftwareUpdatesButton.addEventListener('click', handleSoftwareRefresh);
  elements.applicationUpdateAction.addEventListener('click', handleApplicationAction);

  return () => {
    unsubscribeApplicationUpdaterChanged();
    elements.refreshUpdatesButton.removeEventListener('click', handleRefresh);
    elements.updateCenterPendingTab.removeEventListener('click', handlePendingTab);
    elements.updateCenterHistoryTab.removeEventListener('click', handleHistoryTab);
    elements.closeUpdateCenterButton.removeEventListener('click', handleClose);
    elements.cancelUpdateCenterButton.removeEventListener('click', handleCancel);
    elements.updateCenterAllButton.removeEventListener('click', handleAll);
    elements.updateCenterDialog.removeEventListener('click', handleBackdrop);
    elements.updateCenterDialog.removeEventListener('close', handleDialogClose);
    elements.refreshSoftwareUpdatesButton.removeEventListener('click', handleSoftwareRefresh);
    elements.applicationUpdateAction.removeEventListener('click', handleApplicationAction);
  };
};

export const createUpdatesActions = (
  elements: UpdatesElements,
  state: UpdatesState,
  dependencies: UpdatesActionsDependencies,
  view: UpdatesView,
): UpdatesActions => {
  const context = { dependencies, elements, state, view };
  return {
    bind: () => bindUpdatesActions(context),
    loadSoftwareUpdates: (refresh) => loadSoftwareUpdates(context, refresh),
    refreshAvailableUpdates: (manual) => refreshAvailableUpdates(context, manual),
    runAllUpdates: () => runAllUpdates(context),
    runApplicationUpdateAction: () => runApplicationUpdateAction(context),
    runClaudeInstallUpdate: () => runClaudeInstallUpdate(context),
    runUpdateCenterAction: (item) => runUpdateCenterAction(context, item),
  };
};
