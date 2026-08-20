import { requiredElement } from '../../platform/dom';

export interface ConversationElements {
  nativeAttachButton: HTMLButtonElement;
  nativeAttachmentInput: HTMLInputElement;
  nativeAttachmentQueue: HTMLElement;
  nativeComposer: HTMLFormElement;
  nativeComposerInput: HTMLTextAreaElement;
  nativeComposerStatus: HTMLElement;
  nativeConversation: HTMLElement;
  nativeConversationEmpty: HTMLElement;
  nativeConversationMessages: HTMLElement;
  nativeInteractionStack: HTMLElement;
  nativePlanApprove: HTMLButtonElement;
  nativePlanClose: HTMLButtonElement;
  nativePlanContinue: HTMLButtonElement;
  nativePlanContent: HTMLElement;
  nativePlanDialog: HTMLDialogElement;
  nativePlanTitle: HTMLElement;
  nativeQueued: HTMLElement;
  nativeQueuedCancel: HTMLButtonElement;
  nativeQueuedHint: HTMLElement;
  nativeQueuedSend: HTMLButtonElement;
  nativeQueuedText: HTMLElement;
  nativeRecoveryStack: HTMLElement;
  nativeSendButton: HTMLButtonElement;
  nativeTerminalToggle: HTMLButtonElement;
  nativeTerminalToggleLabel: HTMLElement;
}

export const createConversationElements = (): ConversationElements => ({
  nativeAttachButton: requiredElement<HTMLButtonElement>('#native-attach'),
  nativeAttachmentInput: requiredElement<HTMLInputElement>('#native-attachment-input'),
  nativeAttachmentQueue: requiredElement<HTMLElement>('#native-attachment-queue'),
  nativeComposer: requiredElement<HTMLFormElement>('#native-composer'),
  nativeComposerInput: requiredElement<HTMLTextAreaElement>('#native-composer-input'),
  nativeComposerStatus: requiredElement<HTMLElement>('#native-composer-status'),
  nativeConversation: requiredElement<HTMLElement>('#native-conversation'),
  nativeConversationEmpty: requiredElement<HTMLElement>('#native-conversation-empty'),
  nativeConversationMessages: requiredElement<HTMLElement>('#native-conversation-messages'),
  nativeInteractionStack: requiredElement<HTMLElement>('#native-interaction-stack'),
  nativePlanApprove: requiredElement<HTMLButtonElement>('#native-plan-approve'),
  nativePlanClose: requiredElement<HTMLButtonElement>('#native-plan-close'),
  nativePlanContinue: requiredElement<HTMLButtonElement>('#native-plan-continue'),
  nativePlanContent: requiredElement<HTMLElement>('#native-plan-content'),
  nativePlanDialog: requiredElement<HTMLDialogElement>('#native-plan-dialog'),
  nativePlanTitle: requiredElement<HTMLElement>('#native-plan-title'),
  nativeQueued: requiredElement<HTMLElement>('#native-queued'),
  nativeQueuedCancel: requiredElement<HTMLButtonElement>('#native-queued-cancel'),
  nativeQueuedHint: requiredElement<HTMLElement>('#native-queued-hint'),
  nativeQueuedSend: requiredElement<HTMLButtonElement>('#native-queued-send'),
  nativeQueuedText: requiredElement<HTMLElement>('#native-queued-text'),
  nativeRecoveryStack: requiredElement<HTMLElement>('#native-recovery-stack'),
  nativeSendButton: requiredElement<HTMLButtonElement>('#native-send'),
  nativeTerminalToggle: requiredElement<HTMLButtonElement>('#native-terminal-toggle'),
  nativeTerminalToggleLabel: requiredElement<HTMLElement>('#native-terminal-toggle-label'),
});
