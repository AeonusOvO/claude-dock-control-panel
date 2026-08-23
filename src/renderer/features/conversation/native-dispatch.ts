import type {
  ConversationSnapshot,
  NativeAttachmentView,
} from '../../../shared/conversation/native';
import type { ConversationActionsDependencies } from './dependencies';
import type { ConversationElements } from './elements';
import type { ConversationState } from './state';

export interface NativeDispatchActions {
  deliverNativeMessage: (
    conversationId: string,
    text: string,
    attachments: NativeAttachmentView[],
  ) => Promise<boolean>;
  flushNativeQueuedMessage: (conversationId: string) => Promise<void>;
  interruptNativeTurn: (options?: { keepQueued?: boolean }) => void;
}

export const createNativeDispatchActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationActionsDependencies,
  renderNativeConversation: (snapshot: ConversationSnapshot) => void,
  applyNativeComposerAction: () => void,
  enqueueNativeMessage: (
    conversationId: string,
    text: string,
    attachments: NativeAttachmentView[],
    options: { autoFlush: boolean },
  ) => void,
  renderNativeQueuedMessage: () => void,
): NativeDispatchActions => {
  /**
   * Hands one message to the adapter. Nothing is lost on failure: a rejected or cancelled delivery is
   * put straight back into the queued bar instead of vanishing from both the composer and the
   * transcript.
   */
  const deliverNativeMessage = async (
    conversationId: string,
    text: string,
    attachments: NativeAttachmentView[],
  ): Promise<boolean> => {
    const clientSubmissionId = crypto.randomUUID();
    const blocks = [
      ...(text.trim() ? [{ text, type: 'text' as const }] : []),
      ...attachments.map((attachment) => ({
        attachment: {
          id: attachment.attachmentId,
          mediaType: attachment.mediaType,
          name: attachment.fileName,
          size: attachment.sizeBytes,
        },
        type: 'image' as const,
      })),
    ];
    state.nativeConversationSubmissions.set(conversationId, clientSubmissionId);
    elements.nativeComposerStatus.textContent = '正在安全保存并提交…';
    let delivered = false;
    try {
      const outcome = await state.nativeSubmits.submit({
        deliver: async () => {
          const result = await window.controlPanel.submitNativeConversation(conversationId, {
            blocks,
            clientSubmissionId,
          });
          if (!result.ok) {
            dependencies.showToast(
              dependencies.resultFailureMessage(result, '本次输入尚未发送。'),
              'error',
            );
            return false;
          }
          if (result.snapshot) renderNativeConversation(result.snapshot);
          return true;
        },
        onCancelled: () => {
          enqueueNativeMessage(conversationId, text, attachments, { autoFlush: false });
        },
        onDelivered: () => {
          // The IPC stays pending until the foreground turn ends. A newer message may have been
          // parked while it was in flight; a late acknowledgement must not clear that queue's
          // auto-flush intent.
          if (!state.nativeQueuedMessages.has(conversationId)) {
            state.nativeQueuedAutoFlush.delete(conversationId);
          }
        },
      });
      delivered = outcome === 'delivered';
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '本次输入尚未发送。',
        'error',
      );
      enqueueNativeMessage(conversationId, text, attachments, { autoFlush: false });
    } finally {
      if (state.nativeConversationSubmissions.get(conversationId) === clientSubmissionId) {
        state.nativeConversationSubmissions.delete(conversationId);
      }
      if (state.nativeQueuedDispatch?.conversationId === conversationId)
        state.nativeQueuedDispatch = undefined;
      renderNativeQueuedMessage();
      const latest = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
      if (latest) renderNativeConversation(latest);
      else applyNativeComposerAction();
    }
    if (!delivered && state.activeNativeConversationId === conversationId)
      elements.nativeComposerInput.focus();
    return delivered;
  };

  const flushNativeQueuedMessage = async (conversationId: string): Promise<void> => {
    const queued = state.nativeQueuedMessages.get(conversationId);
    if (
      !queued ||
      state.nativeQueuedDispatch ||
      state.nativeConversationSubmissions.has(conversationId)
    )
      return;
    state.nativeQueuedMessages.delete(conversationId);
    state.nativeQueuedAutoFlush.delete(conversationId);
    state.nativeQueuedDispatch = { conversationId, message: queued };
    renderNativeQueuedMessage();
    await deliverNativeMessage(conversationId, queued.text, queued.attachments);
  };

  /**
   * Stops the running turn. `keepQueued` is what separates 「立即发送」 (interrupt, then let the idle
   * snapshot dispatch the parked text) from a plain stop (interrupt and leave the text parked for the
   * user to release manually).
   */
  const interruptNativeTurn = (options: { keepQueued?: boolean } = {}): void => {
    const conversationId = state.activeNativeConversationId;
    if (!conversationId) return;
    const snapshot = state.nativeConversationSnapshots.get(conversationId);
    if (!snapshot || (snapshot.phase !== 'running' && snapshot.phase !== 'stopping')) return;
    if (!options.keepQueued) state.nativeQueuedAutoFlush.delete(conversationId);
    elements.nativeSendButton.dataset.stopping = 'true';
    elements.nativeSendButton.disabled = true;
    void window.controlPanel
      .interruptNativeConversation(conversationId)
      .then((result) => {
        if (!result.ok) {
          dependencies.showToast(
            dependencies.resultFailureMessage(result, '无法中断当前轮次。'),
            'error',
          );
        }
      })
      .catch(() => dependencies.showToast('无法中断当前轮次。', 'error'))
      .finally(() => {
        elements.nativeSendButton.disabled = false;
        renderNativeQueuedMessage();
        applyNativeComposerAction();
      });
  };

  return {
    deliverNativeMessage,
    flushNativeQueuedMessage,
    interruptNativeTurn,
  };
};
