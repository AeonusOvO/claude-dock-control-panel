import type { ClaudePluginCatalog } from '../../../shared/contracts';
import { createRegistryToken, type Registry } from '../../platform/registry';
import {
  createPluginsActions,
  type PluginsActions,
  type PluginsActionsDependencies,
} from './actions';
import { createPluginsElements } from './elements';
import { createPluginsState, pluginOperationInProgress } from './state';
import {
  createPluginsView,
  type PluginConfirmationRequest,
  type PluginsViewDependencies,
} from './view';

export type PluginsFeatureDependencies = PluginsActionsDependencies &
  Pick<PluginsViewDependencies, 'formatTokenCount' | 'openExternal'> & {
    requestConfirmation: (request: PluginConfirmationRequest) => Promise<boolean>;
  };

export interface PluginsFeature {
  dispose: () => void;
  getCatalog: () => ClaudePluginCatalog | undefined;
  isMutationInProgress: () => boolean;
  loadCatalog: (refresh: boolean) => Promise<void>;
  refreshUpdates: () => Promise<boolean>;
  setUpdateActionVisibility: (visible: boolean) => void;
  updateAll: () => Promise<void>;
  updateOne: (pluginId: string) => Promise<void>;
}

export const PLUGINS_FEATURE = createRegistryToken<PluginsFeature>('renderer.feature.plugins');

const createPluginsFeature = (dependencies: PluginsFeatureDependencies): PluginsFeature => {
  const elements = createPluginsElements();
  const state = createPluginsState();
  const actionsDelegate: { current?: PluginsActions } = {};
  const resolveActions = (): PluginsActions => {
    if (!actionsDelegate.current) {
      throw new Error('Plugins actions are not initialized.');
    }
    return actionsDelegate.current;
  };
  const view = createPluginsView(elements, state, {
    formatTokenCount: dependencies.formatTokenCount,
    installOperation: (plugin) => resolveActions().installOperation(plugin),
    openExternal: dependencies.openExternal,
    removeMarketplaceOperation: (marketplace) =>
      resolveActions().removeMarketplaceOperation(marketplace),
    requestConfirmation: dependencies.requestConfirmation,
    runMutation: (operation, busyLabel, button) => {
      void resolveActions().runMutation(operation, busyLabel, button);
    },
    syncUpdateActionVisibility: dependencies.syncUpdateActionVisibility,
    toggleOperation: (plugin) => resolveActions().toggleOperation(plugin),
    uninstallOperation: (plugin) => resolveActions().uninstallOperation(plugin),
    updateOperation: (plugin) => resolveActions().updateOperation(plugin),
  });
  const actions = createPluginsActions(elements, state, dependencies, view);
  actionsDelegate.current = actions;
  const dispose = actions.bind();

  return {
    dispose,
    getCatalog: () => state.catalog,
    isMutationInProgress: () => state.mutationInProgress || pluginOperationInProgress(state),
    loadCatalog: actions.loadCatalog,
    refreshUpdates: actions.refreshUpdates,
    setUpdateActionVisibility: actions.setUpdateActionVisibility,
    updateAll: actions.updateAll,
    updateOne: actions.updateOne,
  };
};

export const registerPluginsFeature = (
  registry: Registry,
  dependencies: PluginsFeatureDependencies,
): void => {
  registry.register(PLUGINS_FEATURE, () => createPluginsFeature(dependencies));
};
