import type { ChatStreamEvent } from '../../../shared/contracts';
import { estimateChatUsage } from '../../../shared/conversation/chat-usage';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatStreamCompletionActions {
  handleChatAbortedEvent: (event: ChatStreamEvent) => void;
  handleChatDoneEvent: () => void;
  handleChatErrorEvent: (event: ChatStreamEvent) => void;
}

export const createChatStreamCompletionActions = (
  state: ChatState,
  view: ChatView,
  dependencies: ChatActionsDependencies,
  persistActiveChat: () => Promise<void>,
  finishChatRequest: () => void,
  appendChatContinuationButton: (replyElement: HTMLElement) => HTMLButtonElement | undefined,
): ChatStreamCompletionActions => {
  const handleChatDoneEvent = (): void => {
    if (state.activeChatReply) {
      state.chatMessages.push({
        content: [{ text: state.activeChatReply, type: 'text' }],
        role: 'assistant',
      });
    } else if (state.activeChatReplyElement) {
      state.activeChatReplyElement.textContent = '模型没有返回可显示的文本。';
    }
    if (!state.activeChatProviderUsage) {
      state.activeChatUsage = estimateChatUsage(
        state.activeChatRequestMessages,
        state.activeChatReply,
      );
      view.renderChatUsage();
    }
    void (async () => {
      await state.activeChatReplyStream?.finish(state.activeChatReply);
      await persistActiveChat();
    })().finally(finishChatRequest);
  };

  const handleChatAbortedEvent = (event: ChatStreamEvent): void => {
    const localTimeout = event.abortReason === 'local-timeout';
    const notice = localTimeout ? '已按本地静默超时设置停止生成。' : '已停止生成。';
    const visibleReply = state.activeChatReply
      ? `${state.activeChatReply}\n\n> ${notice}`
      : `> ${notice}`;
    if (state.activeChatReplyElement && !state.activeChatReply) {
      state.activeChatReplyElement.textContent = notice;
    } else if (localTimeout && state.activeChatReply) {
      state.activeChatReplyStream ??= state.activeChatReplyElement
        ? dependencies.getMarkdownRenderer().createStream(state.activeChatReplyElement)
        : undefined;
      void state.activeChatReplyStream?.update(visibleReply);
    }
    if (state.activeChatReply) {
      state.chatMessages.push({
        content: [{ text: state.activeChatReply, type: 'text' }],
        role: 'assistant',
      });
    }
    state.activeChatUsage = state.activeChatProviderUsage
      ? { ...state.activeChatProviderUsage }
      : estimateChatUsage(state.activeChatRequestMessages, state.activeChatReply);
    view.renderChatUsage();
    if (localTimeout) {
      dependencies.showToast(notice, 'error');
    }
    void (async () => {
      await state.activeChatReplyStream?.finish(visibleReply);
      await persistActiveChat();
    })().finally(finishChatRequest);
  };

  const handleChatErrorEvent = (event: ChatStreamEvent): void => {
    const continuationButton =
      event.continuable && state.activeChatReply && state.activeChatReplyElement
        ? appendChatContinuationButton(state.activeChatReplyElement)
        : undefined;
    const notice = state.activeChatReply
      ? `${state.activeChatReply}\n\n> 生成中断：${event.error ?? '请求失败'}`
      : `> 请求失败：${event.error ?? '未知错误'}`;
    if (state.activeChatReplyElement) {
      state.activeChatReplyStream ??= dependencies
        .getMarkdownRenderer()
        .createStream(state.activeChatReplyElement);
      void state.activeChatReplyStream.update(notice);
    }
    if (state.activeChatReply) {
      state.chatMessages.push({
        content: [{ text: state.activeChatReply, type: 'text' }],
        role: 'assistant',
      });
    }
    state.activeChatUsage = state.activeChatProviderUsage
      ? { ...state.activeChatProviderUsage }
      : estimateChatUsage(state.activeChatRequestMessages, state.activeChatReply);
    view.renderChatUsage();
    dependencies.showToast(event.error ?? '独立对话请求失败。', 'error');
    void (async () => {
      await state.activeChatReplyStream?.finish(notice);
      await persistActiveChat();
    })().finally(() => {
      finishChatRequest();
      if (continuationButton?.isConnected) {
        continuationButton.disabled = false;
      }
    });
  };

  return {
    handleChatAbortedEvent,
    handleChatDoneEvent,
    handleChatErrorEvent,
  };
};
