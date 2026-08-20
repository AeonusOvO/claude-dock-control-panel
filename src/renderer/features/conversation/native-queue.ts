import type { NativeAttachmentView } from '../../../shared/conversation/native';
import type { ConversationElements } from './elements';
import type { ConversationState } from './state';

export interface NativeQueueActions {
  drainNativeQueuedMessageToComposer: (conversationId: string) => void;
  enqueueNativeMessage: (
    conversationId: string,
    text: string,
    attachments: NativeAttachmentView[],
    options: { autoFlush: boolean },
  ) => void;
  renderNativeQueuedMessage: () => void;
}

export const createNativeQueueActions = (
  elements: ConversationElements,
  state: ConversationState,
  applyNativeComposerAction: () => void,
  resizeNativeComposer: () => void,
  renderPendingNativeAttachments: () => void,
): NativeQueueActions => {
  const renderNativeQueuedMessage = (): void => {
    const conversationId = state.activeNativeConversationId;
    const dispatching =
      state.nativeQueuedDispatch && state.nativeQueuedDispatch.conversationId === conversationId
        ? state.nativeQueuedDispatch.message
        : undefined;
    const queued =
      dispatching ?? (conversationId ? state.nativeQueuedMessages.get(conversationId) : undefined);
    // `renderNativeConversation` calls this on every streamed frame, and it ends in
    // `resizeNativeComposer()`, which forces two synchronous layouts. The queued bar changes only on
    // deliberate user action, so skipping the unchanged case keeps the reflows off the stream path.
    const signature =
      !conversationId || !queued
        ? ''
        : [
            conversationId,
            dispatching ? 'dispatching' : 'queued',
            state.nativeQueuedAutoFlush.has(conversationId) ? 'auto' : 'manual',
            queued.attachments.length,
            queued.text,
          ].join('\u0000');
    if (signature === state.lastNativeQueuedSignature) return;
    state.lastNativeQueuedSignature = signature;
    if (!conversationId || !queued) {
      elements.nativeQueued.hidden = true;
      elements.nativeQueuedText.textContent = '';
      elements.nativeQueuedHint.textContent = '';
      resizeNativeComposer();
      return;
    }
    const attachmentNote = queued.attachments.length
      ? ` · ${queued.attachments.length} 个附件`
      : '';
    elements.nativeQueued.hidden = false;
    elements.nativeQueued.dataset.state = dispatching ? 'dispatching' : 'queued';
    elements.nativeQueuedText.textContent = queued.text;
    elements.nativeQueuedHint.textContent = dispatching
      ? `正在发送…${attachmentNote}`
      : state.nativeQueuedAutoFlush.has(conversationId)
        ? `本轮结束后自动发送${attachmentNote}`
        : `本轮已中断 · 点击「立即发送」继续${attachmentNote}`;
    elements.nativeQueuedSend.hidden = Boolean(dispatching);
    elements.nativeQueuedCancel.hidden = Boolean(dispatching);
    resizeNativeComposer();
  };

  /**
   * Parks content above the send row. At most one entry per conversation: a second Enter appends with
   * a blank line rather than growing a list, so the bar can never turn into a second transcript.
   */
  const enqueueNativeMessage = (
    conversationId: string,
    text: string,
    attachments: NativeAttachmentView[],
    options: { autoFlush: boolean },
  ): void => {
    const existing = state.nativeQueuedMessages.get(conversationId);
    const addition = text.trim();
    const merged = existing?.text
      ? addition
        ? `${existing.text}\n\n${addition}`
        : existing.text
      : addition;
    state.nativeQueuedMessages.set(conversationId, {
      attachments: [...(existing?.attachments ?? []), ...attachments],
      text: merged,
    });
    if (options.autoFlush) state.nativeQueuedAutoFlush.add(conversationId);
    else state.nativeQueuedAutoFlush.delete(conversationId);
    renderNativeQueuedMessage();
    applyNativeComposerAction();
  };

  /** Folds a queued entry back into the composer so the existing draft-preservation path carries it. */
  const drainNativeQueuedMessageToComposer = (conversationId: string): void => {
    const queued = state.nativeQueuedMessages.get(conversationId);
    state.nativeQueuedAutoFlush.delete(conversationId);
    if (!queued) return;
    state.nativeQueuedMessages.delete(conversationId);
    if (queued.text) {
      const current = elements.nativeComposerInput.value;
      elements.nativeComposerInput.value = current ? `${queued.text}\n\n${current}` : queued.text;
    }
    for (const attachment of queued.attachments) {
      const known = state.pendingNativeAttachments.some(
        (candidate) => candidate.attachmentId === attachment.attachmentId,
      );
      if (!known) state.pendingNativeAttachments.push(attachment);
    }
    renderPendingNativeAttachments();
    renderNativeQueuedMessage();
    resizeNativeComposer();
    applyNativeComposerAction();
  };

  return {
    drainNativeQueuedMessageToComposer,
    enqueueNativeMessage,
    renderNativeQueuedMessage,
  };
};
