import type { ApplicationUpdaterState, SoftwareUpdateState } from '../../../shared/contracts';
import { createRegistryToken, type Registry } from '../../platform/registry';
import {
  createUpdatesActions,
  type UpdatesActions,
  type UpdatesActionsDependencies,
} from './actions';
import { createUpdatesElements } from './elements';
import { createUpdatesState } from './state';
import { createUpdatesView, type UpdateCenterItem } from './view';

export interface UpdatesFeatureDependencies extends UpdatesActionsDependencies {
  applyRouterRelevance: (state: SoftwareUpdateState | undefined) => void;
  isPluginMutationInProgress: () => boolean;
  isRouterOperationInProgress: () => boolean;
  runPluginUpdate: (pluginId: string) => Promise<void>;
  setApplicationUpdaterState: (state: ApplicationUpdaterState) => void;
  setPluginUpdateActionVisibility: (visible: boolean) => void;
  setRouterUpdateAction: (visible: boolean, label: string) => void;
}

export interface UpdatesFeature {
  applyRouterRelevance: () => void;
  dispose: () => void;
  loadSoftwareUpdates: (refresh?: boolean) => Promise<void>;
  refreshAvailableUpdates: (manual: boolean) => Promise<void>;
  runClaudeInstallUpdate: () => Promise<void>;
  syncUpdateActionVisibility: () => void;
}

export const UPDATES_FEATURE = createRegistryToken<UpdatesFeature>('renderer.feature.updates');

const createUpdatesFeature = (dependencies: UpdatesFeatureDependencies): UpdatesFeature => {
  const elements = createUpdatesElements();
  const state = createUpdatesState();
  const actionsDelegate: { current?: UpdatesActions } = {};
  const resolveActions = (): UpdatesActions => {
    if (!actionsDelegate.current) {
      throw new Error('Updates actions are not initialized.');
    }
    return actionsDelegate.current;
  };
  const view = createUpdatesView(elements, state, {
    applyRouterRelevance: dependencies.applyRouterRelevance,
    getPluginCatalog: dependencies.getPluginCatalog,
    hasActiveProject: () => Boolean(dependencies.getActiveSessionId()),
    isPluginMutationInProgress: dependencies.isPluginMutationInProgress,
    isRouterOperationInProgress: dependencies.isRouterOperationInProgress,
    runApplicationUpdateAction: () => resolveActions().runApplicationUpdateAction(),
    runClaudeInstallUpdate: () => resolveActions().runClaudeInstallUpdate(),
    runPluginUpdate: dependencies.runPluginUpdate,
    runRouterUpdate: dependencies.runRouterUpdate,
    runUpdateCenterAction: (item: UpdateCenterItem) => resolveActions().runUpdateCenterAction(item),
    setApplicationUpdaterState: dependencies.setApplicationUpdaterState,
    setPluginUpdateActionVisibility: dependencies.setPluginUpdateActionVisibility,
    setRouterUpdateAction: dependencies.setRouterUpdateAction,
  });
  const actions = createUpdatesActions(elements, state, dependencies, view);
  actionsDelegate.current = actions;
  const dispose = actions.bind();

  return {
    applyRouterRelevance: view.applyRouterRelevance,
    dispose,
    loadSoftwareUpdates: actions.loadSoftwareUpdates,
    refreshAvailableUpdates: actions.refreshAvailableUpdates,
    runClaudeInstallUpdate: actions.runClaudeInstallUpdate,
    syncUpdateActionVisibility: view.syncUpdateActionVisibility,
  };
};

export const registerUpdatesFeature = (
  registry: Registry,
  dependencies: UpdatesFeatureDependencies,
): void => {
  registry.register(UPDATES_FEATURE, () => createUpdatesFeature(dependencies));
};
