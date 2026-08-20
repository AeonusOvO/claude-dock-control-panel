import type { ClaudeLaunchMode, WorkspaceState } from '../../../shared/contracts';
import type { ConversationSnapshot } from '../../../shared/conversation/native';
import { createNativeAttachmentBindings } from './native-attachment-bindings';
import { createNativeComposerBindings } from './native-composer-bindings';
import { createNativeLaunchActions } from './native-launch';
import { createNativePlanDialogBindings } from './native-plan-bindings';
import { createNativeRecoveryActions } from './native-recoveries';
import { createNativeSlashCommandActions } from './launch-slash-commands';
import { createNativeTerminalToggleActions } from './native-terminal-toggle';
import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationLaunchActionsDependencies } from './launch-dependencies';
import type { ConversationState } from './state';

export type { ConversationLaunchActionsDependencies } from './launch-dependencies';

export interface ConversationLaunchActions {
  dispose: () => void;
  handleNativeSlashCommand: (rawInput: string, snapshot: ConversationSnapshot) => Promise<boolean>;
  launchNativeClaude: (mode: ClaudeLaunchMode, exactConversationId?: string) => Promise<void>;
  reconcileNativeConversationBinding: (state: WorkspaceState) => void;
  refreshNativeRecoveries: () => Promise<void>;
}

export const createConversationLaunchActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationLaunchActionsDependencies,
  actions: ConversationActions,
): ConversationLaunchActions => {
  const recoveryActions = createNativeRecoveryActions(
    elements,
    state,
    dependencies,
    actions,
    (mode, exactConversationId) => launchActions.launchNativeClaude(mode, exactConversationId),
  );
  const launchActions = createNativeLaunchActions(
    elements,
    state,
    dependencies,
    actions,
    recoveryActions.renderNativeRecoveries,
  );
  const slashCommandActions = createNativeSlashCommandActions(
    elements,
    state,
    dependencies,
    actions,
    launchActions.launchNativeClaude,
    recoveryActions.refreshNativeRecoveries,
  );
  const composerBindings = createNativeComposerBindings(
    elements,
    state,
    dependencies,
    actions,
    slashCommandActions.handleNativeSlashCommand,
  );
  const planBindings = createNativePlanDialogBindings(elements, state, actions);
  const terminalToggleActions = createNativeTerminalToggleActions(
    elements,
    state,
    dependencies,
    actions,
    launchActions.launchNativeClaude,
    launchActions.activateNativeConversation,
    recoveryActions.refreshNativeRecoveries,
  );
  const attachmentBindings = createNativeAttachmentBindings(elements, state, dependencies, actions);

  const disposers: Array<() => void> = [];

  const unsubscribeNativeConversation = window.controlPanel.onNativeConversation((snapshot) => {
    actions.scheduleNativeConversationRender(snapshot);
  });
  disposers.push(unsubscribeNativeConversation);
  const unsubscribeConversationOwnerConflict = window.controlPanel.onConversationOwnerConflict(
    (conflict) => {
      dependencies.showToast(
        conflict.existingOwnerKind === 'native'
          ? '这个对话已在原生界面运行；已停止重复恢复，请切换回原生对话。'
          : '这个对话已在另一个安全终端运行；已停止重复恢复并保留原会话。',
        'error',
      );
      if (conflict.existingOwnerKind === 'native') {
        launchActions.activateNativeConversation(conflict.conversationId);
      } else if (conflict.existingSessionId) {
        void window.controlPanel.activateProject(conflict.existingSessionId).then((result) => {
          if (result.ok) dependencies.renderWorkspace(result.state);
        });
      }
    },
  );
  disposers.push(unsubscribeConversationOwnerConflict);
  disposers.push(composerBindings.bindNativeComposer());
  disposers.push(planBindings.bindNativePlanDialog());
  disposers.push(terminalToggleActions.bindNativeTerminalToggle());
  disposers.push(attachmentBindings.bindNativeAttachments());

  const { handleNativeSlashCommand } = slashCommandActions;
  const { launchNativeClaude, reconcileNativeConversationBinding } = launchActions;
  const { refreshNativeRecoveries } = recoveryActions;

  const dispose = (): void => {
    for (const disposeListener of disposers) disposeListener();
  };

  return {
    dispose,
    handleNativeSlashCommand,
    launchNativeClaude,
    reconcileNativeConversationBinding,
    refreshNativeRecoveries,
  };
};
