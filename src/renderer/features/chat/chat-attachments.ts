import type { ChatAttachmentImportResult } from '../../../shared/contracts';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatAttachmentActions {
  applyChatAttachmentImportResult: (result: ChatAttachmentImportResult) => void;
  renderPendingChatAttachments: () => void;
}

export const createChatAttachmentActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  view: ChatView,
): ChatAttachmentActions => {
  const renderPendingChatAttachments = (): void => {
    elements.chatAttachmentQueue.replaceChildren();
    elements.chatAttachmentQueue.hidden = state.pendingChatAttachments.length === 0;
    for (const attachment of state.pendingChatAttachments) {
      const card = document.createElement('div');
      card.className = `chat-attachment-draft chat-attachment-draft--${attachment.type}`;
      const preview = document.createElement('div');
      preview.className = 'chat-attachment-draft__preview';
      if (attachment.previewDataUrl) {
        const image = document.createElement('img');
        image.alt = '';
        image.src = attachment.previewDataUrl;
        preview.append(image);
      } else {
        preview.textContent =
          attachment.type === 'image'
            ? 'IMG'
            : attachment.mediaType === 'application/pdf'
              ? 'PDF'
              : 'DOC';
      }
      const copy = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = attachment.fileName;
      const meta = document.createElement('small');
      meta.textContent = dependencies.formatAttachmentSize(attachment.sizeBytes);
      copy.append(name, meta);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除附件 ${attachment.fileName}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        const index = state.pendingChatAttachments.findIndex(
          (candidate) => candidate.attachmentId === attachment.attachmentId,
        );
        const draftId = state.activeChatAttachmentDraftId;
        if (index < 0 || !draftId) {
          return;
        }
        remove.disabled = true;
        void window.controlPanel
          .deleteChatDraftAttachment(draftId, attachment.attachmentId)
          .then((removed) => {
            if (!removed) {
              throw new Error('附件草稿已经变化，请重新选择文件。');
            }
            const currentIndex = state.pendingChatAttachments.findIndex(
              (candidate) => candidate.attachmentId === attachment.attachmentId,
            );
            if (currentIndex >= 0) {
              state.pendingChatAttachments.splice(currentIndex, 1);
            }
            renderPendingChatAttachments();
            view.renderChatUsage();
          })
          .catch((error) => {
            remove.disabled = false;
            dependencies.showToast(
              error instanceof Error ? error.message : '无法移除附件。',
              'error',
            );
          });
      });
      card.append(preview, copy, remove);
      elements.chatAttachmentQueue.append(card);
    }
  };

  const applyChatAttachmentImportResult = (result: ChatAttachmentImportResult): void => {
    if (result.draftId) {
      state.activeChatAttachmentDraftId = result.draftId;
    }
    state.pendingChatAttachments.push(...result.attachments);
    renderPendingChatAttachments();
    for (const attachment of result.attachments) {
      if (attachment.type === 'image') {
        void window.controlPanel.readChatAttachment(attachment.attachmentId).then((preview) => {
          if (preview?.previewDataUrl) {
            attachment.previewDataUrl = preview.previewDataUrl;
            renderPendingChatAttachments();
          }
        });
      }
    }
    if (
      elements.chatProtocol.value === 'openai' &&
      result.attachments.some((attachment) => attachment.mediaType === 'application/pdf')
    ) {
      dependencies.showToast(
        '已添加 PDF；当前 OpenAI 兼容端点可能不支持 PDF，请以服务端结果为准。',
      );
    } else if (result.attachments.length > 0) {
      dependencies.showToast(`已安全导入 ${result.attachments.length} 个附件`);
    }
    if (result.errors.length > 0) {
      const message = result.errors[0]?.message ?? '部分附件无法导入。';
      dependencies.showToast(
        result.ok ? message : dependencies.resultFailureMessage(result, message),
        'error',
      );
    }
  };

  return {
    applyChatAttachmentImportResult,
    renderPendingChatAttachments,
  };
};
