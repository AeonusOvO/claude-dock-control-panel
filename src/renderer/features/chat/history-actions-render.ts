import type { ChatConversationSummary } from '../../../shared/contracts';
import type { ChatElements } from './elements';
import type { ChatHistoryActionsDependencies } from './history-actions-dependencies';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatHistoryRenderActions {
  renderChatHistory: () => void;
}

export const createChatHistoryRenderActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatHistoryActionsDependencies,
  view: ChatView,
  loadChatConversation: (conversationId: string) => Promise<void>,
  renameChatConversation: (conversation: ChatConversationSummary) => Promise<void>,
  deleteChatConversation: (conversation: ChatConversationSummary) => Promise<void>,
): ChatHistoryRenderActions => {
  const renderChatHistory = (): void => {
    elements.chatHistoryList.replaceChildren();
    elements.chatHistoryEmpty.hidden = state.chatConversations.length > 0;
    elements.chatHistoryEmpty.textContent = '还没有历史记录；发送第一条消息后会自动保存。';
    elements.chatHistoryCount.textContent = `${state.chatConversations.length} 条`;
    for (const conversation of state.chatConversations) {
      const row = document.createElement('div');
      row.className = 'chat-history__item';
      row.dataset.active = String(conversation.id === state.activeChatConversationId);

      const busy =
        Boolean(state.activeChatRequestId) ||
        state.queuedChatAttachmentImports > 0 ||
        state.chatSubmissionInFlight;

      const open = document.createElement('button');
      open.className = 'chat-history__open';
      open.type = 'button';
      open.disabled = busy;
      open.setAttribute('aria-label', `打开对话 ${conversation.title}`);
      const title = document.createElement('strong');
      title.dataset.conversationId = conversation.id;
      // A rename in flight owns the label until its animation finishes.
      title.textContent = view.displayedChatTitle(conversation);
      title.dataset.titleTyping = String(state.chatTitleAnimations.has(conversation.id));
      const meta = document.createElement('span');
      meta.textContent = `${view.formatChatHistoryTime(conversation.updatedAt)} · ${conversation.messageCount} 条消息 · ${dependencies.formatTokenCount(conversation.usage.totalTokens)} tokens`;
      open.append(title, meta);
      open.addEventListener('click', () => {
        void loadChatConversation(conversation.id);
      });

      const rename = document.createElement('button');
      rename.className = 'chat-history__rename';
      rename.type = 'button';
      rename.disabled = busy;
      rename.title = '重命名对话';
      rename.setAttribute('aria-label', `重命名对话 ${conversation.title}`);
      const renameIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      renameIcon.setAttribute('viewBox', '0 0 24 24');
      renameIcon.setAttribute('aria-hidden', 'true');
      const renamePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      renamePath.setAttribute('d', 'M4 20h4l10-10-4-4L4 16v4ZM14.5 5.5l4 4');
      renameIcon.append(renamePath);
      rename.append(renameIcon);
      rename.addEventListener('click', () => {
        void renameChatConversation(conversation);
      });

      const remove = document.createElement('button');
      remove.className = 'chat-history__delete';
      remove.type = 'button';
      remove.disabled = busy;
      remove.title = '删除对话历史';
      remove.setAttribute('aria-label', `删除对话 ${conversation.title}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        void deleteChatConversation(conversation);
      });
      row.append(open, rename, remove);
      elements.chatHistoryList.append(row);
    }
  };

  return { renderChatHistory };
};
