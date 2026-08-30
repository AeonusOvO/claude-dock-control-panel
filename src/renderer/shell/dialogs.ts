import { createClaudePermissionDialogActions } from './dialogs-claude-permission';
import { createConfirmationDialogActions } from './dialogs-confirmation';
import { createQuitConfirmationDialogActions } from './dialogs-quit';

export type { ConfirmationRequest, ConfirmationResult } from './dialogs-confirmation';
import type { ConfirmationRequest, ConfirmationResult } from './dialogs-confirmation';

export interface DialogShell {
  dispose: () => void;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  requestConfirmationResult: (request: ConfirmationRequest) => Promise<ConfirmationResult>;
}

export const createDialogShell = (): DialogShell => {
  const confirmationActions = createConfirmationDialogActions();
  const quitActions = createQuitConfirmationDialogActions(confirmationActions);
  const claudePermissionActions = createClaudePermissionDialogActions();

  return {
    dispose: () => {
      quitActions.dispose();
      claudePermissionActions.dispose();
    },
    requestConfirmation: confirmationActions.requestConfirmation,
    requestConfirmationResult: confirmationActions.requestConfirmationResult,
  };
};
