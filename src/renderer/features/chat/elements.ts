import { requiredElement } from '../../platform/dom';

export interface ChatElements {
  chatActiveModel: HTMLElement;
  chatAttachmentInput: HTMLInputElement;
  chatAttachmentQueue: HTMLElement;
  chatAttachButton: HTMLButtonElement;
  chatAuthMode: HTMLSelectElement;
  chatBaseUrl: HTMLInputElement;
  chatClearCredential: HTMLInputElement;
  chatConfigForm: HTMLFormElement;
  chatConfigStatus: HTMLElement;
  chatConnectionTest: HTMLElement;
  chatContextTotal: HTMLElement;
  chatCredential: HTMLInputElement;
  chatCredentialStatus: HTMLElement;
  chatEmptyState: HTMLElement;
  chatHistoryCount: HTMLElement;
  chatHistoryEmpty: HTMLElement;
  chatHistoryList: HTMLElement;
  chatInput: HTMLTextAreaElement;
  chatModel: HTMLInputElement;
  chatProtocol: HTMLSelectElement;
  chatProvider: HTMLSelectElement;
  chatSettingsModeButton: HTMLButtonElement;
  chatBaseUrlField: HTMLElement;
  chatSettingsDialog: HTMLDialogElement;
  chatTokenUsage: HTMLElement;
  closeChatSettingsButton: HTMLButtonElement;
  newChatButton: HTMLButtonElement;
  openChatSettingsButton: HTMLButtonElement;
  saveChatConfigButton: HTMLButtonElement;
  sendChatButton: HTMLButtonElement;
  stopChatButton: HTMLButtonElement;
  testChatConnectionButton: HTMLButtonElement;
}

export const createChatElements = (): ChatElements => ({
  chatActiveModel: requiredElement<HTMLElement>('#chat-active-model'),
  chatAttachmentInput: requiredElement<HTMLInputElement>('#chat-attachment-input'),
  chatAttachmentQueue: requiredElement<HTMLElement>('#chat-attachment-queue'),
  chatAttachButton: requiredElement<HTMLButtonElement>('#chat-attach'),
  chatAuthMode: requiredElement<HTMLSelectElement>('#chat-auth-mode'),
  chatBaseUrl: requiredElement<HTMLInputElement>('#chat-base-url'),
  chatClearCredential: requiredElement<HTMLInputElement>('#chat-clear-credential'),
  chatConfigForm: requiredElement<HTMLFormElement>('#chat-config-form'),
  chatConfigStatus: requiredElement<HTMLElement>('#chat-config-status'),
  chatConnectionTest: requiredElement<HTMLElement>('#chat-connection-test'),
  chatContextTotal: requiredElement<HTMLElement>('#chat-context-total'),
  chatCredential: requiredElement<HTMLInputElement>('#chat-credential'),
  chatCredentialStatus: requiredElement<HTMLElement>('#chat-credential-status'),
  chatEmptyState: requiredElement<HTMLElement>('#chat-empty-state'),
  chatHistoryCount: requiredElement<HTMLElement>('#chat-history-count'),
  chatHistoryEmpty: requiredElement<HTMLElement>('#chat-history-empty'),
  chatHistoryList: requiredElement<HTMLElement>('#chat-history-list'),
  chatInput: requiredElement<HTMLTextAreaElement>('#chat-input'),
  chatModel: requiredElement<HTMLInputElement>('#chat-model'),
  chatProtocol: requiredElement<HTMLSelectElement>('#chat-protocol'),
  chatProvider: requiredElement<HTMLSelectElement>('#chat-provider'),
  chatSettingsModeButton: requiredElement<HTMLButtonElement>('#chat-settings-mode'),
  chatBaseUrlField: requiredElement<HTMLElement>('#chat-base-url-field'),
  chatSettingsDialog: requiredElement<HTMLDialogElement>('#chat-settings-dialog'),
  chatTokenUsage: requiredElement<HTMLElement>('#chat-token-usage'),
  closeChatSettingsButton: requiredElement<HTMLButtonElement>('#close-chat-settings'),
  newChatButton: requiredElement<HTMLButtonElement>('#new-chat'),
  openChatSettingsButton: requiredElement<HTMLButtonElement>('#open-chat-settings'),
  saveChatConfigButton: requiredElement<HTMLButtonElement>('#save-chat-config'),
  sendChatButton: requiredElement<HTMLButtonElement>('#send-chat'),
  stopChatButton: requiredElement<HTMLButtonElement>('#stop-chat'),
  testChatConnectionButton: requiredElement<HTMLButtonElement>('#test-chat-connection'),
});
