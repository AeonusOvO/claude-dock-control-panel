import { requiredElement } from '../../platform/dom';

export interface SettingsElements {
  chatIdleTimeout: HTMLSelectElement;
  closeBehavior: HTMLSelectElement;
  conversationModelMismatch: HTMLSelectElement;
  restoreLastWorkspace: HTMLInputElement;
  language: HTMLSelectElement;
  launchAtLogin: HTMLInputElement;
  networkNewSession: HTMLInputElement;
  networkProviderLogin: HTMLInputElement;
  unsavedIndicator: HTMLElement;
  version: HTMLOutputElement;
  webResearchIsolation: HTMLInputElement;
}

export const createSettingsElements = (): SettingsElements => ({
  chatIdleTimeout: requiredElement('#settings-chat-idle-timeout'),
  closeBehavior: requiredElement('#settings-close-behavior'),
  conversationModelMismatch: requiredElement('#settings-conversation-model-mismatch'),
  language: requiredElement('#settings-language'),
  launchAtLogin: requiredElement('#settings-launch-at-login'),
  networkNewSession: requiredElement('#settings-network-new-session'),
  networkProviderLogin: requiredElement('#settings-network-provider-login'),
  restoreLastWorkspace: requiredElement('#settings-restore-last-workspace'),
  unsavedIndicator: requiredElement('#settings-unsaved-indicator'),
  version: requiredElement('#settings-version'),
  webResearchIsolation: requiredElement('#settings-web-research-isolation'),
});
