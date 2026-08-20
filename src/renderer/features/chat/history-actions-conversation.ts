import type { ChatConversationSummary } from '../../../shared/contracts';
import type { ChatElements } from './elements';
import type { ChatHistoryActionsDependencies } from './history-actions-dependencies';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatHistoryConversationActions {
  deleteChatConversation: (conversation: ChatConversationSummary) => Promise<void>;
  loadChatConversation: (conversationId: string) => Promise<void>;
  loadChatHistory: () => Promise<void>;
  renameChatConversation: (conversation: ChatConversationSummary) => Promise<void>;
}

export const createChatHistoryConversationActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatHistoryActionsDependencies,
  view: ChatView,
  resetChatConversation: () => void,
  cancelChatTitleAnimation: (conversationId: string) => void,
  startChatTitleAnimation: (conversationId: string, fromTitle: string, toTitle: string) => void,
  renderChatHistory: () => void,
): ChatHistoryConversationActions => {
  const loadChatConversation = async (conversationId: string): Promise<void> => {
    if (
      state.activeChatRequestId ||
      state.queuedChatAttachmentImports > 0 ||
      state.chatSubmissionInFlight
    ) {
      return;
    }
    try {
      const conversation = await window.controlPanel.getChatConversation(conversationId);
      if (!conversation) {
        dependencies.showToast('这条对话历史已经不存在。', 'error');
        await loadChatHistory();
        return;
      }
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
      state.activeChatConversationId = conversation.id;
      state.chatMessages.splice(0, state.chatMessages.length, ...conversation.messages);
      state.activeChatUsage = { ...conversation.usage };
      state.activeChatProviderUsage =
        conversation.usage.source === 'provider' ? { ...conversation.usage } : undefined;
      state.activeChatRequestMessages = [];
      view.renderChatMessages();
      view.renderChatUsage();
      renderChatHistory();
      elements.chatInput.focus();
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法读取这条对话历史。',
        'error',
      );
    }
  };

  const deleteChatConversation = async (conversation: ChatConversationSummary): Promise<void> => {
    if (
      state.activeChatRequestId ||
      state.queuedChatAttachmentImports > 0 ||
      state.chatSubmissionInFlight ||
      !(await dependencies.requestConfirmation({
        confirmLabel: '删除对话',
        message: `永久删除“${conversation.title}”及其本机消息记录？此操作无法撤销。`,
        title: '删除对话历史',
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      const deleted = await window.controlPanel.deleteChatConversation(conversation.id);
      if (!deleted) {
        throw new Error('对话历史已经不存在。');
      }
      if (state.activeChatConversationId === conversation.id) {
        resetChatConversation();
      }
      cancelChatTitleAnimation(conversation.id);
      await loadChatHistory();
      dependencies.showToast(`已删除对话“${conversation.title}”`);
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法删除对话历史。',
        'error',
      );
    }
  };

  const renameChatConversation = async (conversation: ChatConversationSummary): Promise<void> => {
    if (
      state.activeChatRequestId ||
      state.queuedChatAttachmentImports > 0 ||
      state.chatSubmissionInFlight
    ) {
      return;
    }
    const nextTitle = await dependencies.requestConversationTitle(conversation.title, true);
    if (!nextTitle) {
      return;
    }
    const previousTitle = conversation.title;
    try {
      const renamed = await window.controlPanel.renameChatConversation(conversation.id, nextTitle);
      if (!renamed) {
        throw new Error('对话历史已经不存在。');
      }
      // Reload first so the list carries the persisted name, then animate from the old label to it.
      await loadChatHistory();
      startChatTitleAnimation(conversation.id, previousTitle, renamed.title);
    } catch (error) {
      dependencies.showToast(error instanceof Error ? error.message : '无法重命名对话。', 'error');
    }
  };

  const loadChatHistory = async (): Promise<void> => {
    try {
      state.chatConversations = await window.controlPanel.getChatConversations();
      renderChatHistory();
    } catch (error) {
      elements.chatHistoryEmpty.hidden = false;
      elements.chatHistoryEmpty.textContent =
        error instanceof Error ? error.message : '无法读取本机对话历史。';
    }
  };

  return {
    deleteChatConversation,
    loadChatConversation,
    loadChatHistory,
    renameChatConversation,
  };
};
