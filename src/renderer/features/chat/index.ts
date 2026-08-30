import { createRegistryToken, type Registry } from '../../platform/registry';
import type { ChatAttachmentImportCompletion } from './chat-attachment-import';
import { createChatActions, type ChatActionsDependencies, type ChatActions } from './actions';
import { createChatElements } from './elements';
import {
  createChatHistoryActions,
  type ChatHistoryActions,
  type ChatHistoryActionsDependencies,
} from './history-actions';
import { createChatState } from './state';
import { createChatView, type ChatViewDependencies } from './view';

export type ChatFeatureDependencies = ChatActionsDependencies &
  ChatHistoryActionsDependencies &
  ChatViewDependencies;

export interface ChatFeature {
  dispose: () => void;
  focusInputAfterNavigation: () => void;
  hasActiveRequest: () => boolean;
  loadChatConfig: (force?: boolean) => Promise<void>;
  loadChatHistory: () => Promise<void>;
  queueAttachmentImport: (files: File[], onComplete?: ChatAttachmentImportCompletion) => boolean;
  renderChatMessages: () => void;
  renderChatUsage: () => void;
}

export const CHAT_FEATURE = createRegistryToken<ChatFeature>('renderer.feature.chat');

const createChatFeature = (dependencies: ChatFeatureDependencies): ChatFeature => {
  const elements = createChatElements();
  const state = createChatState();
  const view = createChatView(elements, state, {
    chatMessagesElement: dependencies.chatMessagesElement,
    formatAttachmentSize: dependencies.formatAttachmentSize,
    formatTokenCount: dependencies.formatTokenCount,
    getMarkdownRenderer: dependencies.getMarkdownRenderer,
    stopArtifacts: dependencies.stopArtifacts,
  });
  const renderChatHistoryRef: { current: () => void } = { current: () => {} };
  const actions: ChatActions = createChatActions(
    elements,
    state,
    dependencies,
    view,
    renderChatHistoryRef,
  );
  const history: ChatHistoryActions = createChatHistoryActions(
    elements,
    state,
    dependencies,
    view,
    actions.resetChatConversation,
  );
  renderChatHistoryRef.current = history.renderChatHistory;
  const disposeBindings = actions.bind();

  return {
    dispose: () => {
      state.activeChatReplyStream?.destroy();
      disposeBindings();
    },
    focusInputAfterNavigation: actions.focusChatInputAfterNavigation,
    hasActiveRequest: actions.hasActiveRequest,
    loadChatConfig: actions.loadChatConfig,
    loadChatHistory: history.loadChatHistory,
    queueAttachmentImport: actions.queueChatAttachmentImport,
    renderChatMessages: view.renderChatMessages,
    renderChatUsage: view.renderChatUsage,
  };
};

export const registerChatFeature = (
  registry: Registry,
  dependencies: ChatFeatureDependencies,
): void => {
  registry.register(CHAT_FEATURE, () => createChatFeature(dependencies));
};
