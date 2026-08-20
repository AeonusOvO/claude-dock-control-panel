import type { TerminalElements } from './elements';
import type { TerminalLayoutDependencies } from './terminal-layout-dependencies';
import type { TerminalState } from './state';

export interface TerminalLayoutComposerActions {
  focusComposer: () => boolean;
  flushPendingComposerFocus: () => void;
  playSendAnimation: (
    text: string,
    source?: HTMLTextAreaElement,
    variant?: 'terminal' | 'chat',
  ) => void;
  requestComposerFocus: (sessionId?: string) => void;
  resizeComposer: () => void;
  setComposerEnabled: (enabled: boolean) => void;
}

export const createTerminalLayoutComposerActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalLayoutDependencies,
): TerminalLayoutComposerActions => {
  /** Grows the textarea with its content up to `--composer-max`, then scrolls. */
  const resizeComposer = (): void => {
    elements.composerInput.style.height = 'auto';
    const maxHeight = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--composer-max'),
    );
    const height = Number.isFinite(maxHeight)
      ? Math.min(elements.composerInput.scrollHeight, maxHeight)
      : elements.composerInput.scrollHeight;
    elements.composerInput.style.height = `${height}px`;
    // The workbench drawer is absolutely positioned against the shell, so it needs the live height.
    document.documentElement.style.setProperty(
      '--composer-h',
      `${Math.round(elements.composerForm.getBoundingClientRect().height)}px`,
    );
  };

  /* The keyboard hints live in the placeholder, so they vanish the moment the user starts typing. */
  const COMPOSER_PLACEHOLDER = '输入提示词　·　Enter 发送　·　Shift+Enter 换行　·　↑↓ 翻阅历史';

  const setComposerEnabled = (enabled: boolean): void => {
    elements.composerInput.disabled = !enabled;
    elements.composerSendButton.disabled = !enabled;
    elements.composerInput.placeholder = enabled
      ? COMPOSER_PLACEHOLDER
      : '终端未运行；先启动对话后再输入';
  };

  const focusComposer = (): boolean => {
    if (elements.composerInput.disabled) {
      return false;
    }
    elements.composerInput.focus({ preventScroll: true });
    return document.activeElement === elements.composerInput;
  };

  /*
   * Opening a project can resolve before its final `running` status has reached the renderer. Keep
   * the intent to focus, then fulfil it only after the matching active session is actually writable.
   */
  const flushPendingComposerFocus = (): void => {
    const status = dependencies.activeStatus();
    if (
      !state.pendingComposerFocusSessionId ||
      status?.id !== state.pendingComposerFocusSessionId ||
      status.phase !== 'running' ||
      elements.composerInput.disabled
    ) {
      return;
    }

    const expectedSessionId = state.pendingComposerFocusSessionId;
    window.requestAnimationFrame(() => {
      const latestStatus = dependencies.activeStatus();
      if (
        latestStatus?.id === expectedSessionId &&
        latestStatus.phase === 'running' &&
        focusComposer()
      ) {
        state.pendingComposerFocusSessionId = '';
      }
    });
  };

  const requestComposerFocus = (
    sessionId = dependencies.getWorkspaceState().activeSessionId,
  ): void => {
    if (!sessionId) {
      return;
    }
    state.pendingComposerFocusSessionId = sessionId;
    flushPendingComposerFocus();
  };

  /**
   * The iMessage-style send: a bubble holding what was typed lifts out of the composer and fades into
   * the transcript. It is a throwaway element positioned over the textarea, so it never affects
   * layout, and it is skipped entirely when the user has asked for reduced motion. Both the terminal
   * and chat composers call this, so the two surfaces confirm a send the same way.
   */
  const playSendAnimation = (
    text: string,
    source: HTMLTextAreaElement = elements.composerInput,
    variant: 'terminal' | 'chat' = 'terminal',
  ): void => {
    const trimmed = text.trim();
    if (!trimmed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const rect = source.getBoundingClientRect();
    const bubble = document.createElement('div');
    bubble.className =
      variant === 'chat'
        ? 'composer-send-bubble composer-send-bubble--chat'
        : 'composer-send-bubble';
    // A very long prompt would make an unreadable bubble; the first lines carry the meaning.
    bubble.textContent = trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed;
    bubble.style.left = `${rect.left}px`;
    bubble.style.top = `${rect.top}px`;
    bubble.style.width = `${rect.width}px`;
    bubble.style.maxHeight = `${rect.height}px`;
    document.body.append(bubble);

    bubble.addEventListener(
      'animationend',
      () => {
        bubble.remove();
      },
      { once: true },
    );
    // A dropped animationend (background tab, compositor hiccup) must not leak the node.
    window.setTimeout(() => {
      bubble.remove();
    }, 700);
  };

  return {
    focusComposer,
    flushPendingComposerFocus,
    playSendAnimation,
    requestComposerFocus,
    resizeComposer,
    setComposerEnabled,
  };
};
