import {
  createComposerHistory,
  rememberSubmission,
  resetBrowsing,
  stepBack,
  stepForward,
  type ComposerHistoryState,
} from '../../../shared/conversation/composer-history';
import {
  buildTerminalSubmission,
  writeTerminalSubmission,
} from '../../../shared/conversation/composer-input';
import { ComposerSubmitCoordinator } from '../../platform/composer-submit';
import type { TerminalElements } from './elements';
import type { TerminalLayoutComposerActions } from './terminal-layout-composer';
import type { TerminalLayoutDependencies } from './terminal-layout-dependencies';
import type { TerminalIo } from './terminal-io';

export const bindTerminalComposerSubmitActions = (
  elements: TerminalElements,
  dependencies: TerminalLayoutDependencies,
  io: TerminalIo,
  composerActions: TerminalLayoutComposerActions,
): void => {
  const { playSendAnimation, resizeComposer } = composerActions;

  /*
   * The composer. Everything a chat box gives for free — Ctrl+A, Shift+arrow selection, drag-select,
   * Ctrl+Z, IME composition, mouse caret placement — is native `<textarea>` behaviour, so this code
   * only handles submitting, history and sizing. No key handler re-implements text editing.
   */
  const COMPOSER_HISTORY_KEY = 'claudedock.composerHistory';

  const loadComposerHistory = (): ComposerHistoryState => {
    try {
      localStorage.removeItem(COMPOSER_HISTORY_KEY);
    } catch {
      // Storage denial must not prevent an in-memory composer.
    }
    return createComposerHistory();
  };

  let composerHistory = loadComposerHistory();

  const persistComposerHistory = (): void => {
    // Intentionally memory-only. Raw prompts are never persisted outside safeStorage.
  };

  const composerSubmits = new ComposerSubmitCoordinator();

  const submitComposer = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    const view = status ? io.terminalViewForStatus(status) : undefined;
    if (!status || status.phase !== 'running' || !view) {
      dependencies.showToast('终端还没有运行，无法发送。', 'error');
      return;
    }
    const ptyGeneration = status.ptyGeneration;

    const text = elements.composerInput.value;
    let submission: ReturnType<typeof buildTerminalSubmission>;
    try {
      submission = buildTerminalSubmission(text);
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '内容过长，无法发送。',
        'error',
      );
      return;
    }

    try {
      await composerSubmits.submit({
        /*
         * Body and return go as two writes: Claude Code's TUI reads one big chunk as a paste and eats
         * a trailing return, leaving the prompt sitting unsent in its input box. See
         * `composer-input.ts`.
         */
        deliver: () =>
          writeTerminalSubmission(
            submission,
            (data) => {
              io.writeToTerminalGeneration(status.id, ptyGeneration, view, data);
            },
            // The session can be closed, stopped or replaced during the gap between the two writes.
            () => io.writableTerminalGeneration(status.id, ptyGeneration, view),
          ),
        onCancelled: () => {
          dependencies.showToast('终端已重启或关闭，这条内容没有发送，已为你保留。', 'error');
        },
        onDelivered: () => {
          playSendAnimation(text);
          composerHistory = rememberSubmission(composerHistory, text);
          persistComposerHistory();
          // Anything typed during the gap between the two writes is not part of this submission and
          // must survive; only the exact text that went out may be cleared.
          if (elements.composerInput.value === text) {
            elements.composerInput.value = '';
            resizeComposer();
          }
        },
      });
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '发送失败，请重试。',
        'error',
      );
    }
  };

  /** ↑/↓ only browse history when the caret is at the very start / end, so editing still works. */
  const walkComposerHistory = (direction: 'back' | 'forward'): boolean => {
    const { selectionEnd, selectionStart, value } = elements.composerInput;
    if (selectionStart !== selectionEnd) {
      return false;
    }
    if (direction === 'back' && selectionStart !== 0) {
      return false;
    }
    if (direction === 'forward' && selectionEnd !== value.length) {
      return false;
    }

    const step =
      direction === 'back' ? stepBack(composerHistory, value) : stepForward(composerHistory);
    composerHistory = step.state;
    if (step.text === undefined) {
      return false;
    }
    elements.composerInput.value = step.text;
    elements.composerInput.setSelectionRange(step.text.length, step.text.length);
    resizeComposer();
    return true;
  };

  elements.composerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitComposer();
  });

  elements.composerInput.addEventListener('keydown', (event) => {
    // Never intercept while an IME candidate window is open, or Chinese input breaks apart.
    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      void submitComposer();
      return;
    }
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      !event.altKey
    ) {
      if (walkComposerHistory(event.key === 'ArrowUp' ? 'back' : 'forward')) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'Escape' && elements.composerInput.value.length > 0) {
      event.preventDefault();
      elements.composerInput.value = '';
      composerHistory = resetBrowsing(composerHistory);
      resizeComposer();
      return;
    }
    // Shift+Tab would otherwise move focus out of the composer. Forwarding the same CBT sequence
    // xterm sends makes the shortcut work no matter which of the two inputs has focus; the status bar
    // catches up when the main process reads the repainted badge.
    if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey) {
      const status = dependencies.activeStatus();
      const view = status ? io.terminalViewForStatus(status) : undefined;
      if (
        status?.phase === 'running' &&
        view &&
        io.writeToTerminalGeneration(status.id, status.ptyGeneration, view, '\x1b[Z')
      ) {
        event.preventDefault();
      }
    }
  });

  elements.composerInput.addEventListener('input', () => {
    composerHistory = resetBrowsing(composerHistory);
    resizeComposer();
  });
};
