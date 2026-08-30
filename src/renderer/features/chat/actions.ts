import type { ChatAttachmentImportResult, SaveChatConfigInput } from '../../../shared/contracts';
import {
  createChatAttachmentImportActions,
  type ChatAttachmentImportCompletion,
} from './chat-attachment-import';
import { createChatAttachmentActions } from './chat-attachments';
import { createChatComposerBindings } from './chat-composer-bindings';
import { createChatConfigActions } from './chat-config';
import { createChatContinuationActions } from './chat-continuation';
import { createChatLifecycleActions } from './chat-lifecycle';
import { createChatSettingsBindings } from './chat-settings-bindings';
import { createChatStreamActions } from './chat-stream';
import { createChatStreamCompletionActions } from './chat-stream-completion';
import { createChatSubmitActions } from './chat-submit';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export type { ChatActionsDependencies };

export interface ChatActions {
  applyChatAttachmentImportResult: (result: ChatAttachmentImportResult) => void;
  bind: () => () => void;
  chatConfigInput: () => SaveChatConfigInput;
  focusChatInputAfterNavigation: () => void;
  hasActiveRequest: () => boolean;
  importChatAttachments: (files: File[]) => Promise<boolean>;
  loadChatConfig: (force?: boolean) => Promise<void>;
  persistActiveChat: () => Promise<void>;
  queueChatAttachmentImport: (
    files: File[],
    onComplete?: ChatAttachmentImportCompletion,
  ) => boolean;
  renderPendingChatAttachments: () => void;
  resetChatConversation: () => void;
  resizeChatComposer: () => void;
  setChatBusy: (busy: boolean) => void;
  submitChatMessage: () => Promise<void>;
}

export const createChatActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  view: ChatView,
  renderChatHistory: { current: () => void },
): ChatActions => {
  const attachmentActions = createChatAttachmentActions(elements, state, dependencies, view);
  const configActions = createChatConfigActions(elements, state, dependencies, view);
  const lifecycleActions = createChatLifecycleActions(
    elements,
    state,
    dependencies,
    view,
    renderChatHistory,
    configActions.resizeChatComposer,
    attachmentActions.renderPendingChatAttachments,
  );
  const attachmentImportActions = createChatAttachmentImportActions(
    elements,
    state,
    dependencies,
    lifecycleActions.setChatBusy,
    attachmentActions.applyChatAttachmentImportResult,
  );
  const submitActions = createChatSubmitActions(
    elements,
    state,
    dependencies,
    view,
    configActions.loadChatConfig,
    lifecycleActions.setChatBusy,
    configActions.resizeChatComposer,
    lifecycleActions.persistActiveChat,
    attachmentActions.renderPendingChatAttachments,
    lifecycleActions.finishChatRequest,
  );
  const continuationActions = createChatContinuationActions(
    elements,
    configActions.resizeChatComposer,
    submitActions.submitChatMessage,
  );
  const streamCompletionActions = createChatStreamCompletionActions(
    state,
    view,
    dependencies,
    lifecycleActions.persistActiveChat,
    lifecycleActions.finishChatRequest,
    continuationActions.appendChatContinuationButton,
  );
  const streamActions = createChatStreamActions(state, view, dependencies, streamCompletionActions);
  const settingsBindings = createChatSettingsBindings(
    elements,
    state,
    dependencies,
    view,
    configActions.chatConfigInput,
    configActions.loadChatConfig,
  );
  const composerBindings = createChatComposerBindings(
    elements,
    state,
    dependencies,
    view,
    configActions.resizeChatComposer,
    lifecycleActions.setChatBusy,
    attachmentImportActions.queueChatAttachmentImport,
    attachmentActions.applyChatAttachmentImportResult,
    streamActions.handleChatStream,
    lifecycleActions.resetChatConversation,
    submitActions.submitChatMessage,
  );

  const bind = (): (() => void) => {
    const disposeSettings = settingsBindings.bindChatSettings();
    const disposeComposer = composerBindings.bindChatComposer();
    return () => {
      disposeSettings();
      disposeComposer();
    };
  };

  return {
    applyChatAttachmentImportResult: attachmentActions.applyChatAttachmentImportResult,
    bind,
    chatConfigInput: configActions.chatConfigInput,
    focusChatInputAfterNavigation: configActions.focusChatInputAfterNavigation,
    hasActiveRequest: () => Boolean(state.activeChatRequestId),
    importChatAttachments: attachmentImportActions.importChatAttachments,
    loadChatConfig: configActions.loadChatConfig,
    persistActiveChat: lifecycleActions.persistActiveChat,
    queueChatAttachmentImport: attachmentImportActions.queueChatAttachmentImport,
    renderPendingChatAttachments: attachmentActions.renderPendingChatAttachments,
    resetChatConversation: lifecycleActions.resetChatConversation,
    resizeChatComposer: configActions.resizeChatComposer,
    setChatBusy: lifecycleActions.setChatBusy,
    submitChatMessage: submitActions.submitChatMessage,
  };
};
