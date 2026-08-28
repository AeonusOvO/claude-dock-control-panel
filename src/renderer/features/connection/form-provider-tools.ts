import type { ClaudePreset } from '../../../shared/contracts';
import { isSubscriptionProvider } from '../../../shared/claude/subscriptions';
import { buildSubscriptionGuide } from './subscription-guide';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import { createChatGptSubscriptionGuide } from './chatgpt-guide';
import {
  claudeConfigForm,
  claudeCredential,
  claudePreset,
  connectionAdvancedContent,
  connectionAdvice,
  connectionGlossary,
  converterHelp,
  curlOnboarding,
  gatewayDiscoverySection,
  providerSetup,
  providerSpecialSetup,
} from './form-elements';
import type { ConnectionFormDeps } from './form-dependencies';
import type { ConnectionFormState } from './form-state';

export interface ConnectionFormProviderToolsActions {
  moveProviderTools: (providerId?: ClaudeProviderId) => void;
  clearProviderSelection: (clearDraft?: boolean) => void;
}

export const createConnectionFormProviderToolsActions = (
  deps: ConnectionFormDeps,
  formState: ConnectionFormState,
  renderProviderPicker: () => void,
  syncConnectionInteractivity: () => void,
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void,
  notifySelectedProviderChanged: () => void,
): ConnectionFormProviderToolsActions => {
  const { showToast, connectionFeature } = deps;

  const buildChatGptSubscriptionGuide = createChatGptSubscriptionGuide({
    connectionSucceeded: () => formState.connectionSucceeded?.(),
    applyNextClaudeConnection: (state) => {
      formState.nextConnectionRevision += 1;
      formState.nextConnection = state;
      deps.renderNextConnection();
    },
    getNextClaudeConnection: () => formState.nextConnection,
    managedChatGptOperations: formState.managedChatGptOperations,
    setRenderManagedChatGptProgress: (renderer) => {
      formState.renderManagedChatGptProgress = renderer;
    },
    getSelectedProviderId: () => formState.selectedProviderId,
    claudeConfigForm,
    applyPresetUi: (preset, preserveValues) => applyPresetUi(preset, preserveValues),
    showToast,
  });

  const moveProviderTools = (providerId?: ClaudeProviderId): void => {
    formState.renderManagedChatGptProgress = undefined;
    formState.renderSubscription = undefined;
    providerSpecialSetup.replaceChildren();
    connectionAdvancedContent.append(
      connectionAdvice,
      gatewayDiscoverySection,
      curlOnboarding,
      converterHelp,
      connectionGlossary,
    );
    if (isSubscriptionProvider(providerId)) {
      providerSpecialSetup.append(buildSubscriptionGuide(formState, providerId, applyPresetUi));
      return;
    }
    if (providerId === 'chatgpt-subscription') {
      providerSpecialSetup.append(buildChatGptSubscriptionGuide());
      return;
    }
    if (providerId === 'curl') {
      providerSpecialSetup.append(curlOnboarding);
      return;
    }
    if (providerId === 'gateway') {
      providerSpecialSetup.append(gatewayDiscoverySection);
    }
  };

  const clearProviderSelection = (clearDraft = true): void => {
    formState.selectedProviderId = undefined;
    formState.selectedRouterProviderId = undefined;
    claudePreset.value = '';
    providerSetup.hidden = true;
    claudeConfigForm.hidden = true;
    connectionFeature.clearTestResult();
    if (clearDraft) {
      claudeCredential.value = '';
    }
    moveProviderTools();
    renderProviderPicker();
    syncConnectionInteractivity();
    notifySelectedProviderChanged();
  };

  return {
    moveProviderTools,
    clearProviderSelection,
  };
};
