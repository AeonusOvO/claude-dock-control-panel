import type { ChatAttachmentImportResult } from '../../../shared/contracts';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import { EXTENSION_BY_MEDIA_TYPE, type ChatState } from './state';

export type ChatAttachmentImportCompletion = (succeeded: boolean) => void;

export interface ChatAttachmentImportActions {
  importChatAttachments: (files: File[]) => Promise<boolean>;
  queueChatAttachmentImport: (
    files: File[],
    onComplete?: ChatAttachmentImportCompletion,
  ) => boolean;
}

export const createChatAttachmentImportActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  setChatBusy: (busy: boolean) => void,
  applyChatAttachmentImportResult: (result: ChatAttachmentImportResult) => void,
): ChatAttachmentImportActions => {
  const pastedFileName = (file: File, index: number): string => {
    const name = file.name.replace(/[\\/]/g, '').trim();
    if (name && /\.[a-z0-9]{1,8}$/i.test(name)) {
      return name;
    }
    const extension = EXTENSION_BY_MEDIA_TYPE[file.type.toLowerCase()] ?? '.png';
    return `${name || `粘贴内容-${index + 1}`}${extension}`;
  };

  const importChatAttachments = async (files: File[]): Promise<boolean> => {
    const remaining = 10 - state.pendingChatAttachments.length;
    if (remaining <= 0) {
      dependencies.showToast('每条消息最多添加 10 个附件。', 'error');
      return false;
    }
    const selected = files.slice(0, remaining);
    // Files dropped or picked from disk expose a native path; clipboard payloads do not, so they
    // travel to the main process as bytes instead. One paste can contain both kinds.
    const paths: string[] = [];
    const inMemory: File[] = [];
    for (const file of selected) {
      let filePath: string;
      try {
        filePath = window.controlPanel.getDroppedPath(file) ?? '';
      } catch {
        filePath = '';
      }
      if (filePath) {
        paths.push(filePath);
      } else {
        inMemory.push(file);
      }
    }
    if (paths.length === 0 && inMemory.length === 0) {
      dependencies.showToast('无法读取所选附件的内容。', 'error');
      return false;
    }
    try {
      let succeeded = true;
      if (paths.length > 0) {
        const result = await window.controlPanel.importChatAttachments({
          draftId: state.activeChatAttachmentDraftId,
          paths,
        });
        applyChatAttachmentImportResult(result);
        succeeded = result.ok;
      }
      if (inMemory.length > 0) {
        const sources = await Promise.all(
          inMemory.map(async (file, index) => ({
            bytes: await file.arrayBuffer(),
            fileName: pastedFileName(file, index),
          })),
        );
        const result = await window.controlPanel.importChatAttachmentBytes({
          draftId: state.activeChatAttachmentDraftId,
          sources,
        });
        applyChatAttachmentImportResult(result);
        succeeded = result.ok && succeeded;
      }
      return succeeded;
    } catch (error) {
      dependencies.showToast(error instanceof Error ? error.message : '无法导入附件。', 'error');
      return false;
    } finally {
      elements.chatAttachmentInput.value = '';
    }
  };

  const queueChatAttachmentImport = (
    files: File[],
    onComplete?: ChatAttachmentImportCompletion,
  ): boolean => {
    if (files.length === 0 || state.activeChatRequestId || state.chatSubmissionInFlight) {
      return false;
    }
    state.queuedChatAttachmentImports += 1;
    setChatBusy(Boolean(state.activeChatRequestId));
    const queued = state.chatAttachmentImportQueue.then(() => importChatAttachments(files));
    state.chatAttachmentImportQueue = queued
      .catch(() => false)
      .then((succeeded) => {
        try {
          onComplete?.(succeeded);
        } catch {
          // Completion observers must not break the serialized import queue.
        }
      })
      .finally(() => {
        state.queuedChatAttachmentImports = Math.max(0, state.queuedChatAttachmentImports - 1);
        setChatBusy(Boolean(state.activeChatRequestId));
      });
    return true;
  };

  return {
    importChatAttachments,
    queueChatAttachmentImport,
  };
};
