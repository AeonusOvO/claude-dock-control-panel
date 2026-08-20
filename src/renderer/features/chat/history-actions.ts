import type { ChatConversationSummary } from '../../../shared/contracts';
import { createChatHistoryConversationActions } from './history-actions-conversation';
import { createChatHistoryRenderActions } from './history-actions-render';
import { createChatTitleAnimationActions } from './history-actions-title';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export type { ChatHistoryActionsDependencies } from './history-actions-dependencies';
import type { ChatHistoryActionsDependencies } from './history-actions-dependencies';

export interface ChatHistoryActions {
  deleteChatConversation: (conversation: ChatConversationSummary) => Promise<void>;
  loadChatConversation: (conversationId: string) => Promise<void>;
  loadChatHistory: () => Promise<void>;
  renameChatConversation: (conversation: ChatConversationSummary) => Promise<void>;
  renderChatHistory: () => void;
}

export const createChatHistoryActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatHistoryActionsDependencies,
  view: ChatView,
  resetChatConversation: () => void,
): ChatHistoryActions => {
  const titleActions = createChatTitleAnimationActions(state, elements);
  const conversationActions = createChatHistoryConversationActions(
    elements,
    state,
    dependencies,
    view,
    resetChatConversation,
    titleActions.cancelChatTitleAnimation,
    titleActions.startChatTitleAnimation,
    () => renderActions.renderChatHistory(),
  );
  const renderActions = createChatHistoryRenderActions(
    elements,
    state,
    dependencies,
    view,
    conversationActions.loadChatConversation,
    conversationActions.renameChatConversation,
    conversationActions.deleteChatConversation,
  );

  return {
    deleteChatConversation: conversationActions.deleteChatConversation,
    loadChatConversation: conversationActions.loadChatConversation,
    loadChatHistory: conversationActions.loadChatHistory,
    renameChatConversation: conversationActions.renameChatConversation,
    renderChatHistory: renderActions.renderChatHistory,
  };
};
