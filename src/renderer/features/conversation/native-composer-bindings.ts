import type { ConversationSnapshot } from '../../../shared/conversation/native';
import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationLaunchActionsDependencies } from './launch-dependencies';
import type { ConversationState } from './state';

export interface NativeComposerBindings {
  bindNativeComposer: () => () => void;
}

export const createNativeComposerBindings = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationLaunchActionsDependencies,
  actions: ConversationActions,
  handleNativeSlashCommand: (rawInput: string, snapshot: ConversationSnapshot) => Promise<boolean>,
): NativeComposerBindings => {
  const runNativeComposerSubmit = async (): Promise<void> => {
    const text = elements.nativeComposerInput.value;
    const conversationId = state.activeNativeConversationId;
    if (
      !conversationId ||
      (!text.trim() && state.pendingNativeAttachments.length === 0) ||
      elements.nativeSendButton.disabled ||
      state.nativeConversationSubmissions.has(conversationId)
    )
      return;
    const nativeSnapshot = state.nativeConversationSnapshots.get(conversationId);
    if (
      nativeSnapshot &&
      text.trim().startsWith('/') &&
      state.pendingNativeAttachments.length === 0
    ) {
      elements.nativeSendButton.disabled = true;
      try {
        const handled = await handleNativeSlashCommand(text, nativeSnapshot);
        if (handled) {
          elements.nativeComposerInput.value = '';
          delete elements.nativeComposerInput.dataset.recoveredDraft;
          actions.resizeNativeComposer();
          return;
        }
      } catch (error) {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法执行这个原生命令。',
          'error',
        );
        return;
      } finally {
        elements.nativeSendButton.disabled = false;
        actions.applyNativeComposerAction();
      }
    }
    // The composer is cleared up front and the content is owned by either the queued bar or the
    // in-flight submission from here on, so nothing the user types during the acknowledgement window
    // can be erased by a late response.
    const attachments = state.pendingNativeAttachments.splice(0);
    elements.nativeComposerInput.value = '';
    delete elements.nativeComposerInput.dataset.recoveredDraft;
    actions.renderPendingNativeAttachments();
    actions.resizeNativeComposer();
    actions.playNativeSendAnimation();
    if (
      nativeSnapshot &&
      (nativeSnapshot.phase === 'running' || nativeSnapshot.phase === 'stopping')
    ) {
      // Typing must never destroy a reply that is still streaming. Park it and let the idle snapshot
      // release it; Esc remains the explicit way to interrupt.
      actions.enqueueNativeMessage(conversationId, text, attachments, { autoFlush: true });
      return;
    }
    await actions.deliverNativeMessage(conversationId, text, attachments);
  };

  const bindNativeComposer = (): (() => void) => {
    const disposers: Array<() => void> = [];

    const handleNativeComposerSubmit = (event: SubmitEvent): void => {
      event.preventDefault();
      void runNativeComposerSubmit();
    };
    elements.nativeComposer.addEventListener('submit', handleNativeComposerSubmit);
    disposers.push(() =>
      elements.nativeComposer.removeEventListener('submit', handleNativeComposerSubmit),
    );
    const handleNativeSendClick = (event: MouseEvent): void => {
      if (elements.nativeSendButton.dataset.action !== 'stop') return;
      // Stop is not a submission: swallow the event before the form hears it.
      event.preventDefault();
      actions.interruptNativeTurn();
    };
    elements.nativeSendButton.addEventListener('click', handleNativeSendClick);
    disposers.push(() =>
      elements.nativeSendButton.removeEventListener('click', handleNativeSendClick),
    );
    const handleNativeSendAnimationEnd = (event: AnimationEvent): void => {
      // The stop halo lives on ::after; only the element's own animation ends a send.
      if (event.pseudoElement) return;
      if (event.target === elements.nativeSendButton) actions.finishNativeSendAnimation();
    };
    elements.nativeSendButton.addEventListener('animationend', handleNativeSendAnimationEnd);
    disposers.push(() =>
      elements.nativeSendButton.removeEventListener('animationend', handleNativeSendAnimationEnd),
    );
    const handleNativeQueuedSendClick = (): void => {
      const conversationId = state.activeNativeConversationId;
      if (!conversationId) return;
      const snapshot = state.nativeConversationSnapshots.get(conversationId);
      if (snapshot && (snapshot.phase === 'running' || snapshot.phase === 'stopping')) {
        state.nativeQueuedAutoFlush.add(conversationId);
        actions.interruptNativeTurn({ keepQueued: true });
        return;
      }
      void actions.flushNativeQueuedMessage(conversationId);
    };
    elements.nativeQueuedSend.addEventListener('click', handleNativeQueuedSendClick);
    disposers.push(() =>
      elements.nativeQueuedSend.removeEventListener('click', handleNativeQueuedSendClick),
    );
    const handleNativeQueuedCancelClick = (): void => {
      if (!state.activeNativeConversationId) return;
      actions.drainNativeQueuedMessageToComposer(state.activeNativeConversationId);
      elements.nativeComposerInput.focus();
    };
    elements.nativeQueuedCancel.addEventListener('click', handleNativeQueuedCancelClick);
    disposers.push(() =>
      elements.nativeQueuedCancel.removeEventListener('click', handleNativeQueuedCancelClick),
    );
    const handleNativeComposerInput = (): void => {
      delete elements.nativeComposerInput.dataset.recoveredDraft;
      actions.resizeNativeComposer();
      actions.applyNativeComposerAction();
    };
    elements.nativeComposerInput.addEventListener('input', handleNativeComposerInput);
    disposers.push(() =>
      elements.nativeComposerInput.removeEventListener('input', handleNativeComposerInput),
    );
    const handleNativeComposerKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
        if (!snapshot || (snapshot.phase !== 'running' && snapshot.phase !== 'stopping')) return;
        event.preventDefault();
        event.stopPropagation();
        actions.interruptNativeTurn();
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      elements.nativeComposer.requestSubmit();
    };
    elements.nativeComposerInput.addEventListener('keydown', handleNativeComposerKeydown);
    disposers.push(() =>
      elements.nativeComposerInput.removeEventListener('keydown', handleNativeComposerKeydown),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  };

  return {
    bindNativeComposer,
  };
};
