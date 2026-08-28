import type {
  ClaudeConfigView,
  ClaudeNextConversationConnectionState,
  ClaudePreset,
  ClaudeProjectState,
} from '../../../shared/contracts';
import { findClaudeProvider } from '../../../shared/claude/providers';
import { resolveConnectionAddress } from './form-config-input';
import {
  claudeApiKeyHelperPolicy,
  claudeAuthMode,
  claudeBaseUrl,
  claudeCredential,
  claudeModel,
  claudeModelFast,
  claudePreset,
  claudeProtocol,
  clearCredentialButton,
  credentialField,
  credentialStatus,
} from './form-elements';
import type { ConnectionFormState } from './form-state';

export interface ConnectionFormPopulateActions {
  populateClaudeConfigForm: (state: ClaudeProjectState) => void;
  populateNextClaudeConfigForm: (state: ClaudeNextConversationConnectionState) => void;
}

export const createConnectionFormPopulateActions = (
  formState: ConnectionFormState,
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void,
  renderProviderPicker: () => void,
): ConnectionFormPopulateActions => {
  const populateConfig = (config: ClaudeConfigView, sessionId: string): void => {
    if (!claudePreset.querySelector(`option[value="${config.preset}"]`)) {
      const option = document.createElement('option');
      option.value = config.preset;
      option.textContent = findClaudeProvider(config.preset)?.label ?? config.preset;
      claudePreset.append(option);
    }
    claudePreset.value = config.preset;
    claudeProtocol.value = config.protocol === 'openai' ? 'openai' : 'anthropic';
    claudeApiKeyHelperPolicy.value = config.apiKeyHelperPolicy;
    applyPresetUi(config.preset, true);
    const displayedBaseUrl = config.sourceBaseUrl ?? config.baseUrl;
    claudeBaseUrl.value = displayedBaseUrl;
    if (config.preset === 'custom' && displayedBaseUrl) {
      try {
        claudeBaseUrl.value = resolveConnectionAddress(
          displayedBaseUrl,
          config.protocol === 'openai' ? 'openai' : 'anthropic',
        );
      } catch {
        // Keep a manually edited legacy value visible so the user can repair it in the form.
      }
    }
    claudeModel.value = config.sourceModel ?? config.model;
    claudeModelFast.value =
      config.sourceModelFast ?? config.sourceModel ?? config.modelFast ?? config.model;
    claudeAuthMode.value = config.sourceAuthMode ?? config.authMode;
    credentialField.hidden =
      config.preset === 'chatgpt-subscription' ||
      claudeAuthMode.value === 'existing' ||
      claudeAuthMode.value === 'none';
    if (config.preset === 'ollama') {
      credentialField.hidden = true;
    }
    claudeCredential.value = '';
    const credentialConfigured = config.sourceCredentialConfigured ?? config.credentialConfigured;
    credentialStatus.textContent = credentialConfigured ? '已保存，留空继续使用' : '尚未保存密钥';
    clearCredentialButton.disabled = !credentialConfigured;
    formState.selectedRouterProviderId = config.routerProviderId;
    formState.configFormSessionId = sessionId;
    renderProviderPicker();
  };

  const populateClaudeConfigForm = (state: ClaudeProjectState): void => {
    populateConfig(state.config, state.sessionId);
  };

  const populateNextClaudeConfigForm = (state: ClaudeNextConversationConnectionState): void => {
    if (!state.config) return;
    populateConfig(state.config, '');
  };

  return {
    populateClaudeConfigForm,
    populateNextClaudeConfigForm,
  };
};
