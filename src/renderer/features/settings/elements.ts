import { requiredElement } from '../../platform/dom';

export interface SettingsElements {
  autoLoadLastConversation: HTMLInputElement;
  autoLoadLastConversationModel: HTMLInputElement;
  startupModelConnectCancelAfter: HTMLInputElement;
  startupModelConnectForceStopAfter: HTMLInputElement;
  chatIdleTimeout: HTMLSelectElement;
  confirmFileDrops: HTMLInputElement;
  closeBehavior: HTMLSelectElement;
  conversationModelMismatch: HTMLSelectElement;
  language: HTMLSelectElement;
  launchAtLogin: HTMLInputElement;
  networkNewSession: HTMLInputElement;
  networkProviderLogin: HTMLInputElement;
  unsavedIndicator: HTMLElement;
  version: HTMLOutputElement;
  webResearchIsolation: HTMLInputElement;
}

export const createSettingsElements = (): SettingsElements => ({
  autoLoadLastConversation: requiredElement('#settings-auto-load-last-conversation'),
  autoLoadLastConversationModel: requiredElement('#settings-auto-load-last-conversation-model'),
  startupModelConnectCancelAfter: requiredElement('#settings-startup-model-connect-cancel-after'),
  startupModelConnectForceStopAfter: requiredElement(
    '#settings-startup-model-connect-force-stop-after',
  ),
  chatIdleTimeout: requiredElement('#settings-chat-idle-timeout'),
  confirmFileDrops: requiredElement('#settings-confirm-file-drops'),
  closeBehavior: requiredElement('#settings-close-behavior'),
  conversationModelMismatch: requiredElement('#settings-conversation-model-mismatch'),
  language: requiredElement('#settings-language'),
  launchAtLogin: requiredElement('#settings-launch-at-login'),
  networkNewSession: requiredElement('#settings-network-new-session'),
  networkProviderLogin: requiredElement('#settings-network-provider-login'),
  unsavedIndicator: requiredElement('#settings-unsaved-indicator'),
  version: requiredElement('#settings-version'),
  webResearchIsolation: requiredElement('#settings-web-research-isolation'),
});
