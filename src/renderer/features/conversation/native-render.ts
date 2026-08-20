import type {
  ConversationInteraction,
  ConversationSnapshot,
} from '../../../shared/conversation/native';
import type { ConversationActionsDependencies } from './dependencies';
import type { ConversationElements } from './elements';
import type { ConversationState } from './state';
import { nativeMessageRenderKey, type ConversationView } from './view';

export interface NativeRenderActions {
  renderNativeConversation: (snapshot: ConversationSnapshot) => void;
  scheduleNativeConversationRender: (snapshot: ConversationSnapshot) => void;
}

export const createNativeRenderActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationActionsDependencies,
  view: ConversationView,
  renderNativeInteraction: (interaction: ConversationInteraction) => HTMLElement,
  applyNativeComposerAction: () => void,
  renderNativeQueuedMessage: () => void,
  flushNativeQueuedMessage: (conversationId: string) => Promise<void>,
): NativeRenderActions => {
  const renderNativeConversation = (snapshot: ConversationSnapshot): void => {
    const recorded = state.nativeConversationSnapshots.get(snapshot.conversationId);
    if (
      recorded &&
      (recorded.revision > snapshot.revision ||
        (recorded.revision === snapshot.revision && recorded.sequence > snapshot.sequence))
    ) {
      return;
    }
    state.nativeConversationSnapshots.set(snapshot.conversationId, snapshot);
    if (snapshot.conversationId !== state.activeNativeConversationId) return;
    const nearBottom =
      elements.nativeConversationMessages.scrollHeight -
        elements.nativeConversationMessages.scrollTop -
        elements.nativeConversationMessages.clientHeight <
      96;
    const existing = new Map(
      [
        ...elements.nativeConversationMessages.querySelectorAll<HTMLElement>(
          '[data-native-message-id]',
        ),
      ].map((element) => [element.dataset.nativeMessageId ?? '', element]),
    );
    const ordered: HTMLElement[] = [];
    for (const message of snapshot.messages) {
      const previous = existing.get(message.id);
      if (previous) {
        const renderKey = nativeMessageRenderKey(message);
        if (state.nativeMessageRenderKeys.get(previous) !== renderKey) {
          view.updateNativeMessage(previous, message, renderKey);
        }
        existing.delete(message.id);
        ordered.push(previous);
      } else {
        ordered.push(view.renderNativeMessage(message));
      }
    }
    for (const stale of existing.values()) stale.remove();
    elements.nativeConversationEmpty.hidden = snapshot.messages.length > 0;
    // Reconcile in place rather than `replaceChildren(...)`. Passing the same nodes back still
    // detaches and reinserts all of them, which invalidates layout for the whole transcript on every
    // streamed frame. In the overwhelmingly common append-only case this touches nothing but the
    // one new node.
    if (elements.nativeConversationMessages.firstChild !== elements.nativeConversationEmpty) {
      elements.nativeConversationMessages.prepend(elements.nativeConversationEmpty);
    }
    let cursor: ChildNode | null = elements.nativeConversationEmpty.nextSibling;
    for (const node of ordered) {
      if (cursor === node) {
        cursor = node.nextSibling;
        continue;
      }
      elements.nativeConversationMessages.insertBefore(node, cursor);
    }
    const [activeInteraction] = snapshot.interactions;
    elements.nativeInteractionStack.dataset.pendingCount = String(snapshot.interactions.length);
    elements.nativeInteractionStack.replaceChildren(
      ...(activeInteraction ? [renderNativeInteraction(activeInteraction)] : []),
    );
    const capability = snapshot.capabilities;
    view.renderNativeFooter(snapshot);
    renderNativeQueuedMessage();
    applyNativeComposerAction();
    const submitting = state.nativeConversationSubmissions.has(snapshot.conversationId);
    const baseDisabled =
      state.nativeConversationStartingSessionId === dependencies.getActiveSessionId() ||
      submitting ||
      snapshot.phase === 'starting' ||
      snapshot.phase === 'stopped' ||
      snapshot.phase === 'failed';
    // 'running' stays enabled on purpose: the same button now carries both legitimate intents —
    // interrupt when the composer is empty, queue when it is not.
    elements.nativeSendButton.disabled =
      baseDisabled ||
      (elements.nativeSendButton.dataset.action === 'stop' && snapshot.phase === 'stopping');
    elements.nativeComposerInput.disabled =
      snapshot.phase === 'stopped' || snapshot.phase === 'failed';
    elements.nativeAttachButton.disabled = submitting || !capability?.attachments.image;
    // Only 'idle' may release the queue. 'requires-action' has a permission prompt open and sending
    // would jump the queue; 'failed'/'stopped' would resend into a dead session forever.
    if (
      snapshot.phase === 'idle' &&
      state.nativeQueuedAutoFlush.has(snapshot.conversationId) &&
      !state.nativeQueuedDispatch &&
      !submitting
    ) {
      void flushNativeQueuedMessage(snapshot.conversationId);
    }
    dependencies.renderRuntimeActivity();
    const status = dependencies.activeStatus();
    const nativeProjectState = status ? dependencies.getClaudeState(status.id) : undefined;
    const managedWindow = dependencies.managedContextWindowSelectable(
      nativeProjectState,
      snapshot.capabilities?.model,
    );
    const configuredNativeContextWindowTokens = managedWindow
      ? dependencies.getManagedChatGptContextWindowMode() === 'extended'
        ? 1_050_000
        : 272_000
      : dependencies.requestedClaudeContextWindowTokens();
    // Prefer a real SDK value when one is eventually exposed. Until then the configured target is
    // useful for estimating usage, but it is labelled as unverified rather than as status-line data.
    const reportedNativeContextWindowTokens = snapshot.usage.contextWindowTokens;
    const nativeContextWindowTokens =
      reportedNativeContextWindowTokens ?? configuredNativeContextWindowTokens;
    const nativeInputTokens = snapshot.usage.inputTokens;
    const nativeContextUsedPercent =
      nativeContextWindowTokens !== undefined && nativeInputTokens !== undefined
        ? Math.min(100, Math.max(0, (nativeInputTokens / nativeContextWindowTokens) * 100))
        : undefined;
    dependencies.renderFooterResource(
      {
        availability: nativeContextWindowTokens === undefined ? 'unavailable' : 'available',
        capabilities: {
          balance: false,
          context: nativeContextWindowTokens !== undefined,
          windows: false,
        },
        checkedAt: Date.now(),
        contextUsedPercent: nativeContextUsedPercent,
        contextUsedTokens: nativeInputTokens,
        contextWindowTokens: nativeContextWindowTokens,
        detail:
          reportedNativeContextWindowTokens === undefined
            ? 'Agent SDK 未上报窗口容量；这里仅显示配置目标，不能证明端点实际上限。'
            : undefined,
        source:
          reportedNativeContextWindowTokens === undefined
            ? 'claude-configured-target'
            : 'claude-agent-sdk',
      },
      managedWindow,
    );
    if (nearBottom)
      elements.nativeConversationMessages.scrollTop =
        elements.nativeConversationMessages.scrollHeight;
  };

  const scheduleNativeConversationRender = (snapshot: ConversationSnapshot): void => {
    const pending = state.pendingNativeConversationRenders.get(snapshot.conversationId);
    if (
      pending &&
      (pending.revision > snapshot.revision ||
        (pending.revision === snapshot.revision && pending.sequence >= snapshot.sequence))
    ) {
      return;
    }
    state.pendingNativeConversationRenders.set(snapshot.conversationId, snapshot);
    if (state.nativeConversationRenderFrame !== undefined) return;
    state.nativeConversationRenderFrame = window.requestAnimationFrame(() => {
      state.nativeConversationRenderFrame = undefined;
      const snapshots = [...state.pendingNativeConversationRenders.values()];
      state.pendingNativeConversationRenders.clear();
      for (const pendingSnapshot of snapshots) renderNativeConversation(pendingSnapshot);
    });
  };

  return {
    renderNativeConversation,
    scheduleNativeConversationRender,
  };
};
