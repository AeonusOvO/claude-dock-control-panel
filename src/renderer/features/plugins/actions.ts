import type {
  ClaudePluginCatalog,
  ClaudePluginMarketplaceView,
  ClaudePluginOperationResult,
  ClaudePluginView,
} from '../../../shared/contracts';
import type { PluginsElements } from './elements';
import {
  beginPluginOperation,
  ownsPluginOperation,
  pluginOperationInProgress,
  type PluginsState,
} from './state';
import type { PluginsView } from './view';

export interface PluginsActionsDependencies {
  resultFailureMessage: (result: unknown, fallback: string) => string;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  syncUpdateActionVisibility: () => void;
}

export interface PluginsActions {
  bind: () => () => void;
  installOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
  loadCatalog: (refresh: boolean) => Promise<void>;
  refreshUpdates: () => Promise<boolean>;
  removeMarketplaceOperation: (
    marketplace: ClaudePluginMarketplaceView,
  ) => () => Promise<ClaudePluginOperationResult>;
  runMutation: (
    operation: () => Promise<ClaudePluginOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<boolean>;
  setUpdateActionVisibility: (visible: boolean) => void;
  toggleOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
  uninstallOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
  updateAll: () => Promise<void>;
  updateOne: (pluginId: string) => Promise<void>;
  updateOperation: (plugin: ClaudePluginView) => () => Promise<ClaudePluginOperationResult>;
}

interface PluginsActionsContext {
  dependencies: PluginsActionsDependencies;
  elements: PluginsElements;
  state: PluginsState;
  view: PluginsView;
}

const ACTIVE_OPERATION_POLL_INTERVAL_MS = 500;

const clearActiveOperationPollTimer = (state: PluginsState): void => {
  if (state.activeOperationPollTimer !== undefined) {
    clearTimeout(state.activeOperationPollTimer);
    state.activeOperationPollTimer = undefined;
  }
};

const scheduleActiveOperationPoll = (context: PluginsActionsContext): void => {
  const { state } = context;
  const activeOperation = state.catalog?.activeOperation;
  if (state.disposed || !activeOperation) {
    clearActiveOperationPollTimer(state);
    state.activeOperationPollAttempt = undefined;
    return;
  }

  const operationChanged = state.activeOperationPollAttempt !== activeOperation.attempt;
  if (operationChanged) {
    clearActiveOperationPollTimer(state);
    state.activeOperationPollAttempt = activeOperation.attempt;
  }
  if (state.activeOperationPollInFlight || state.activeOperationPollTimer !== undefined) {
    return;
  }

  state.activeOperationPollTimer = setTimeout(
    () => {
      state.activeOperationPollTimer = undefined;
      void pollActiveOperation(context, activeOperation.attempt);
    },
    operationChanged ? 0 : ACTIVE_OPERATION_POLL_INTERVAL_MS,
  );
};

const acceptPluginCatalog = (
  context: PluginsActionsContext,
  catalog: ClaudePluginCatalog,
): void => {
  context.view.renderCatalog(catalog);
  scheduleActiveOperationPoll(context);
};

const pollActiveOperation = async (
  context: PluginsActionsContext,
  expectedAttempt: number,
): Promise<void> => {
  const { state } = context;
  if (
    state.disposed ||
    state.activeOperationPollInFlight ||
    state.catalog?.activeOperation?.attempt !== expectedAttempt
  ) {
    return;
  }

  state.activeOperationPollInFlight = true;
  try {
    const catalog = await window.controlPanel.getClaudePlugins(false);
    if (state.disposed || state.catalog?.activeOperation?.attempt !== expectedAttempt) {
      return;
    }
    acceptPluginCatalog(context, catalog);
  } catch {
    // The current main-owned operation remains visible; the bounded poll retries below.
  } finally {
    state.activeOperationPollInFlight = false;
    scheduleActiveOperationPoll(context);
  }
};

const toggleOperation =
  (plugin: ClaudePluginView): (() => Promise<ClaudePluginOperationResult>) =>
  () =>
    window.controlPanel.setClaudePluginEnabled(plugin.pluginId, !plugin.enabled);

const pluginUpdateOperation =
  (plugin: ClaudePluginView): (() => Promise<ClaudePluginOperationResult>) =>
  () =>
    window.controlPanel.updateClaudePlugin(plugin.pluginId);

const installOperation =
  (plugin: ClaudePluginView): (() => Promise<ClaudePluginOperationResult>) =>
  () =>
    window.controlPanel.installClaudePlugin(plugin.pluginId);

const uninstallOperation =
  (plugin: ClaudePluginView): (() => Promise<ClaudePluginOperationResult>) =>
  () =>
    window.controlPanel.uninstallClaudePlugin(plugin.pluginId);

const removeMarketplaceOperation =
  (marketplace: ClaudePluginMarketplaceView): (() => Promise<ClaudePluginOperationResult>) =>
  () =>
    window.controlPanel.removeClaudePluginMarketplace(marketplace.name);

const runPluginMutation = async (
  context: PluginsActionsContext,
  operation: () => Promise<ClaudePluginOperationResult>,
  busyLabel: string,
  button: HTMLButtonElement,
): Promise<boolean> => {
  const { dependencies, elements, state, view } = context;
  if (pluginOperationInProgress(state)) {
    return false;
  }
  const ownedOperation = beginPluginOperation(state, 'mutation');
  state.mutationOperation = ownedOperation;
  state.mutationInProgress = true;
  view.renderOperationPresentation();
  const originalLabel = button.textContent;
  button.textContent = busyLabel;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  elements.status.textContent = `${busyLabel}这一步会调用 claude 命令行，可能需要几十秒。`;
  let operationOwned = true;
  try {
    const result = await operation();
    if (!ownsPluginOperation(state.mutationOperation, ownedOperation)) {
      operationOwned = false;
      return false;
    }
    /*
     * Clear ownership before rebuilding cards so their initial disabled state reflects the settled
     * operation. This is synchronous: no newer operation can start between the ownership check and
     * the render.
     */
    state.mutationOperation = undefined;
    state.mutationInProgress = false;
    acceptPluginCatalog(context, result.catalog);
    dependencies.showToast(
      result.ok ? result.message : dependencies.resultFailureMessage(result, result.message),
      result.ok ? 'success' : 'error',
    );
    return result.ok;
  } catch {
    if (ownsPluginOperation(state.mutationOperation, ownedOperation)) {
      dependencies.showToast('插件操作发生异常。', 'error');
    } else {
      operationOwned = false;
    }
    return false;
  } finally {
    if (ownsPluginOperation(state.mutationOperation, ownedOperation)) {
      state.mutationOperation = undefined;
      state.mutationInProgress = false;
    }
    if (operationOwned && button.isConnected) {
      button.textContent = originalLabel;
      button.setAttribute('aria-busy', 'false');
    }
    if (operationOwned) {
      // Recompute catalogue-dependent predicates after restoring the original persistent button.
      view.renderOperationPresentation();
    }
  }
};

const loadPluginCatalog = (context: PluginsActionsContext, refresh: boolean): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.loadPromise) {
    return state.loadPromise;
  }
  if (state.mutationOperation || state.refreshOperation) {
    return Promise.resolve();
  }
  const ownedOperation = beginPluginOperation(state, 'load');
  state.loadOperation = ownedOperation;
  view.renderOperationPresentation();
  const promise = Promise.resolve().then(async () => {
    elements.updateAllButton.disabled = true;
    if (refresh || !state.catalog) {
      elements.status.textContent = '正在读取插件列表…';
    }
    try {
      const catalog = await window.controlPanel.getClaudePlugins(refresh);
      if (!ownsPluginOperation(state.loadOperation, ownedOperation)) {
        return;
      }
      acceptPluginCatalog(context, catalog);
    } catch {
      if (ownsPluginOperation(state.loadOperation, ownedOperation)) {
        elements.status.textContent = '无法读取插件列表；请确认已安装 Claude Code 命令行。';
      }
    } finally {
      if (ownsPluginOperation(state.loadOperation, ownedOperation)) {
        state.loadOperation = undefined;
        state.loadPromise = undefined;
        view.renderOperationPresentation();
        dependencies.syncUpdateActionVisibility();
      }
    }
  });
  state.loadPromise = promise;
  return promise;
};

const refreshPluginUpdates = (context: PluginsActionsContext): Promise<boolean> => {
  const { dependencies, elements, state, view } = context;
  if (state.refreshPromise) {
    return state.refreshPromise;
  }
  if (state.mutationOperation) {
    return Promise.resolve(false);
  }

  const operation = beginPluginOperation(state, 'refresh');
  state.refreshOperation = operation;
  state.mutationInProgress = true;
  view.renderOperationPresentation();

  const promise = Promise.resolve().then(async (): Promise<boolean> => {
    if (state.loadPromise) {
      await state.loadPromise;
    }
    if (!ownsPluginOperation(state.refreshOperation, operation)) {
      return false;
    }
    try {
      const result = await window.controlPanel.refreshClaudePluginMarketplaces();
      if (!ownsPluginOperation(state.refreshOperation, operation)) {
        return false;
      }
      acceptPluginCatalog(context, result.catalog);
      if (!result.ok) {
        elements.status.textContent = dependencies.resultFailureMessage(result, result.message);
      }
      return result.ok;
    } catch {
      if (ownsPluginOperation(state.refreshOperation, operation)) {
        elements.status.textContent = '无法刷新插件市场；请确认网络与 Claude Code 命令行可用。';
      }
      return false;
    } finally {
      if (ownsPluginOperation(state.refreshOperation, operation)) {
        state.refreshOperation = undefined;
        state.refreshPromise = undefined;
        state.mutationInProgress = false;
        if (state.catalog) {
          acceptPluginCatalog(context, state.catalog);
        } else {
          view.renderOperationPresentation();
        }
      }
    }
  });
  state.refreshPromise = promise;
  return promise;
};

const updateAllPlugins = async (context: PluginsActionsContext): Promise<void> => {
  await runPluginMutation(
    context,
    () => window.controlPanel.updateAllClaudePlugins(),
    '正在更新…',
    context.elements.updateAllButton,
  );
};

const updateOnePlugin = async (context: PluginsActionsContext, pluginId: string): Promise<void> => {
  await runPluginMutation(
    context,
    () => window.controlPanel.updateClaudePlugin(pluginId),
    '正在更新…',
    context.elements.updateAllButton,
  );
};

const setUpdateActionVisibility = (context: PluginsActionsContext, visible: boolean): void => {
  context.elements.updateActions.hidden = false;
  context.elements.updateAllButton.hidden = !visible;
};

const bindPluginActions = (context: PluginsActionsContext): (() => void) => {
  const { elements, state, view } = context;
  state.disposed = false;
  const tabBindings = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-plugin-tab]'),
    (button) => ({
      button,
      handleTab: (): void => {
        view.selectTab(button.dataset.pluginTab ?? 'installed');
      },
    }),
  );
  const handleUpdateAll = (): void => {
    void updateAllPlugins(context);
  };
  const handleRefresh = (): void => {
    void refreshPluginUpdates(context);
  };
  const handleSearch = (): void => {
    if (context.state.catalog) {
      view.renderCatalog(context.state.catalog);
    }
  };
  const handleCategoryFilter = (): void => {
    if (context.state.catalog) {
      view.renderCatalog(context.state.catalog);
    }
  };
  const handleMarketplaceSubmit = (event: Event): void => {
    event.preventDefault();
    if (pluginOperationInProgress(context.state)) {
      return;
    }
    const source = elements.marketplaceSource.value.trim();
    if (!source) {
      context.dependencies.showToast('请先填写插件市场地址。', 'error');
      return;
    }
    void runPluginMutation(
      context,
      () => window.controlPanel.addClaudePluginMarketplace(source),
      '正在添加…',
      elements.addMarketplaceButton,
    ).then((succeeded) => {
      if (succeeded && elements.marketplaceSource.value.trim() === source) {
        elements.marketplaceSource.value = '';
      }
    });
  };

  for (const { button, handleTab } of tabBindings) {
    button.addEventListener('click', handleTab);
  }
  elements.updateAllButton.addEventListener('click', handleUpdateAll);
  elements.refreshButton.addEventListener('click', handleRefresh);
  elements.search.addEventListener('input', handleSearch);
  elements.categoryFilter.addEventListener('change', handleCategoryFilter);
  elements.marketplaceForm.addEventListener('submit', handleMarketplaceSubmit);

  return () => {
    state.disposed = true;
    clearActiveOperationPollTimer(state);
    state.activeOperationPollAttempt = undefined;
    for (const { button, handleTab } of tabBindings) {
      button.removeEventListener('click', handleTab);
    }
    elements.updateAllButton.removeEventListener('click', handleUpdateAll);
    elements.refreshButton.removeEventListener('click', handleRefresh);
    elements.search.removeEventListener('input', handleSearch);
    elements.categoryFilter.removeEventListener('change', handleCategoryFilter);
    elements.marketplaceForm.removeEventListener('submit', handleMarketplaceSubmit);
  };
};

export const createPluginsActions = (
  elements: PluginsElements,
  state: PluginsState,
  dependencies: PluginsActionsDependencies,
  view: PluginsView,
): PluginsActions => {
  const context = { dependencies, elements, state, view };
  return {
    bind: () => bindPluginActions(context),
    installOperation,
    loadCatalog: (refresh) => loadPluginCatalog(context, refresh),
    refreshUpdates: () => refreshPluginUpdates(context),
    removeMarketplaceOperation,
    runMutation: (operation, busyLabel, button) =>
      runPluginMutation(context, operation, busyLabel, button),
    setUpdateActionVisibility: (visible) => setUpdateActionVisibility(context, visible),
    toggleOperation,
    uninstallOperation,
    updateAll: () => updateAllPlugins(context),
    updateOne: (pluginId) => updateOnePlugin(context, pluginId),
    updateOperation: pluginUpdateOperation,
  };
};
