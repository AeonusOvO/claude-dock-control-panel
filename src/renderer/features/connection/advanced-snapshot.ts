import type { ClaudePreset, SaveClaudeConfigInput } from '../../../shared/contracts';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import type { ConfigurableEndpointProtocol } from '../../../shared/router/connection-endpoint';
import type { AdvancedConnectionSnapshot, AdvancedDraftControl } from './state';

export interface AdvancedSnapshotDependencies {
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void;
  claudeAuthMode: HTMLSelectElement;
  claudeBaseUrl: HTMLInputElement;
  claudeCredential: HTMLInputElement;
  claudeModel: HTMLInputElement;
  claudeModelFast: HTMLInputElement;
  claudeProtocol: HTMLSelectElement;
  clearProviderSelection: (clearDraft?: boolean) => void;
  connectionAdvancedContent: HTMLElement;
  credentialField: HTMLElement;
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  getSelectedRouterProviderId: () => string | undefined;
  renderProviderPicker: () => void;
  setSelectedRouterProviderId: (providerId: string | undefined) => void;
  syncConnectionInteractivity: () => void;
}

export interface AdvancedSnapshotApi {
  captureAdvancedConnectionSnapshot: () => AdvancedConnectionSnapshot;
  restoreAdvancedConnectionSnapshot: (snapshot: AdvancedConnectionSnapshot) => void;
}

export const createAdvancedSnapshotApi = (
  deps: AdvancedSnapshotDependencies,
): AdvancedSnapshotApi => {
  const {
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
    getSelectedProviderId,
    getSelectedRouterProviderId,
    renderProviderPicker,
    setSelectedRouterProviderId,
    syncConnectionInteractivity,
  } = deps;

  const captureAdvancedConnectionSnapshot = (): AdvancedConnectionSnapshot => ({
    authMode: claudeAuthMode.value as SaveClaudeConfigInput['authMode'],
    baseUrl: claudeBaseUrl.value,
    controls: [
      ...connectionAdvancedContent.querySelectorAll<AdvancedDraftControl>(
        'input, select, textarea',
      ),
    ].map((control) => ({
      checked: control instanceof HTMLInputElement ? control.checked : undefined,
      control,
      value: control.value,
    })),
    credential: claudeCredential.value,
    model: claudeModel.value,
    modelFast: claudeModelFast.value,
    protocol: claudeProtocol.value as ConfigurableEndpointProtocol,
    providerId: getSelectedProviderId(),
    routerProviderId: getSelectedRouterProviderId(),
  });

  const restoreAdvancedConnectionSnapshot = (snapshot: AdvancedConnectionSnapshot): void => {
    claudeProtocol.value = snapshot.protocol;
    if (snapshot.providerId) {
      applyPresetUi(snapshot.providerId, true);
    } else {
      clearProviderSelection(false);
    }
    claudeBaseUrl.value = snapshot.baseUrl;
    claudeModel.value = snapshot.model;
    claudeModelFast.value = snapshot.modelFast;
    setSelectedRouterProviderId(snapshot.routerProviderId);
    claudeAuthMode.value = snapshot.authMode;
    claudeCredential.value = snapshot.credential;
    credentialField.hidden =
      snapshot.authMode === 'existing' ||
      snapshot.authMode === 'none' ||
      snapshot.providerId === 'chatgpt-subscription' ||
      snapshot.providerId === 'ollama';
    for (const state of snapshot.controls) {
      state.control.value = state.value;
      if (state.control instanceof HTMLInputElement && state.checked !== undefined) {
        state.control.checked = state.checked;
      }
    }
    renderProviderPicker();
    syncConnectionInteractivity();
  };

  return {
    captureAdvancedConnectionSnapshot,
    restoreAdvancedConnectionSnapshot,
  };
};
