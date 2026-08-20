import type {
  ChatConfigView,
  ChatContentBlock,
  ChatConversationSummary,
  ChatMessage,
} from '../../../shared/contracts';
import { estimateChatUsage } from '../../../shared/conversation/chat-usage';
import type { MarkdownDomRenderer } from '../../platform/markdown';
import type { ChatElements } from './elements';
import type { ChatState } from './state';

export interface ChatViewDependencies {
  chatMessagesElement: HTMLElement;
  formatAttachmentSize: (sizeBytes: number) => string;
  formatTokenCount: (value: number | undefined) => string;
  getMarkdownRenderer: () => MarkdownDomRenderer;
  stopArtifacts: () => void;
}

export interface ChatView {
  appendChatMessage: (
    role: 'assistant' | 'user',
    content: ChatMessage['content'],
    renderMarkdown?: boolean,
  ) => HTMLElement;
  chatTextContent: (content: ChatMessage['content']) => string;
  displayedChatTitle: (conversation: ChatConversationSummary) => string;
  formatChatHistoryTime: (timestamp: number) => string;
  normalizedChatBlocks: (content: ChatMessage['content']) => ChatContentBlock[];
  renderChatConfig: (config: ChatConfigView) => void;
  renderChatMessages: () => void;
  renderChatUsage: () => void;
}

export const createChatView = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatViewDependencies,
): ChatView => {
  const formatChatHistoryTime = (timestamp: number): string =>
    new Intl.DateTimeFormat('zh-CN', {
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
    }).format(new Date(timestamp));

  const displayedChatTitle = (conversation: ChatConversationSummary): string => {
    const animation = state.chatTitleAnimations.get(conversation.id);
    return animation ? animation.chars.join('') : conversation.title;
  };

  const renderChatUsage = (): void => {
    const draft = elements.chatInput.value.trim();
    const displayUsage = draft
      ? estimateChatUsage([...state.chatMessages, { content: draft, role: 'user' }])
      : state.activeChatUsage;
    const marker = displayUsage.source === 'estimated' ? '约 ' : '';
    elements.chatContextTotal.textContent = `${marker}${dependencies.formatTokenCount(displayUsage.totalTokens)} tokens`;
    elements.chatTokenUsage.textContent = `输入 ${marker}${dependencies.formatTokenCount(displayUsage.inputTokens)} · 输出 ${marker}${dependencies.formatTokenCount(displayUsage.outputTokens)}`;
    const detail =
      displayUsage.source === 'provider'
        ? 'Token 数由当前模型接口返回。'
        : draft
          ? '已把输入框草稿计入当前上下文，并按文本长度实时估算。'
          : '当前接口尚未返回 usage，暂按文本长度估算。';
    elements.chatContextTotal.title = detail;
    elements.chatTokenUsage.title = detail;
  };

  const renderChatConfig = (config: ChatConfigView): void => {
    state.chatConfig = config;
    elements.chatProtocol.value = config.protocol;
    elements.chatBaseUrl.value = config.baseUrl;
    elements.chatModel.value = config.model;
    elements.chatAuthMode.value = config.authMode;
    elements.chatCredential.value = '';
    elements.chatClearCredential.checked = false;
    elements.chatCredential.disabled = config.authMode === 'none';
    elements.chatClearCredential.disabled = config.authMode === 'none';
    elements.chatCredentialStatus.textContent =
      config.authMode === 'none'
        ? '当前接口不使用认证凭据。'
        : config.credentialConfigured
          ? '已通过 Windows 安全存储保存凭据；留空可继续使用。'
          : '尚未保存凭据。';
    elements.chatActiveModel.textContent = config.model || '尚未配置模型';
  };

  const normalizedChatBlocks = (content: ChatMessage['content']): ChatContentBlock[] =>
    typeof content === 'string' ? [{ text: content, type: 'text' }] : content;

  const chatTextContent = (content: ChatMessage['content']): string =>
    normalizedChatBlocks(content)
      .filter(
        (block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n\n');

  const appendAttachmentCard = (
    container: HTMLElement,
    block: Exclude<ChatContentBlock, { type: 'text' }>,
  ): void => {
    const card = document.createElement('div');
    card.className = `chat-attachment-card chat-attachment-card--${block.type}`;
    const preview = document.createElement('div');
    preview.className = 'chat-attachment-card__preview';
    preview.textContent =
      block.type === 'image' ? '图片' : block.mediaType === 'application/pdf' ? 'PDF' : '文件';
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = block.fileName || (block.type === 'image' ? '图片附件' : '文档附件');
    const meta = document.createElement('small');
    meta.textContent = block.mediaType;
    copy.append(name, meta);
    card.append(preview, copy);
    container.append(card);

    if (block.source.type !== 'local') {
      return;
    }
    void window.controlPanel
      .readChatAttachment(block.source.attachmentId)
      .then((attachment) => {
        if (!attachment || !card.isConnected) {
          return;
        }
        name.textContent = attachment.fileName;
        meta.textContent = `${attachment.mediaType} · ${dependencies.formatAttachmentSize(attachment.sizeBytes)}`;
        if (attachment.type === 'image' && attachment.previewDataUrl) {
          const image = document.createElement('img');
          image.alt = attachment.fileName;
          image.loading = 'lazy';
          image.src = attachment.previewDataUrl;
          preview.replaceChildren(image);
        }
      })
      .catch(() => {
        meta.textContent = '附件在本机已不可用';
        card.dataset.missing = 'true';
      });
  };

  const appendChatMessage = (
    role: 'assistant' | 'user',
    content: ChatMessage['content'],
    renderMarkdown = true,
  ): HTMLElement => {
    const article = document.createElement('article');
    article.className = `chat-message chat-message--${role}`;
    const label = document.createElement('strong');
    label.textContent = role === 'user' ? '你' : 'Claude';
    const body = document.createElement('div');
    body.className = 'chat-message__content';
    const blocks = normalizedChatBlocks(content);
    const attachments = blocks.filter(
      (block): block is Exclude<ChatContentBlock, { type: 'text' }> => block.type !== 'text',
    );
    if (attachments.length > 0) {
      const attachmentList = document.createElement('div');
      attachmentList.className = 'chat-message__attachments';
      for (const attachment of attachments) {
        appendAttachmentCard(attachmentList, attachment);
      }
      body.append(attachmentList);
    }
    const text = chatTextContent(content);
    let textMount: HTMLElement | undefined;
    if (text) {
      textMount = document.createElement('div');
      textMount.className = 'chat-message__markdown';
      body.append(textMount);
      if (role === 'assistant' && renderMarkdown) {
        void dependencies.getMarkdownRenderer().renderInto(textMount, text);
      } else {
        textMount.textContent = text;
      }
    }
    article.append(label, body);
    dependencies.chatMessagesElement.append(article);
    elements.chatEmptyState.hidden = true;
    dependencies.chatMessagesElement.scrollTop = dependencies.chatMessagesElement.scrollHeight;
    return textMount ?? body;
  };

  const renderChatMessages = (): void => {
    dependencies.stopArtifacts();
    dependencies.chatMessagesElement.replaceChildren(elements.chatEmptyState);
    elements.chatEmptyState.hidden = state.chatMessages.length > 0;
    for (const message of state.chatMessages) {
      if (message.role !== 'system') {
        appendChatMessage(message.role, message.content);
      }
    }
  };

  return {
    appendChatMessage,
    chatTextContent,
    displayedChatTitle,
    formatChatHistoryTime,
    normalizedChatBlocks,
    renderChatConfig,
    renderChatMessages,
    renderChatUsage,
  };
};
