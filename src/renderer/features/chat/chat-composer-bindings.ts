import type { ChatAttachmentImportResult, ChatStreamEvent } from '../../../shared/contracts';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatComposerBindings {
  bindChatComposer: () => () => void;
}

export const createChatComposerBindings = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  view: ChatView,
  resizeChatComposer: () => void,
  setChatBusy: (busy: boolean) => void,
  queueChatAttachmentImport: (files: File[]) => void,
  applyChatAttachmentImportResult: (result: ChatAttachmentImportResult) => void,
  handleChatStream: (event: ChatStreamEvent) => void,
  resetChatConversation: () => void,
  submitChatMessage: () => Promise<void>,
): ChatComposerBindings => {
  const bindChatComposer = (): (() => void) => {
    const disposers: Array<() => void> = [];

    const handleComposerSubmit = (event: SubmitEvent): void => {
      event.preventDefault();
      void submitChatMessage();
    };
    dependencies.chatComposer.addEventListener('submit', handleComposerSubmit);
    disposers.push(() =>
      dependencies.chatComposer.removeEventListener('submit', handleComposerSubmit),
    );

    const handleAttachClick = (): void => {
      elements.chatAttachmentInput.click();
    };
    elements.chatAttachButton.addEventListener('click', handleAttachClick);
    disposers.push(() => elements.chatAttachButton.removeEventListener('click', handleAttachClick));

    const handleAttachmentInputChange = (): void => {
      queueChatAttachmentImport(Array.from(elements.chatAttachmentInput.files ?? []));
    };
    elements.chatAttachmentInput.addEventListener('change', handleAttachmentInputChange);
    disposers.push(() =>
      elements.chatAttachmentInput.removeEventListener('change', handleAttachmentInputChange),
    );

    const handleInputKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void submitChatMessage();
      }
    };
    elements.chatInput.addEventListener('keydown', handleInputKeydown);
    disposers.push(() => elements.chatInput.removeEventListener('keydown', handleInputKeydown));

    const handleInputInput = (): void => {
      view.renderChatUsage();
      resizeChatComposer();
    };
    elements.chatInput.addEventListener('input', handleInputInput);
    disposers.push(() => elements.chatInput.removeEventListener('input', handleInputInput));

    const handleInputPaste = (event: ClipboardEvent): void => {
      const clipboard = event.clipboardData;
      if (!clipboard) {
        return;
      }
      const itemFiles = [...clipboard.items]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      const files = itemFiles.length > 0 ? itemFiles : Array.from(clipboard.files);
      if (files.length > 0) {
        // Let the file(s) become attachments and keep any co-pasted text out of the textarea, matching
        // how claude.ai treats a paste that carries both a rendering and its source bytes.
        event.preventDefault();
        queueChatAttachmentImport(files);
        return;
      }
      if ([...clipboard.types].some((type) => type.toLowerCase().startsWith('image/'))) {
        event.preventDefault();
        state.queuedChatAttachmentImports += 1;
        setChatBusy(Boolean(state.activeChatRequestId));
        void window.controlPanel
          .importChatClipboardImage(state.activeChatAttachmentDraftId)
          .then(applyChatAttachmentImportResult)
          .catch(() => dependencies.showToast('无法读取 Windows 剪贴板图片。', 'error'))
          .finally(() => {
            state.queuedChatAttachmentImports = Math.max(0, state.queuedChatAttachmentImports - 1);
            setChatBusy(Boolean(state.activeChatRequestId));
          });
        return;
      }
      // No files: fall through to the browser's own plain-text insertion.
    };
    elements.chatInput.addEventListener('paste', handleInputPaste);
    disposers.push(() => elements.chatInput.removeEventListener('paste', handleInputPaste));

    const handleStopClick = (): void => {
      if (state.activeChatRequestId) {
        void window.controlPanel.stopChat(state.activeChatRequestId);
      }
    };
    elements.stopChatButton.addEventListener('click', handleStopClick);
    disposers.push(() => elements.stopChatButton.removeEventListener('click', handleStopClick));

    const handleNewChatClick = (): void => {
      resetChatConversation();
      elements.chatInput.focus();
    };
    elements.newChatButton.addEventListener('click', handleNewChatClick);
    disposers.push(() => elements.newChatButton.removeEventListener('click', handleNewChatClick));

    window.controlPanel.onChatStream(handleChatStream);

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  };

  return {
    bindChatComposer,
  };
};
