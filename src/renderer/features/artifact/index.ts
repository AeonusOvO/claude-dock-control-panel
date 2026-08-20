import { createRegistryToken, type Registry } from '../../platform/registry';
import { createArtifactActions, type ArtifactActionsDependencies } from './actions';
import { createArtifactElements } from './elements';
import { createArtifactState } from './state';
import { createArtifactView, type ArtifactViewDependencies } from './view';

export type ArtifactFeatureDependencies = ArtifactActionsDependencies & ArtifactViewDependencies;

export interface ArtifactFeature {
  applyNetworkAllowed: (allowed: boolean) => void;
  dispose: () => void;
  hasActiveArtifacts: () => boolean;
  isDetailsOpen: () => boolean;
  renderNetworkLog: () => void;
  run: (html: string, mount: HTMLElement) => Promise<string>;
  setDetailsOpen: (open: boolean) => void;
  stopAll: () => void;
  updateTheme: () => void;
}

export const ARTIFACT_FEATURE = createRegistryToken<ArtifactFeature>('renderer.feature.artifact');

const createArtifactFeature = (dependencies: ArtifactFeatureDependencies): ArtifactFeature => {
  const elements = createArtifactElements();
  const state = createArtifactState();
  const view = createArtifactView(elements, state, {
    getActiveTheme: dependencies.getActiveTheme,
  });
  const actions = createArtifactActions(
    elements,
    state,
    {
      setChatInert: dependencies.setChatInert,
      showToast: dependencies.showToast,
    },
    view,
  );
  const disposeBindings = actions.bind();

  return {
    applyNetworkAllowed: (allowed) => {
      state.network.allowed = allowed;
    },
    dispose: () => {
      disposeBindings();
      actions.stopAll();
    },
    hasActiveArtifacts: actions.hasActiveArtifacts,
    isDetailsOpen: view.isDetailsOpen,
    renderNetworkLog: view.renderNetworkLog,
    run: actions.run,
    setDetailsOpen: actions.setDetailsOpen,
    stopAll: actions.stopAll,
    updateTheme: actions.updateTheme,
  };
};

export const registerArtifactFeature = (
  registry: Registry,
  dependencies: ArtifactFeatureDependencies,
): void => {
  registry.register(ARTIFACT_FEATURE, () => createArtifactFeature(dependencies));
};
