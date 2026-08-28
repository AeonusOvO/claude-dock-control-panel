import type { ClaudePreset, SaveClaudeConfigInput } from '../../../shared/contracts';
import {
  claudeApiKeyHelperPolicy,
  claudeAuthMode,
  claudeBaseUrl,
  claudeConfigForm,
  claudeCredential,
  claudeModel,
  claudeModelFast,
  claudePreset,
  claudeProtocol,
  clearCredentialButton,
  credentialField,
  connectionSettingsModeButton,
  openProviderConsoleButton,
  openProviderDocsButton,
  saveClaudeConfigButton,
} from './form-elements';
import type { ConnectionFormDeps } from './form-dependencies';
import type { ConnectionFormState } from './form-state';
import { findClaudeProvider } from '../../../shared/claude/providers';
import { sameConnectionCredentialScope } from '../../../shared/router/automatic-connection';

export interface ConnectionFormBindingsActions {
  bindConnectionForm: () => void;
}

export const createConnectionFormBindingsActions = (
  deps: ConnectionFormDeps,
  formState: ConnectionFormState,
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void,
  completeVisibleConnectionEndpoint: (reportError: boolean) => void,
  syncApiKeyHelperPolicyUi: () => void,
  saveClaudeConfig: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => Promise<boolean>,
): ConnectionFormBindingsActions => {
  const { runGuarded, requestConfirmation, openExternal, connectionFeature } = deps;

  const bindConnectionForm = (): void => {
    connectionSettingsModeButton.addEventListener('click', () => {
      const provider = findClaudeProvider(claudePreset.value);
      if (
        formState.advancedSettings &&
        provider &&
        !provider.editableBaseUrl &&
        provider.baseUrl &&
        !sameConnectionCredentialScope(claudeBaseUrl.value, provider.baseUrl)
      ) {
        claudePreset.value = 'custom';
        formState.selectedRouterProviderId = undefined;
      }
      formState.advancedSettings = !formState.advancedSettings;
      applyPresetUi(claudePreset.value as ClaudePreset, true);
      claudeBaseUrl.setCustomValidity('');
      connectionFeature.clearTestResult();
    });
    claudePreset.addEventListener('change', () => {
      formState.selectedRouterProviderId = undefined;
      applyPresetUi(claudePreset.value as ClaudePreset, false);
      connectionFeature.clearTestResult();
    });
    claudeProtocol.addEventListener('change', () => {
      completeVisibleConnectionEndpoint(false);
      applyPresetUi(claudePreset.value as ClaudePreset, true);
      connectionFeature.clearTestResult();
    });
    claudeBaseUrl.addEventListener('blur', () => {
      completeVisibleConnectionEndpoint(true);
    });
    claudeAuthMode.addEventListener('change', () => {
      credentialField.hidden =
        formState.selectedProviderId === 'chatgpt-subscription' ||
        claudeAuthMode.value === 'existing' ||
        claudeAuthMode.value === 'none';
      connectionFeature.clearTestResult();
      syncApiKeyHelperPolicyUi();
    });
    claudeApiKeyHelperPolicy.addEventListener('change', () => {
      connectionFeature.clearTestResult();
      syncApiKeyHelperPolicyUi();
    });
    for (const button of [openProviderConsoleButton, openProviderDocsButton]) {
      button.addEventListener('click', () => {
        const url = button.dataset.externalUrl;
        if (url) {
          void runGuarded(button, '正在打开…', () => openExternal(url));
        }
      });
    }
    claudeConfigForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void connectionFeature.runConnectionTest(true);
    });
    saveClaudeConfigButton.addEventListener('click', () => {
      void saveClaudeConfig('keep');
    });
    clearCredentialButton.addEventListener('click', async () => {
      if (
        await requestConfirmation({
          confirmLabel: '清除凭据',
          message: '清除当前连接已保存的接口凭据？',
          title: '清除接口凭据',
          tone: 'danger',
        })
      ) {
        void saveClaudeConfig('clear');
      }
    });
    for (const field of [claudeBaseUrl, claudeModel, claudeModelFast, claudeCredential]) {
      field.addEventListener('input', () => {
        if (field === claudeBaseUrl) {
          claudeBaseUrl.setCustomValidity('');
        }
        connectionFeature.clearTestResult();
      });
    }
  };

  return {
    bindConnectionForm,
  };
};
