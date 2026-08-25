import type { WorkspaceState } from '../../../shared/contracts';
import { createRegistryToken, type Registry } from '../../platform/registry';
import { bindOnboardingActions } from './actions';
import { createOnboardingElements } from './elements';
import { scanOnboardingEnvironment } from './environment';
import {
  applyPersistedOnboarding,
  createOnboardingState,
  type OnboardingFeatureDependencies,
} from './state';
import { createOnboardingView } from './view';

export type { OnboardingFeatureDependencies } from './state';

export interface OnboardingFeature {
  dispose: () => void;
  initialize: () => Promise<void>;
  renderWorkspace: (workspace: WorkspaceState) => void;
}

export const ONBOARDING_FEATURE = createRegistryToken<OnboardingFeature>(
  'renderer.feature.onboarding',
);

const createOnboardingFeature = (
  dependencies: OnboardingFeatureDependencies,
): OnboardingFeature => {
  const elements = createOnboardingElements();
  const state = createOnboardingState();
  const view = createOnboardingView(elements, state, dependencies.reopenSettingsDialog);
  const disposeActions = bindOnboardingActions(elements, state, view, dependencies);

  return {
    dispose: () => {
      disposeActions();
      view.dispose();
    },
    initialize: async () => {
      state.workspace = dependencies.getWorkspaceState();
      const persisted = await window.controlPanel.getOnboardingState();
      applyPersistedOnboarding(state, persisted);
      view.render();
      if (persisted.status === 'pending' || persisted.status === 'in-progress') {
        view.open('first-run');
        if (persisted.currentStep === 'prepare') {
          void scanOnboardingEnvironment(elements, state);
        }
      }
    },
    renderWorkspace: (workspace) => {
      state.workspace = workspace;
      view.renderProject();
    },
  };
};

export const registerOnboardingFeature = (
  registry: Registry,
  dependencies: OnboardingFeatureDependencies,
): void => {
  registry.register(ONBOARDING_FEATURE, () => createOnboardingFeature(dependencies));
};
