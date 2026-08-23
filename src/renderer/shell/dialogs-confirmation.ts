import { requiredElement } from '../platform/dom';

export interface ConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface ConfirmationDialogActions {
  cancelPending: () => void;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
}

export const createConfirmationDialogActions = (): ConfirmationDialogActions => {
  const confirmationDialog = requiredElement<HTMLDialogElement>('#confirmation-dialog');
  const confirmationDialogTitle = requiredElement<HTMLElement>('#confirmation-dialog-title');
  const confirmationDialogMessage = requiredElement<HTMLElement>('#confirmation-dialog-message');
  const confirmationDialogConfirm = requiredElement<HTMLButtonElement>(
    '#confirmation-dialog-confirm',
  );

  /**
   * Uses an in-page modal instead of `window.confirm`. Electron on Windows can lose the renderer's
   * DOM focus after a native JavaScript dialog closes, leaving both the composer and xterm's hidden
   * IME textarea unable to regain focus. A DOM `<dialog>` keeps focus ownership inside the page.
   */
  const requestConfirmation = ({
    confirmLabel = '确认',
    message,
    title,
    tone = 'default',
  }: ConfirmationRequest): Promise<boolean> => {
    if (confirmationDialog.open) {
      return Promise.resolve(false);
    }

    confirmationDialogTitle.textContent = title;
    confirmationDialogMessage.textContent = message;
    confirmationDialogConfirm.textContent = confirmLabel;
    confirmationDialog.dataset.tone = tone;
    confirmationDialog.returnValue = 'cancel';
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

    return new Promise((resolve) => {
      const finish = (): void => {
        const confirmed = confirmationDialog.returnValue === 'confirm';
        resolve(confirmed);
        window.requestAnimationFrame(() => {
          const previouslyFocusedControl =
            previouslyFocused instanceof HTMLButtonElement ||
            previouslyFocused instanceof HTMLInputElement ||
            previouslyFocused instanceof HTMLSelectElement ||
            previouslyFocused instanceof HTMLTextAreaElement
              ? previouslyFocused
              : undefined;
          if (
            document.activeElement === document.body &&
            previouslyFocused?.isConnected &&
            !previouslyFocusedControl?.disabled
          ) {
            previouslyFocused.focus({ preventScroll: true });
          }
        });
      };
      confirmationDialog.addEventListener('close', finish, { once: true });
      try {
        confirmationDialog.showModal();
      } catch {
        confirmationDialog.removeEventListener('close', finish);
        resolve(false);
      }
    });
  };

  return {
    cancelPending: () => {
      if (confirmationDialog.open) confirmationDialog.close('cancel');
    },
    requestConfirmation,
  };
};
