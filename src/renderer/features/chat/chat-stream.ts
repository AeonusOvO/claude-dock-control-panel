import type { ChatStreamEvent } from '../../../shared/contracts';
import { estimateChatUsage } from '../../../shared/conversation/chat-usage';
import type { ChatStreamCompletionActions } from './chat-stream-completion';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatStreamActions {
  handleChatStream: (event: ChatStreamEvent) => void;
}

export const createChatStreamActions = (
  state: ChatState,
  view: ChatView,
  dependencies: ChatActionsDependencies,
  completionActions: ChatStreamCompletionActions,
): ChatStreamActions => {
  const handleChatStream = (event: ChatStreamEvent): void => {
    if (event.requestId !== state.activeChatRequestId) {
      return;
    }
    if (event.usage) {
      state.activeChatProviderUsage = { ...event.usage };
      state.activeChatUsage = { ...event.usage };
      view.renderChatUsage();
    }
    if (event.type === 'idle') {
      const article = state.activeChatReplyElement?.closest('article');
      if (article && !state.activeChatIdleNoticeElement) {
        state.activeChatIdleNoticeElement = document.createElement('p');
        state.activeChatIdleNoticeElement.className = 'chat-message__idle-notice';
        state.activeChatIdleNoticeElement.setAttribute('role', 'status');
        article.append(state.activeChatIdleNoticeElement);
      }
      const minutes = Math.max(1, Math.floor((event.idleMs ?? 0) / 60_000));
      const probe =
        event.probe?.ok === true
          ? '接口连通正常'
          : event.probe?.ok === false
            ? '接口探测失败'
            : '正在探测接口…';
      if (state.activeChatIdleNoticeElement) {
        state.activeChatIdleNoticeElement.textContent = `已 ${minutes} 分钟未收到数据 · ${probe}`;
        state.activeChatIdleNoticeElement.dataset.tone =
          event.probe?.ok === false ? 'warning' : event.probe?.ok === true ? 'success' : 'pending';
        state.activeChatIdleNoticeElement.title = event.probe?.detail ?? '';
      }
      return;
    }
    if (event.type === 'delta' && event.delta) {
      state.activeChatIdleNoticeElement?.remove();
      state.activeChatIdleNoticeElement = undefined;
      state.activeChatReply += event.delta;
      if (state.activeChatReplyElement) {
        if (!state.activeChatReplyStream) {
          state.activeChatReplyElement.replaceChildren();
          state.activeChatReplyStream = dependencies
            .getMarkdownRenderer()
            .createStream(state.activeChatReplyElement);
        }
        void state.activeChatReplyStream.update(state.activeChatReply).then(() => {
          dependencies.chatMessagesElement.scrollTop =
            dependencies.chatMessagesElement.scrollHeight;
        });
      }
      if (!event.usage) {
        const estimated = estimateChatUsage(state.activeChatRequestMessages, state.activeChatReply);
        state.activeChatUsage = state.activeChatProviderUsage
          ? {
              inputTokens: state.activeChatProviderUsage.inputTokens,
              outputTokens: estimated.outputTokens,
              source: 'estimated',
              totalTokens: state.activeChatProviderUsage.inputTokens + estimated.outputTokens,
            }
          : estimated;
        view.renderChatUsage();
      }
      return;
    }
    if (event.type === 'thinking' && event.delta) {
      state.activeChatThinking += event.delta;
      if (state.activeChatReplyElement) {
        if (!state.activeChatThinkingElement) {
          const details = document.createElement('details');
          details.className = 'chat-thinking';
          const summary = document.createElement('summary');
          summary.textContent = '思考过程';
          state.activeChatThinkingElement = document.createElement('div');
          details.append(summary, state.activeChatThinkingElement);
          state.activeChatReplyElement.before(details);
        }
        state.activeChatThinkingElement.textContent = state.activeChatThinking;
      }
      return;
    }
    if (event.type === 'input-json' && event.delta) {
      state.activeChatThinking += event.delta;
      if (state.activeChatThinkingElement) {
        state.activeChatThinkingElement.textContent = state.activeChatThinking;
      }
      return;
    }
    if (event.type === 'retrying') {
      if (state.activeChatReplyElement && !state.activeChatReply) {
        const attempt = event.attempt ?? 2;
        const maximum = event.maxAttempts ?? attempt;
        const wait = event.retryAfterMs
          ? `，约 ${Math.max(1, Math.ceil(event.retryAfterMs / 1000))} 秒后`
          : '';
        state.activeChatReplyElement.textContent = `${event.detail ?? '连接暂时中断，正在自动重试。'}${wait}（${attempt}/${maximum}）`;
      }
      return;
    }
    if (event.type === 'refusal') {
      const refusal = event.refusal || '模型拒绝了这项请求。';
      state.activeChatReply = state.activeChatReply
        ? `${state.activeChatReply}\n\n> ${refusal}`
        : `> ${refusal}`;
      if (state.activeChatReplyElement) {
        state.activeChatReplyStream ??= dependencies
          .getMarkdownRenderer()
          .createStream(state.activeChatReplyElement);
        void state.activeChatReplyStream.update(state.activeChatReply);
      }
      return;
    }
    if (event.type === 'done') {
      completionActions.handleChatDoneEvent();
      return;
    }
    if (event.type === 'aborted') {
      completionActions.handleChatAbortedEvent(event);
      return;
    }
    if (event.type === 'error') {
      completionActions.handleChatErrorEvent(event);
    }
  };

  return {
    handleChatStream,
  };
};
