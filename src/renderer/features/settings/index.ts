import { createRegistryToken, type Registry } from '../../platform/registry';
import { createSettingsActions, type SettingsActionsDependencies } from './actions';
import { createSettingsElements } from './elements';
import { createSettingsState, type SettingsTab } from './state';
import { createSettingsView, type SettingsViewDependencies } from './view';

export type SettingsFeatureDependencies = SettingsActionsDependencies & SettingsViewDependencies;

export interface SettingsFeature {
  dispose: () => void;
  endDialogSession: (restore: boolean) => void;
  getSelectedTab: () => SettingsTab;
  loadAppSettings: () => Promise<void>;
  savePending: () => Promise<void>;
  selectTab: (tab: SettingsTab) => void;
  setCloseBehaviorValue: (value: string) => void;
  updateUnsavedIndicator: () => number;
}

export const SETTINGS_FEATURE = createRegistryToken<SettingsFeature>('renderer.feature.settings');

const createSettingsFeature = (dependencies: SettingsFeatureDependencies): SettingsFeature => {
  const elements = createSettingsElements();
  const state = createSettingsState();
  const view = createSettingsView(elements, state, dependencies);
  const actions = createSettingsActions(elements, state, dependencies, view);
  const disposeBindings = actions.bind();

  return {
    endDialogSession: actions.endDialogSession,
    getSelectedTab: () => state.selectedTab,
    loadAppSettings: actions.loadAppSettings,
    savePending: actions.savePending,
    selectTab: view.selectTab,
    setCloseBehaviorValue: view.setCloseBehaviorValue,
    updateUnsavedIndicator: view.updateUnsavedIndicator,
    dispose: () => {
      disposeBindings();
      dependencies.disposeClaudeExecutionSettings();
    },
  };
};

export const registerSettingsFeature = (
  registry: Registry,
  dependencies: SettingsFeatureDependencies,
): void => {
  registry.register(SETTINGS_FEATURE, () => createSettingsFeature(dependencies));
};
