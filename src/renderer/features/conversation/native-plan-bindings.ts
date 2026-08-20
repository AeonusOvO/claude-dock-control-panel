import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationState } from './state';

export interface NativePlanDialogBindings {
  bindNativePlanDialog: () => () => void;
}

export const createNativePlanDialogBindings = (
  elements: ConversationElements,
  state: ConversationState,
  actions: ConversationActions,
): NativePlanDialogBindings => {
  const bindNativePlanDialog = (): (() => void) => {
    const disposers: Array<() => void> = [];

    elements.nativePlanClose.addEventListener('click', actions.closeNativePlanDialog);
    disposers.push(() =>
      elements.nativePlanClose.removeEventListener('click', actions.closeNativePlanDialog),
    );
    const handleNativePlanDialogCancel = (event: Event): void => {
      event.preventDefault();
      actions.closeNativePlanDialog();
    };
    elements.nativePlanDialog.addEventListener('cancel', handleNativePlanDialogCancel);
    disposers.push(() =>
      elements.nativePlanDialog.removeEventListener('cancel', handleNativePlanDialogCancel),
    );
    const handleNativePlanDialogClick = (event: MouseEvent): void => {
      if (event.target === elements.nativePlanDialog) actions.closeNativePlanDialog();
    };
    elements.nativePlanDialog.addEventListener('click', handleNativePlanDialogClick);
    disposers.push(() =>
      elements.nativePlanDialog.removeEventListener('click', handleNativePlanDialogClick),
    );
    const handleNativePlanContinueClick = (): void => {
      if (!state.expandedNativePlan) return;
      void actions.respondToNativeInteraction(state.expandedNativePlan, {
        action: 'deny',
        message: '继续完善计划',
      });
    };
    elements.nativePlanContinue.addEventListener('click', handleNativePlanContinueClick);
    disposers.push(() =>
      elements.nativePlanContinue.removeEventListener('click', handleNativePlanContinueClick),
    );
    const handleNativePlanApproveClick = (): void => {
      if (!state.expandedNativePlan) return;
      void actions.respondToNativeInteraction(state.expandedNativePlan, { action: 'allow' });
    };
    elements.nativePlanApprove.addEventListener('click', handleNativePlanApproveClick);
    disposers.push(() =>
      elements.nativePlanApprove.removeEventListener('click', handleNativePlanApproveClick),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  };

  return {
    bindNativePlanDialog,
  };
};
