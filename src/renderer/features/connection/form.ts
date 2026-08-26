import type {
  ClaudeNextConversationConnectionState,
  ClaudePreset,
  ClaudeProjectState,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import { createAdvancedSnapshotApi, type AdvancedSnapshotApi } from './advanced-snapshot';
import { savedClaudeConfigInput } from './form-config-input';
import {
  claudeAuthMode,
  claudeBaseUrl,
  claudeConfigForm,
  claudeCredential,
  claudeModel,
  claudeModelFast,
  claudePreset,
  claudeProtocol,
  connectionAdvancedContent,
  connectionAdvice,
  connectionRemedyActions,
  credentialField,
  environmentSetup,
  providerPicker,
} from './form-elements';
import { createConnectionFormBindingsActions } from './form-bindings';
import type { ConnectionFormDeps } from './form-dependencies';
import { createConnectionFormConfigInputActions } from './form-config-input';
import { createConnectionFormPickerActions } from './form-picker';
import { createConnectionFormPopulateActions } from './form-populate';
import { createConnectionFormPresetActions } from './form-preset';
import { createConnectionFormProviderToolsActions } from './form-provider-tools';
import { createConnectionFormSaveActions } from './form-save';
import { createConnectionFormState } from './form-state';
import { createConnectionFormSyncActions } from './form-sync';
import { createConnectionFormWizardActions } from './form-wizard';
import { createStartupModelConnectionOverlay } from './startup-model-connection';

export type { ConnectionFormDeps } from './form-dependencies';

export interface ConnectionForm {
  readonly claudeAuthMode: HTMLSelectElement;
  readonly claudeBaseUrl: HTMLInputElement;
  readonly claudeConfigForm: HTMLFormElement;
  readonly claudeCredential: HTMLInputElement;
  readonly claudeModel: HTMLInputElement;
  readonly claudeModelFast: HTMLInputElement;
  readonly claudePreset: HTMLSelectElement;
  readonly connectionAdvice: HTMLElement;
  readonly connectionRemedyActions: HTMLElement;
  readonly credentialField: HTMLElement;
  readonly environmentSetup: HTMLElement;
  readonly providerPicker: HTMLElement;
  savedClaudeConfigInput: typeof savedClaudeConfigInput;
  setAuthOptions: (
    options: Array<{ label: string; value: SaveClaudeConfigInput['authMode'] }>,
    selected?: SaveClaudeConfigInput['authMode'],
  ) => void;
  syncApiKeyHelperPolicyUi: () => void;
  syncConnectionInteractivity: () => void;
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void;
  clearProviderSelection: (clearDraft?: boolean) => void;
  applyDefaultProviderGroupExpansion: (providerId?: ClaudeProviderId) => void;
  renderProviderPicker: () => void;
  applyNextClaudeConnection: (state: ClaudeNextConversationConnectionState) => void;
  getNextClaudeConnection: () => ClaudeNextConversationConnectionState;
  loadNextClaudeConnection: () => Promise<ClaudeNextConversationConnectionState>;
  showConnectionChoice: () => void;
  populateClaudeConfigForm: (state: ClaudeProjectState) => void;
  currentConfigInput: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => SaveClaudeConfigInput;
  completeVisibleConnectionEndpoint: (reportError: boolean) => void;
  saveClaudeConfig: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => Promise<boolean>;
  captureAdvancedConnectionSnapshot: AdvancedSnapshotApi['captureAdvancedConnectionSnapshot'];
  restoreAdvancedConnectionSnapshot: AdvancedSnapshotApi['restoreAdvancedConnectionSnapshot'];
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  getConfigFormSessionId: () => string;
  setConfigFormSessionId: (sessionId: string) => void;
  getConnectionEnvironmentReady: () => boolean;
  setConnectionEnvironmentReady: (ready: boolean) => void;
  getProviderGroupExpansionPending: () => boolean;
  setProviderGroupExpansionPending: (pending: boolean) => void;
  subscribeSelectedProvider: (
    listener: (providerId: ClaudeProviderId | undefined) => void,
  ) => () => void;
  unsubscribeManagedChatGptSetupProgress: () => void;
}

export const createConnectionForm = (deps: ConnectionFormDeps): ConnectionForm => {
  const formState = createConnectionFormState();
  let providerGroupExpansionPending = false;
  const selectedProviderListeners = new Set<(providerId: ClaudeProviderId | undefined) => void>();
  const notifySelectedProviderChanged = (): void => {
    for (const listener of selectedProviderListeners) listener(formState.selectedProviderId);
  };

  const syncActions = createConnectionFormSyncActions(deps, formState);
  const { setAuthOptions, syncApiKeyHelperPolicyUi, syncConnectionInteractivity } = syncActions;
  const configInputActions = createConnectionFormConfigInputActions(formState);
  const { currentConfigInput, completeVisibleConnectionEndpoint } = configInputActions;

  const providerToolsActions = createConnectionFormProviderToolsActions(
    deps,
    formState,
    () => pickerActions.renderProviderPicker(),
    syncConnectionInteractivity,
    (preset, preserveValues) => presetActions.applyPresetUi(preset, preserveValues),
    notifySelectedProviderChanged,
  );
  const { clearProviderSelection, moveProviderTools } = providerToolsActions;
  const presetActions = createConnectionFormPresetActions(
    formState,
    setAuthOptions,
    moveProviderTools,
    () => pickerActions.renderProviderPicker(),
    syncConnectionInteractivity,
    notifySelectedProviderChanged,
  );
  const { applyPresetUi } = presetActions;
  const pickerActions = createConnectionFormPickerActions(
    deps,
    formState,
    clearProviderSelection,
    applyPresetUi,
  );
  const { applyDefaultProviderGroupExpansion, renderProviderPicker } = pickerActions;
  const populateActions = createConnectionFormPopulateActions(
    formState,
    applyPresetUi,
    renderProviderPicker,
  );
  const { populateClaudeConfigForm, populateNextClaudeConfigForm } = populateActions;
  const applyNextClaudeConnectionState = (
    state: ClaudeNextConversationConnectionState,
    populateForm: boolean,
  ): ClaudeNextConversationConnectionState => {
    const normalized = state && typeof state === 'object' ? state : {};
    formState.nextConnection = normalized;
    if (populateForm) {
      if (normalized.config) {
        populateNextClaudeConfigForm(normalized);
      } else {
        clearProviderSelection(false);
      }
    } else {
      renderProviderPicker();
    }
    formState.renderWizard?.();
    deps.renderNextConnection();
    return normalized;
  };
  const applyNextClaudeConnection = (state: ClaudeNextConversationConnectionState): void => {
    applyNextClaudeConnectionState(state, true);
  };
  const loadNextClaudeConnection = async (): Promise<ClaudeNextConversationConnectionState> => {
    const selectedProviderAtRequest = formState.selectedProviderId;
    const nextConnection = (await window.controlPanel.getNextClaudeConnection()) ?? {};
    /* A late startup/read response must never erase a choice the user has already clicked. */
    applyNextClaudeConnectionState(
      nextConnection,
      formState.selectedProviderId === selectedProviderAtRequest,
    );
    try {
      const software = await window.controlPanel.getSoftwareUpdates();
      formState.connectionEnvironmentReady = software.claudeCode.installed;
    } catch {
      formState.connectionEnvironmentReady = false;
    }
    environmentSetup.hidden =
      formState.selectedProviderId === 'chatgpt-subscription' ||
      formState.connectionEnvironmentReady;
    syncConnectionInteractivity();
    return nextConnection;
  };
  const saveActions = createConnectionFormSaveActions(
    deps,
    currentConfigInput,
    applyNextClaudeConnection,
    () => formState.nextConnection,
  );
  const { saveClaudeConfig } = saveActions;
  const startupModelConnectionOverlay = createStartupModelConnectionOverlay({
    refreshConnection: loadNextClaudeConnection,
    showToast: deps.showToast,
  });
  void startupModelConnectionOverlay.initialize();

  const advancedSnapshot = createAdvancedSnapshotApi({
    applyPresetUi,
    claudeAuthMode,
    claudeBaseUrl,
    claudeCredential,
    claudeModel,
    claudeModelFast,
    claudeProtocol,
    clearProviderSelection,
    connectionAdvancedContent,
    credentialField,
    getSelectedProviderId: () => formState.selectedProviderId,
    getSelectedRouterProviderId: () => formState.selectedRouterProviderId,
    renderProviderPicker,
    setSelectedRouterProviderId: (providerId) => {
      formState.selectedRouterProviderId = providerId;
    },
    syncConnectionInteractivity,
  });

  const unsubscribeManagedChatGptSetupProgress = window.controlPanel.onManagedChatGptSetupProgress(
    (progress) => {
      formState.managedChatGptOperations.update(progress.sessionId, progress.active);
      formState.managedChatGptProgress = progress;
      formState.renderManagedChatGptProgress?.(progress);
      formState.renderWizard?.();
    },
  );

  const bindingsActions = createConnectionFormBindingsActions(
    deps,
    formState,
    applyPresetUi,
    completeVisibleConnectionEndpoint,
    syncApiKeyHelperPolicyUi,
    saveClaudeConfig,
  );
  bindingsActions.bindConnectionForm();
  const wizardActions = createConnectionFormWizardActions(deps, formState, applyPresetUi);
  formState.renderWizard = wizardActions.render;
  void loadNextClaudeConnection()
    .catch(() => undefined)
    .finally(() => {
      void wizardActions.initializeFromOnboarding().catch(() => wizardActions.render());
    });

  return {
    claudeAuthMode,
    claudeBaseUrl,
    claudeConfigForm,
    claudeCredential,
    claudeModel,
    claudeModelFast,
    claudePreset,
    connectionAdvice,
    connectionRemedyActions,
    credentialField,
    environmentSetup,
    providerPicker,
    savedClaudeConfigInput,
    setAuthOptions,
    syncApiKeyHelperPolicyUi,
    syncConnectionInteractivity,
    applyPresetUi,
    clearProviderSelection,
    applyDefaultProviderGroupExpansion,
    renderProviderPicker,
    applyNextClaudeConnection,
    getNextClaudeConnection: () => formState.nextConnection,
    loadNextClaudeConnection,
    showConnectionChoice: wizardActions.showChoice,
    populateClaudeConfigForm,
    currentConfigInput,
    completeVisibleConnectionEndpoint,
    saveClaudeConfig,
    captureAdvancedConnectionSnapshot: advancedSnapshot.captureAdvancedConnectionSnapshot,
    restoreAdvancedConnectionSnapshot: advancedSnapshot.restoreAdvancedConnectionSnapshot,
    getSelectedProviderId: () => formState.selectedProviderId,
    getConfigFormSessionId: () => formState.configFormSessionId,
    setConfigFormSessionId: (sessionId) => {
      formState.configFormSessionId = sessionId;
    },
    getConnectionEnvironmentReady: () => formState.connectionEnvironmentReady,
    setConnectionEnvironmentReady: (ready) => {
      formState.connectionEnvironmentReady = ready;
    },
    getProviderGroupExpansionPending: () => providerGroupExpansionPending,
    setProviderGroupExpansionPending: (pending) => {
      providerGroupExpansionPending = pending;
    },
    subscribeSelectedProvider: (listener) => {
      selectedProviderListeners.add(listener);
      listener(formState.selectedProviderId);
      return () => selectedProviderListeners.delete(listener);
    },
    unsubscribeManagedChatGptSetupProgress: () => {
      selectedProviderListeners.clear();
      startupModelConnectionOverlay.dispose();
      formState.renderWizard = undefined;
      wizardActions.dispose();
      unsubscribeManagedChatGptSetupProgress();
    },
  };
};
