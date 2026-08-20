import type {
  ClaudePluginMarketplaceView,
  ClaudePluginOperationResult,
  ClaudePluginView,
} from '../../../shared/contracts';
import type { PluginsElements } from './elements';
import type { PluginsState } from './state';
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
  ) => Promise<void>;
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
): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.mutationInProgress) {
    return;
  }
  state.mutationInProgress = true;
  const originalLabel = button.textContent;
  button.textContent = busyLabel;
  button.disabled = true;
  elements.status.textContent = `${busyLabel}这一步会调用 claude 命令行，可能需要几十秒。`;
  try {
    const result = await operation();
    /*
     * The flag has to be cleared *before* the catalogue is re-rendered. Rendering replaces every card,
     * and each freshly built button takes its initial `disabled` from this flag — so clearing it
     * afterwards left the whole panel dead until the tab was reopened and reloaded the catalogue.
     */
    state.mutationInProgress = false;
    view.renderCatalog(result.catalog);
    dependencies.showToast(
      result.ok ? result.message : dependencies.resultFailureMessage(result, result.message),
      result.ok ? 'success' : 'error',
    );
  } catch {
    dependencies.showToast('插件操作发生异常。', 'error');
  } finally {
    state.mutationInProgress = false;
    // On the success path the button was discarded by the re-render; only the failure path still owns it.
    if (button.isConnected) {
      button.textContent = originalLabel;
      button.disabled = false;
    }
  }
};

const loadPluginCatalog = (context: PluginsActionsContext, refresh: boolean): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  if (state.loadPromise) {
    return state.loadPromise;
  }
  if (state.mutationInProgress) {
    return Promise.resolve();
  }
  state.loadPromise = (async () => {
    elements.updateAllButton.disabled = true;
    if (refresh || !state.catalog) {
      elements.status.textContent = '正在读取插件列表…';
    }
    try {
      view.renderCatalog(await window.controlPanel.getClaudePlugins(refresh));
    } catch {
      elements.status.textContent = '无法读取插件列表；请确认已安装 Claude Code 命令行。';
    } finally {
      state.loadPromise = undefined;
      elements.updateAllButton.disabled =
        !state.catalog?.cliAvailable || state.catalog.updatesAvailable === 0;
      dependencies.syncUpdateActionVisibility();
    }
  })();
  return state.loadPromise;
};

const refreshPluginUpdates = async (context: PluginsActionsContext): Promise<boolean> => {
  const { dependencies, elements, state, view } = context;
  if (state.loadPromise) {
    await state.loadPromise;
  }
  if (state.mutationInProgress) {
    return false;
  }

  state.mutationInProgress = true;
  elements.status.textContent = '正在刷新插件市场并检查更新…';
  if (state.catalog) {
    view.renderCatalog(state.catalog);
  }
  try {
    const result = await window.controlPanel.refreshClaudePluginMarketplaces();
    view.renderCatalog(result.catalog);
    if (!result.ok) {
      elements.status.textContent = dependencies.resultFailureMessage(result, result.message);
    }
    return result.ok;
  } catch {
    elements.status.textContent = '无法刷新插件市场；请确认网络与 Claude Code 命令行可用。';
    return false;
  } finally {
    state.mutationInProgress = false;
    if (state.catalog) {
      view.renderCatalog(state.catalog);
    }
  }
};

const updateAllPlugins = (context: PluginsActionsContext): Promise<void> =>
  runPluginMutation(
    context,
    () => window.controlPanel.updateAllClaudePlugins(),
    '正在更新…',
    context.elements.updateAllButton,
  );

const updateOnePlugin = (context: PluginsActionsContext, pluginId: string): Promise<void> =>
  runPluginMutation(
    context,
    () => window.controlPanel.updateClaudePlugin(pluginId),
    '正在更新…',
    context.elements.updateAllButton,
  );

const setUpdateActionVisibility = (context: PluginsActionsContext, visible: boolean): void => {
  context.elements.updateActions.hidden = false;
  context.elements.updateAllButton.hidden = !visible;
};

const bindPluginActions = (context: PluginsActionsContext): (() => void) => {
  const { elements, view } = context;
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
    elements.refreshButton.disabled = true;
    void refreshPluginUpdates(context).finally(() => {
      elements.refreshButton.disabled = false;
    });
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
    ).then(() => {
      elements.marketplaceSource.value = '';
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
