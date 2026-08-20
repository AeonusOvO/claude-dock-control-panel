import type { ChatElements } from './elements';
import {
  CHAT_TITLE_ERASE_MS,
  CHAT_TITLE_PHASE_PAUSE_MS,
  CHAT_TITLE_TYPE_MS,
  type ChatState,
} from './state';

export interface ChatTitleAnimationActions {
  cancelChatTitleAnimation: (conversationId: string) => void;
  startChatTitleAnimation: (conversationId: string, fromTitle: string, toTitle: string) => void;
}

export const createChatTitleAnimationActions = (
  state: ChatState,
  elements: ChatElements,
): ChatTitleAnimationActions => {
  const cancelChatTitleAnimation = (conversationId: string): void => {
    const animation = state.chatTitleAnimations.get(conversationId);
    if (!animation) {
      return;
    }
    window.clearTimeout(animation.timer);
    state.chatTitleAnimations.delete(conversationId);
  };

  const applyChatTitleFrame = (conversationId: string): void => {
    const animation = state.chatTitleAnimations.get(conversationId);
    const label = elements.chatHistoryList.querySelector<HTMLElement>(
      `strong[data-conversation-id="${CSS.escape(conversationId)}"]`,
    );
    if (!label) {
      return;
    }
    if (animation) {
      label.textContent = animation.chars.join('');
      label.dataset.titleTyping = 'true';
      return;
    }
    label.dataset.titleTyping = 'false';
  };

  const stepChatTitleAnimation = (conversationId: string): void => {
    const animation = state.chatTitleAnimations.get(conversationId);
    if (!animation) {
      return;
    }

    let delay: number;
    if (animation.phase === 'erasing') {
      if (animation.chars.length > animation.keep) {
        animation.chars.pop();
        delay = CHAT_TITLE_ERASE_MS;
      } else {
        animation.phase = 'typing';
        delay = CHAT_TITLE_PHASE_PAUSE_MS;
      }
    } else if (animation.chars.length < animation.target.length) {
      animation.chars.push(animation.target[animation.chars.length] ?? '');
      // Slightly uneven keystrokes read as typing rather than a mechanical ticker.
      delay = CHAT_TITLE_TYPE_MS + Math.random() * 42;
    } else {
      cancelChatTitleAnimation(conversationId);
      applyChatTitleFrame(conversationId);
      return;
    }

    applyChatTitleFrame(conversationId);
    animation.timer = window.setTimeout(() => {
      stepChatTitleAnimation(conversationId);
    }, delay);
  };

  const startChatTitleAnimation = (
    conversationId: string,
    fromTitle: string,
    toTitle: string,
  ): void => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cancelChatTitleAnimation(conversationId);
      applyChatTitleFrame(conversationId);
      return;
    }
    const existing = state.chatTitleAnimations.get(conversationId);
    // A retarget mid-animation continues from whatever is on screen right now.
    const chars = existing ? existing.chars : [...fromTitle];
    if (existing) {
      window.clearTimeout(existing.timer);
    }

    const target = [...toTitle];
    let keep = 0;
    while (keep < chars.length && keep < target.length && chars[keep] === target[keep]) {
      keep += 1;
    }

    const animation = {
      chars,
      keep,
      phase: chars.length > keep ? ('erasing' as const) : ('typing' as const),
      target,
      timer: 0,
    };
    state.chatTitleAnimations.set(conversationId, animation);
    applyChatTitleFrame(conversationId);
    animation.timer = window.setTimeout(() => {
      stepChatTitleAnimation(conversationId);
    }, CHAT_TITLE_ERASE_MS);
  };

  return { cancelChatTitleAnimation, startChatTitleAnimation };
};
