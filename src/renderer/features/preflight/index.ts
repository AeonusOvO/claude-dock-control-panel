import type {
  NetworkPreflightPreferences,
  NetworkPreflightResult,
  NetworkProviderId,
} from '../../../shared/contracts';
import { automaticNetworkPreflightEnabled } from '../../../shared/network-preflight-policy';
import { createRegistryToken, type Registry } from '../../platform/registry';
import {
  createPreflightActions,
  type PreflightActions,
  type PreflightActionsDependencies,
} from './actions';
import { createPreflightElements } from './elements';
import { createPreflightState } from './state';
import { createPreflightView, type CodexFooterConnectionView } from './view';

export interface PreflightFeatureDependencies extends PreflightActionsDependencies {
  setCodexFooterConnection: (view: CodexFooterConnectionView) => void;
}

export interface PreflightFeature {
  dispose: () => void;
  getActiveProvider: () => NetworkProviderId | undefined;
  getResult: (provider: NetworkProviderId) => NetworkPreflightResult | undefined;
  hasActiveResult: () => boolean;
  hasResult: (provider: NetworkProviderId) => boolean;
  invalidateAndRun: (reason: string, force?: boolean) => Promise<void>;
  isBlocked: (provider: NetworkProviderId) => boolean;
  openNetworkPreflightDialog: (providerOverride?: NetworkProviderId) => Promise<void>;
  refreshAfterAuthoritativeChange: () => Promise<void>;
  renderActiveNetworkPreflight: () => void;
  runActiveNetworkPreflight: (
    force: boolean,
    providerOverride?: NetworkProviderId,
  ) => Promise<void>;
  setPreferences: (preferences: NetworkPreflightPreferences) => void;
}

export const PREFLIGHT_FEATURE = createRegistryToken<PreflightFeature>(
  'renderer.feature.preflight',
);

const createPreflightFeature = (dependencies: PreflightFeatureDependencies): PreflightFeature => {
  const elements = createPreflightElements();
  const state = createPreflightState();
  const actionsDelegate: { current?: PreflightActions } = {};
  const resolveActions = (): PreflightActions => {
    if (!actionsDelegate.current) {
      throw new Error('Preflight actions are not initialized.');
    }
    return actionsDelegate.current;
  };
  const view = createPreflightView(elements, state, {
    getActiveNetworkProvider: () => resolveActions().activeNetworkProvider(),
    isCodexActive: () => dependencies.getActiveDevelopmentRuntime() === 'codex',
    setCodexFooterConnection: dependencies.setCodexFooterConnection,
  });
  const actions = createPreflightActions(elements, state, dependencies, view);
  actionsDelegate.current = actions;
  const dispose = actions.bind();
  const getActiveProvider = actions.activeNetworkProvider;

  return {
    dispose,
    getActiveProvider,
    getResult: (provider) => state.networkPreflightResults.get(provider),
    hasActiveResult: () => {
      const provider = getActiveProvider();
      return Boolean(provider && state.networkPreflightResults.has(provider));
    },
    hasResult: (provider) => state.networkPreflightResults.has(provider),
    invalidateAndRun: actions.invalidateAndRun,
    isBlocked: (provider) =>
      automaticNetworkPreflightEnabled(state.networkPreflightPreferences, 'cli-launch') &&
      state.networkPreflightResults.get(provider)?.providerConnectivity.status === 'blocked',
    openNetworkPreflightDialog: actions.openNetworkPreflightDialog,
    refreshAfterAuthoritativeChange: actions.refreshAfterAuthoritativeChange,
    renderActiveNetworkPreflight: view.renderActiveNetworkPreflight,
    runActiveNetworkPreflight: actions.runActiveNetworkPreflight,
    setPreferences: actions.setPreferences,
  };
};

export const registerPreflightFeature = (
  registry: Registry,
  dependencies: PreflightFeatureDependencies,
): void => {
  registry.register(PREFLIGHT_FEATURE, () => createPreflightFeature(dependencies));
};
