import type { ChatContentBlock, ChatMessage, ChatTokenUsage } from '../../../shared/contracts';
import { estimateChatUsage } from '../../../shared/conversation/chat-usage';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatSubmitActions {
  submitChatMessage: () => Promise<void>;
}

export const createChatSubmitActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  view: ChatView,
  loadChatConfig: (force?: boolean) => Promise<void>,
  setChatBusy: (busy: boolean) => void,
  resizeChatComposer: () => void,
  persistActiveChat: () => Promise<void>,
  renderPendingChatAttachments: () => void,
  finishChatRequest: () => void,
): ChatSubmitActions => {
  const submitChatMessage = async (): Promise<void> => {
    if (state.activeChatRequestId || state.chatSubmissionInFlight) {
      return;
    }
    state.chatSubmissionInFlight = true;
    setChatBusy(false);
    let previousMessages: ChatMessage[] | undefined;
    let previousUsage: ChatTokenUsage | undefined;
    let previousProviderUsage: ChatTokenUsage | undefined;
    let requestId = '';
    let historyRepaired = false;
    let pendingUserArticle: HTMLElement | undefined;
    let pendingAssistantArticle: HTMLElement | undefined;
    try {
      await state.chatAttachmentImportQueue;
      const content = elements.chatInput.value.trim();
      if (!content && state.pendingChatAttachments.length === 0) {
        return;
      }
      if (!state.chatConfig?.model) {
        await loadChatConfig(true);
      }
      if (!state.chatConfig?.model) {
        dependencies.showToast('请先在左侧保存独立对话模型配置。', 'error');
        return;
      }

      const contentBlocks: ChatContentBlock[] = [
        ...state.pendingChatAttachments.map(
          (attachment): Exclude<ChatContentBlock, { type: 'text' }> => ({
            fileName: attachment.fileName,
            mediaType: attachment.mediaType,
            source: { attachmentId: attachment.attachmentId, type: 'local' },
            type: attachment.type,
          }),
        ),
        ...(content ? ([{ text: content, type: 'text' }] satisfies ChatContentBlock[]) : []),
      ];
      const candidateMessages = [
        ...state.chatMessages,
        { content: contentBlocks, role: 'user' as const },
      ];
      requestId = crypto.randomUUID();
      const prepared = await window.controlPanel.preflightChat({
        draftId: state.activeChatAttachmentDraftId,
        messages: candidateMessages,
        requestId,
      });
      if (prepared.warning) {
        dependencies.showToast(prepared.warning);
      }

      previousMessages = [...state.chatMessages];
      previousUsage = { ...state.activeChatUsage };
      previousProviderUsage = state.activeChatProviderUsage
        ? { ...state.activeChatProviderUsage }
        : undefined;
      // The draft is committed here, so this is where the bubble should lift — same confirmation the
      // terminal composer gives. Clearing the textarea now keeps the lift and the empty input in sync.
      dependencies.playSendAnimation(content, elements.chatInput, 'chat');
      elements.chatInput.value = '';
      resizeChatComposer();
      state.chatMessages.splice(0, state.chatMessages.length, ...prepared.messages);
      state.activeChatRequestMessages = [...prepared.messages];
      state.activeChatUsage = estimateChatUsage(state.activeChatRequestMessages);
      state.activeChatProviderUsage = undefined;
      state.activeChatReply = '';
      state.activeChatRequestId = requestId;
      historyRepaired = prepared.removedAttachmentIds.length > 0;
      if (historyRepaired) {
        view.renderChatMessages();
      } else {
        const currentMessage = prepared.messages.at(-1);
        if (currentMessage?.role === 'user') {
          const mount = view.appendChatMessage('user', currentMessage.content);
          pendingUserArticle = mount.closest('article') as HTMLElement | undefined;
        }
      }
      view.renderChatUsage();
      state.activeChatReplyElement = view.appendChatMessage('assistant', '正在连接模型…', false);
      pendingAssistantArticle = state.activeChatReplyElement.closest('article') as
        HTMLElement | undefined;
      setChatBusy(true);

      const accepted = await window.controlPanel.startChat({
        draftId: state.activeChatAttachmentDraftId,
        messages: prepared.messages,
        requestId,
      });
      state.activeChatRequestMessages = [...accepted.messages];
      state.chatMessages.splice(0, state.chatMessages.length, ...accepted.messages);
      if (accepted.removedAttachmentIds.length > prepared.removedAttachmentIds.length) {
        historyRepaired = true;
        view.renderChatMessages();
        state.activeChatReplyElement = view.appendChatMessage('assistant', '正在连接模型…', false);
      }
      if (accepted.warning && accepted.warning !== prepared.warning) {
        dependencies.showToast(accepted.warning);
      }
      state.activeChatAttachmentDraftId = undefined;
      state.pendingChatAttachments.splice(0);
      renderPendingChatAttachments();
      await persistActiveChat();
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法启动独立对话请求。';
      if (previousMessages && state.activeChatRequestId === requestId) {
        state.chatMessages.splice(0, state.chatMessages.length, ...previousMessages);
        state.activeChatUsage = previousUsage ?? estimateChatUsage(previousMessages);
        state.activeChatProviderUsage = previousProviderUsage;
        if (historyRepaired) {
          view.renderChatMessages();
        } else {
          pendingUserArticle?.remove();
          pendingAssistantArticle?.remove();
          elements.chatEmptyState.hidden = state.chatMessages.length > 0;
        }
        view.renderChatUsage();
        finishChatRequest();
      }
      dependencies.showToast(message, 'error');
    } finally {
      state.chatSubmissionInFlight = false;
      setChatBusy(Boolean(state.activeChatRequestId));
    }
  };

  return {
    submitChatMessage,
  };
};
