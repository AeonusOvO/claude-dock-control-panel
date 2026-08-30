import { requiredElement } from '../platform/dom';

export interface ConfirmationRequest {
  confirmLabel?: string;
  message: string;
  showSuppressOption?: boolean;
  suppressLabel?: string;
  title: string;
  tone?: 'danger' | 'default';
}

export interface ConfirmationResult {
  confirmed: boolean;
  suppressDialog: boolean;
}

export interface ConfirmationDialogActions {
  cancelPending: () => void;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  requestConfirmationResult: (request: ConfirmationRequest) => Promise<ConfirmationResult>;
}

export const createConfirmationDialogActions = (): ConfirmationDialogActions => {
  const confirmationDialog = requiredElement<HTMLDialogElement>('#confirmation-dialog');
  const confirmationDialogTitle = requiredElement<HTMLElement>('#confirmation-dialog-title');
  const confirmationDialogMessage = requiredElement<HTMLElement>('#confirmation-dialog-message');
  const confirmationDialogConfirm = requiredElement<HTMLButtonElement>(
    '#confirmation-dialog-confirm',
  );
  const confirmationDialogSuppress = requiredElement<HTMLInputElement>(
    '#confirmation-dialog-suppress',
  );
  const confirmationDialogSuppressLabel = requiredElement<HTMLElement>(
    '#confirmation-dialog-suppress-label',
  );

  /**
   * Uses an in-page modal instead of `window.confirm`. Electron on Windows can lose the renderer's
   * DOM focus after a native JavaScript dialog closes, leaving both the composer and xterm's hidden
   * IME textarea unable to regain focus. A DOM `<dialog>` keeps focus ownership inside the page.
   */
  const requestConfirmationResult = ({
    confirmLabel = '确认',
    message,
    showSuppressOption = false,
    suppressLabel = '以后不再提示',
    title,
    tone = 'default',
  }: ConfirmationRequest): Promise<ConfirmationResult> => {
    if (confirmationDialog.open) {
      return Promise.resolve({ confirmed: false, suppressDialog: false });
    }

    confirmationDialogTitle.textContent = title;
    confirmationDialogMessage.textContent = message;
    confirmationDialogConfirm.textContent = confirmLabel;
    confirmationDialog.dataset.tone = tone;
    const suppressionText = confirmationDialogSuppressLabel.querySelector('span');
    if (suppressionText) {
      suppressionText.textContent = suppressLabel;
    }
    confirmationDialogSuppress.checked = false;
    confirmationDialogSuppress.hidden = !showSuppressOption;
    confirmationDialogSuppressLabel.hidden = !showSuppressOption;
    confirmationDialog.returnValue = 'cancel';
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

    return new Promise((resolve) => {
      const finish = (): void => {
        const confirmed = confirmationDialog.returnValue === 'confirm';
        resolve({
          confirmed,
          suppressDialog: confirmed && showSuppressOption && confirmationDialogSuppress.checked,
        });
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
        resolve({ confirmed: false, suppressDialog: false });
      }
    });
  };

  return {
    cancelPending: () => {
      if (confirmationDialog.open) confirmationDialog.close('cancel');
    },
    requestConfirmation: (request) =>
      requestConfirmationResult(request).then(({ confirmed }) => confirmed),
    requestConfirmationResult,
  };
};
