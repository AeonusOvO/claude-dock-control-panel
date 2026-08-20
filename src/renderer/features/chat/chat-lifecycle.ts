import { estimateChatUsage } from '../../../shared/conversation/chat-usage';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatLifecycleActions {
  finishChatRequest: () => void;
  persistActiveChat: () => Promise<void>;
  resetChatConversation: () => void;
  setChatBusy: (busy: boolean) => void;
}

export const createChatLifecycleActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  view: ChatView,
  renderChatHistory: { current: () => void },
  resizeChatComposer: () => void,
  renderPendingChatAttachments: () => void,
): ChatLifecycleActions => {
  const setChatBusy = (busy: boolean): void => {
    const preparing = state.queuedChatAttachmentImports > 0 || state.chatSubmissionInFlight;
    const protectsConversation = busy || preparing;
    if (protectsConversation !== state.conversationBusyLeaseActive) {
      state.conversationBusyLeaseActive = protectsConversation;
      void window.controlPanel.setConversationBusy(protectsConversation).catch(() => {
        state.conversationBusyLeaseActive = !protectsConversation;
      });
    }
    elements.chatInput.disabled = busy;
    elements.chatAttachButton.disabled = busy || preparing;
    elements.sendChatButton.disabled = busy || preparing;
    elements.stopChatButton.hidden = !busy;
    elements.newChatButton.disabled = busy || preparing;
    elements.testChatConnectionButton.disabled = busy || preparing;
    dependencies.chatComposer.setAttribute('aria-busy', String(busy || preparing));
    renderChatHistory.current();
  };

  const finishChatRequest = (): void => {
    state.activeChatReplyStream?.destroy();
    state.activeChatRequestId = '';
    state.activeChatReply = '';
    state.activeChatReplyElement = undefined;
    state.activeChatReplyStream = undefined;
    state.activeChatIdleNoticeElement = undefined;
    state.activeChatThinking = '';
    state.activeChatThinkingElement = undefined;
    state.activeChatRequestMessages = [];
    setChatBusy(false);
    elements.chatInput.focus();
  };

  const persistActiveChat = async (): Promise<void> => {
    if (state.chatMessages.length === 0) {
      return;
    }
    try {
      const saved = await window.controlPanel.saveChatConversation({
        conversationId: state.activeChatConversationId,
        messages: [...state.chatMessages],
        usage: { ...state.activeChatUsage },
      });
      state.activeChatConversationId = saved.id;
      state.chatConversations = [
        saved,
        ...state.chatConversations.filter((conversation) => conversation.id !== saved.id),
      ];
      renderChatHistory.current();
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '消息已发送，但本机对话历史保存失败。',
        'error',
      );
    }
  };

  const resetChatConversation = (): void => {
    state.activeChatReplyStream?.destroy();
    state.activeChatReplyStream = undefined;
    state.activeChatThinking = '';
    state.activeChatThinkingElement = undefined;
    dependencies.stopArtifacts();
    state.activeChatConversationId = undefined;
    state.chatMessages.splice(0);
    state.activeChatUsage = estimateChatUsage([]);
    state.activeChatProviderUsage = undefined;
    state.activeChatRequestMessages = [];
    dependencies.chatMessagesElement.replaceChildren(elements.chatEmptyState);
    elements.chatEmptyState.hidden = false;
    elements.chatInput.value = '';
    resizeChatComposer();
    const discardedDraftId = state.activeChatAttachmentDraftId;
    state.activeChatAttachmentDraftId = undefined;
    state.pendingChatAttachments.splice(0);
    if (discardedDraftId) {
      void window.controlPanel.releaseChatAttachmentDraft(discardedDraftId).catch((error) => {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法清理未发送的附件草稿。',
          'error',
        );
      });
    }
    renderPendingChatAttachments();
    view.renderChatUsage();
    renderChatHistory.current();
  };

  return {
    finishChatRequest,
    persistActiveChat,
    resetChatConversation,
    setChatBusy,
  };
};
