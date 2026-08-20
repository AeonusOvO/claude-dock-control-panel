import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationLaunchActionsDependencies } from './launch-dependencies';
import type { ConversationState } from './state';

export interface NativeAttachmentBindings {
  bindNativeAttachments: () => () => void;
}

export const createNativeAttachmentBindings = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationLaunchActionsDependencies,
  actions: ConversationActions,
): NativeAttachmentBindings => {
  const bindNativeAttachments = (): (() => void) => {
    const disposers: Array<() => void> = [];

    const handleNativeAttachClick = (): void => elements.nativeAttachmentInput.click();
    elements.nativeAttachButton.addEventListener('click', handleNativeAttachClick);
    disposers.push(() =>
      elements.nativeAttachButton.removeEventListener('click', handleNativeAttachClick),
    );
    const handleNativeAttachmentInputChange = (): void => {
      void actions.importNativeAttachments(Array.from(elements.nativeAttachmentInput.files ?? []));
    };
    elements.nativeAttachmentInput.addEventListener('change', handleNativeAttachmentInputChange);
    disposers.push(() =>
      elements.nativeAttachmentInput.removeEventListener(
        'change',
        handleNativeAttachmentInputChange,
      ),
    );
    const handleNativeComposerPaste = (event: ClipboardEvent): void => {
      const clipboardData = event.clipboardData;
      if (!clipboardData || !state.activeNativeConversationId) return;
      const itemFiles = [...clipboardData.items]
        .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      const files =
        itemFiles.length > 0
          ? itemFiles
          : [...clipboardData.files].filter((file) => file.type.startsWith('image/'));
      if (files.length > 0) {
        event.preventDefault();
        void actions.importNativeAttachments(files);
        return;
      }
      const likelyImage = [...clipboardData.types].some((type) =>
        type.toLowerCase().startsWith('image/'),
      );
      if (!likelyImage) return;
      event.preventDefault();
      state.nativeAttachmentImporting = true;
      elements.nativeAttachButton.disabled = true;
      void window.controlPanel
        .importNativeClipboardImage(state.activeNativeConversationId)
        .then(actions.applyNativeAttachmentResult)
        .catch(() => dependencies.showToast('无法读取 Windows 剪贴板图片。', 'error'))
        .finally(() => {
          state.nativeAttachmentImporting = false;
          const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
          if (snapshot) actions.renderNativeConversation(snapshot);
        });
    };
    elements.nativeComposerInput.addEventListener('paste', handleNativeComposerPaste);
    disposers.push(() =>
      elements.nativeComposerInput.removeEventListener('paste', handleNativeComposerPaste),
    );
    const handleNativeConversationDragover = (event: DragEvent): void => {
      if ([...(event.dataTransfer?.items ?? [])].some((item) => item.type.startsWith('image/'))) {
        event.preventDefault();
        event.dataTransfer!.dropEffect = 'copy';
      }
    };
    elements.nativeConversation.addEventListener('dragover', handleNativeConversationDragover);
    disposers.push(() =>
      elements.nativeConversation.removeEventListener('dragover', handleNativeConversationDragover),
    );
    const handleNativeConversationDrop = (event: DragEvent): void => {
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void actions.importNativeAttachments(files);
    };
    elements.nativeConversation.addEventListener('drop', handleNativeConversationDrop);
    disposers.push(() =>
      elements.nativeConversation.removeEventListener('drop', handleNativeConversationDrop),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  };

  return {
    bindNativeAttachments,
  };
};
