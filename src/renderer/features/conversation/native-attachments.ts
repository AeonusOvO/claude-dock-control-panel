import type {
  ConversationSnapshot,
  NativeAttachmentImportResult,
} from '../../../shared/conversation/native';
import type { ConversationActionsDependencies } from './dependencies';
import type { ConversationElements } from './elements';
import type { ConversationState } from './state';

export interface NativeAttachmentActions {
  applyNativeAttachmentResult: (result: NativeAttachmentImportResult) => void;
  importNativeAttachments: (files: File[]) => Promise<void>;
  nativeClipboardFileName: (file: File, index: number) => string;
  renderPendingNativeAttachments: () => void;
  resizeNativeComposer: () => void;
}

export const createNativeAttachmentActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationActionsDependencies,
  renderNativeConversation: (snapshot: ConversationSnapshot) => void,
): NativeAttachmentActions => {
  /**
   * Two forced synchronous layouts, so it must never run on the streaming render path: writing
   * `--native-composer-h` on `:root` invalidates the whole document, and the following
   * `getBoundingClientRect()` then re-lays out every message in the transcript. Caching the last
   * published height keeps the custom-property write out of the frame whenever nothing moved.
   */
  const resizeNativeComposer = (): void => {
    elements.nativeComposerInput.style.height = 'auto';
    elements.nativeComposerInput.style.height = `${Math.min(elements.nativeComposerInput.scrollHeight, 168)}px`;
    const height = Math.ceil(elements.nativeComposer.getBoundingClientRect().height);
    if (height === state.lastNativeComposerHeight) return;
    state.lastNativeComposerHeight = height;
    document.documentElement.style.setProperty('--native-composer-h', `${height}px`);
  };

  const renderPendingNativeAttachments = (): void => {
    elements.nativeAttachmentQueue.hidden = state.pendingNativeAttachments.length === 0;
    elements.nativeAttachmentQueue.replaceChildren();
    for (const attachment of state.pendingNativeAttachments) {
      const card = document.createElement('article');
      card.className = 'native-attachment';
      const preview = document.createElement('div');
      preview.className = 'native-attachment__preview';
      if (attachment.previewDataUrl) {
        const image = document.createElement('img');
        image.alt = attachment.fileName;
        image.src = attachment.previewDataUrl;
        preview.append(image);
      } else {
        preview.textContent = '图片';
      }
      const copy = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = attachment.fileName;
      const meta = document.createElement('small');
      meta.textContent = `${attachment.width}×${attachment.height} · ${dependencies.formatAttachmentSize(attachment.sizeBytes)}`;
      copy.append(name, meta);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除图片 ${attachment.fileName}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        if (!state.activeNativeConversationId) return;
        remove.disabled = true;
        void window.controlPanel
          .removeNativeAttachment(state.activeNativeConversationId, attachment.attachmentId)
          .then(() => {
            const index = state.pendingNativeAttachments.findIndex(
              (item) => item.attachmentId === attachment.attachmentId,
            );
            if (index >= 0) state.pendingNativeAttachments.splice(index, 1);
            renderPendingNativeAttachments();
          })
          .catch(() => {
            remove.disabled = false;
            dependencies.showToast('无法移除这张图片。', 'error');
          });
      });
      card.append(preview, copy, remove);
      elements.nativeAttachmentQueue.append(card);
    }
  };

  const applyNativeAttachmentResult = (result: NativeAttachmentImportResult): void => {
    if (!result.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '无法安全导入图片。'),
        'error',
      );
      return;
    }
    state.pendingNativeAttachments.push(...result.attachments);
    renderPendingNativeAttachments();
    for (const attachment of result.attachments) {
      void window.controlPanel
        .readNativeAttachment(state.activeNativeConversationId, attachment.attachmentId)
        .then((view) => {
          if (!view?.previewDataUrl) return;
          const target = state.pendingNativeAttachments.find(
            (item) => item.attachmentId === attachment.attachmentId,
          );
          if (target) {
            target.previewDataUrl = view.previewDataUrl;
            renderPendingNativeAttachments();
          }
        })
        .catch(() => undefined);
    }
    if (result.attachments.length > 0) {
      dependencies.showToast(`已安全添加 ${result.attachments.length} 张图片。`);
    }
  };

  const nativeClipboardFileName = (file: File, index: number): string => {
    const name = file.name.replace(/[\\/]/g, '').trim();
    if (name && /\.(?:gif|jpe?g|png|webp)$/i.test(name)) return name;
    const extension =
      (
        {
          'image/gif': '.gif',
          'image/jpeg': '.jpg',
          'image/png': '.png',
          'image/webp': '.webp',
        } as Record<string, string>
      )[file.type.toLowerCase()] ?? '.png';
    return `${name || `粘贴图片-${index + 1}`}${extension}`;
  };

  const importNativeAttachments = async (files: File[]): Promise<void> => {
    if (!state.activeNativeConversationId || files.length === 0 || state.nativeAttachmentImporting)
      return;
    state.nativeAttachmentImporting = true;
    elements.nativeAttachButton.disabled = true;
    elements.nativeComposerStatus.textContent = '正在检查图片安全性…';
    try {
      const paths: string[] = [];
      const memoryFiles: File[] = [];
      for (const file of files.slice(0, 10 - state.pendingNativeAttachments.length)) {
        const filePath = window.controlPanel.getDroppedPath(file) ?? '';
        if (filePath) paths.push(filePath);
        else memoryFiles.push(file);
      }
      if (paths.length > 0) {
        applyNativeAttachmentResult(
          await window.controlPanel.importNativeAttachmentPaths(
            state.activeNativeConversationId,
            paths,
          ),
        );
      }
      if (memoryFiles.length > 0) {
        const sources = await Promise.all(
          memoryFiles.map(async (file, index) => ({
            bytes: await file.arrayBuffer(),
            fileName: nativeClipboardFileName(file, index),
          })),
        );
        applyNativeAttachmentResult(
          await window.controlPanel.importNativeAttachmentBytes(
            state.activeNativeConversationId,
            sources,
          ),
        );
      }
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法安全导入图片。',
        'error',
      );
    } finally {
      state.nativeAttachmentImporting = false;
      elements.nativeAttachmentInput.value = '';
      const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
      if (snapshot) renderNativeConversation(snapshot);
    }
  };

  return {
    applyNativeAttachmentResult,
    importNativeAttachments,
    nativeClipboardFileName,
    renderPendingNativeAttachments,
    resizeNativeComposer,
  };
};
