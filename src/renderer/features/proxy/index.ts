import { createRegistryToken, type Registry } from '../../platform/registry';
import { createProxyActions, type ProxyActionsDependencies } from './actions';
import { createProxyElements } from './elements';
import { createProxyState } from './state';
import { createProxyView, type ProxyViewDependencies } from './view';

export type ProxyFeatureDependencies = ProxyActionsDependencies & ProxyViewDependencies;

export interface ProxyFeature {
  beginDialogLoad: () => number;
  completeDialogLoad: (loadGeneration: number, loaded: boolean) => boolean;
  dispose: () => void;
  endDialogSession: (restore: boolean) => void;
  isDirty: () => boolean;
  loadState: (preserveDirtyDraft?: boolean, loadGeneration?: number) => Promise<boolean>;
  savePending: () => Promise<boolean>;
}

export const PROXY_FEATURE = createRegistryToken<ProxyFeature>('renderer.feature.proxy');

const createProxyFeature = (dependencies: ProxyFeatureDependencies): ProxyFeature => {
  const elements = createProxyElements();
  const state = createProxyState();
  const view = createProxyView(elements, state, {
    isAdvancedConnectionDialogOpen: dependencies.isAdvancedConnectionDialogOpen,
    showToast: dependencies.showToast,
    updateSettingsUnsavedIndicator: dependencies.updateSettingsUnsavedIndicator,
  });
  const actions = createProxyActions(elements, state, dependencies, view);
  const dispose = actions.bind();

  return {
    beginDialogLoad: actions.beginDialogLoad,
    completeDialogLoad: actions.completeDialogLoad,
    dispose,
    endDialogSession: actions.endDialogSession,
    isDirty: view.isDirty,
    loadState: actions.loadState,
    savePending: actions.savePending,
  };
};

export const registerProxyFeature = (
  registry: Registry,
  dependencies: ProxyFeatureDependencies,
): void => {
  registry.register(PROXY_FEATURE, () => createProxyFeature(dependencies));
};
