import type { ConversationSnapshot } from '../../../shared/conversation/native';
import type { ConversationElements } from './elements';
import type { ConversationState, NativeComposerAction } from './state';
import { nativePhaseLabel } from './view';

export interface NativeComposerActions {
  applyNativeComposerAction: () => void;
  finishNativeSendAnimation: () => void;
  playNativeSendAnimation: () => void;
}

export const createNativeComposerActions = (
  elements: ConversationElements,
  state: ConversationState,
): NativeComposerActions => {
  const nativeComposerHasIntent = (): boolean =>
    elements.nativeComposerInput.value.trim().length > 0 ||
    state.pendingNativeAttachments.length > 0;

  /**
   * Stop is only offered when there is a turn to stop AND nothing the user is about to send: typing
   * during a reply means the next intent is "send", so the button must return to its theme send face
   * rather than sit there as a trap that throws away the reply being streamed.
   */
  const deriveNativeComposerAction = (
    snapshot: ConversationSnapshot | undefined,
  ): NativeComposerAction => {
    if (!snapshot) return 'send';
    if (snapshot.phase !== 'running' && snapshot.phase !== 'stopping') return 'send';
    // The swap waits for the send animation to finish so it is tied to what the user saw, not to how
    // fast the main process acknowledged the submission.
    if (state.nativeSendAnimating) return 'send';
    if (nativeComposerHasIntent()) return 'send';
    return 'stop';
  };

  const nativeComposerStatusText = (snapshot: ConversationSnapshot): string => {
    if (snapshot.phase !== 'running' && snapshot.phase !== 'stopping') {
      return nativePhaseLabel(snapshot.phase);
    }
    return nativeComposerHasIntent()
      ? '回复生成中 · Enter 将排队发送 · Esc 中断'
      : '回复生成中 · 点击停止可中断 · Esc 同样中断';
  };

  /** The only writer of the action button's `data-action`, label and stop-halo marker. */
  const applyNativeComposerAction = (): void => {
    const snapshot = state.activeNativeConversationId
      ? state.nativeConversationSnapshots.get(state.activeNativeConversationId)
      : undefined;
    const action = deriveNativeComposerAction(snapshot);
    elements.nativeSendButton.dataset.action = action;
    if (action !== 'stop') delete elements.nativeSendButton.dataset.stopping;
    elements.nativeSendButton.title =
      action === 'stop' ? '中断当前回合（Esc）' : '发送消息（Enter）';
    elements.nativeSendButton.setAttribute(
      'aria-label',
      action === 'stop' ? '中断当前回合' : '发送消息',
    );
    if (snapshot) elements.nativeComposerStatus.textContent = nativeComposerStatusText(snapshot);
  };

  const finishNativeSendAnimation = (): void => {
    if (state.nativeSendAnimationTimer !== undefined) {
      window.clearTimeout(state.nativeSendAnimationTimer);
      state.nativeSendAnimationTimer = undefined;
    }
    if (!state.nativeSendAnimating) return;
    state.nativeSendAnimating = false;
    delete elements.nativeSendButton.dataset.sending;
    applyNativeComposerAction();
  };

  /**
   * Plays the theme's outgoing animation. The watchdog matters because `prefers-reduced-motion` cuts
   * the duration to `--dur-instant`; if a dropped frame ever swallowed `animationend` the button
   * would be stranded in its send face while a turn is running.
   */
  const playNativeSendAnimation = (): void => {
    finishNativeSendAnimation();
    state.nativeSendAnimating = true;
    delete elements.nativeSendButton.dataset.sending;
    // Restart the theme-owned confirmation motion even when two sends finish in quick succession.
    void elements.nativeSendButton.offsetWidth;
    elements.nativeSendButton.dataset.sending = 'true';
    applyNativeComposerAction();
    state.nativeSendAnimationTimer = window.setTimeout(finishNativeSendAnimation, 600);
  };

  return {
    applyNativeComposerAction,
    finishNativeSendAnimation,
    playNativeSendAnimation,
  };
};
