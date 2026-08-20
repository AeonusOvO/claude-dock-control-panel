import type {
  ConversationControlUpdate,
  ConversationInteraction,
  ConversationInteractionResponse,
  ConversationSnapshot,
  NativeAttachmentImportResult,
  NativeAttachmentView,
} from '../../../shared/conversation/native';
import { createNativeAttachmentActions } from './native-attachments';
import { createNativeComposerActions } from './native-composer';
import { createNativeControlActions } from './native-controls';
import { createNativeDispatchActions } from './native-dispatch';
import { createNativeInteractionActions } from './native-interactions';
import { createNativeQueueActions } from './native-queue';
import { createNativeRenderActions } from './native-render';
import type { ConversationActionsDependencies } from './dependencies';
import type { ConversationElements } from './elements';
import type { ConversationState } from './state';
import type { ConversationView } from './view';

export type { ConversationActionsDependencies } from './dependencies';

export interface ConversationActions {
  applyNativeComposerAction: () => void;
  applyNativeAttachmentResult: (result: NativeAttachmentImportResult) => void;
  closeNativePlanDialog: () => void;
  deliverNativeMessage: (
    conversationId: string,
    text: string,
    attachments: NativeAttachmentView[],
  ) => Promise<boolean>;
  drainNativeQueuedMessageToComposer: (conversationId: string) => void;
  enqueueNativeMessage: (
    conversationId: string,
    text: string,
    attachments: NativeAttachmentView[],
    options: { autoFlush: boolean },
  ) => void;
  finishNativeSendAnimation: () => void;
  flushNativeQueuedMessage: (conversationId: string) => Promise<void>;
  importNativeAttachments: (files: File[]) => Promise<void>;
  interruptNativeTurn: (options?: { keepQueued?: boolean }) => void;
  nativeClipboardFileName: (file: File, index: number) => string;
  openNativeEffortMenu: () => void;
  openNativeModeMenu: () => void;
  openNativeModelMenu: () => void;
  openNativeSpeedMenu: () => void;
  playNativeSendAnimation: () => void;
  renderNativeConversation: (snapshot: ConversationSnapshot) => void;
  renderNativeQueuedMessage: () => void;
  renderPendingNativeAttachments: () => void;
  resizeNativeComposer: () => void;
  respondToNativeInteraction: (
    interaction: ConversationInteraction,
    response: ConversationInteractionResponse,
  ) => Promise<void>;
  scheduleNativeConversationRender: (snapshot: ConversationSnapshot) => void;
  setNativeConversationVisible: (visible: boolean) => void;
  updateNativeControls: (
    update: Omit<ConversationControlUpdate, 'expectedCapabilityRevision'>,
  ) => Promise<void>;
}

export const createConversationActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationActionsDependencies,
  view: ConversationView,
): ConversationActions => {
  const interactionActions = createNativeInteractionActions(elements, state, dependencies);
  const composerActions = createNativeComposerActions(elements, state);
  const attachmentActions = createNativeAttachmentActions(
    elements,
    state,
    dependencies,
    (snapshot) => renderActions.renderNativeConversation(snapshot),
  );
  const queueActions = createNativeQueueActions(
    elements,
    state,
    composerActions.applyNativeComposerAction,
    attachmentActions.resizeNativeComposer,
    attachmentActions.renderPendingNativeAttachments,
  );
  const dispatchActions = createNativeDispatchActions(
    elements,
    state,
    dependencies,
    (snapshot) => renderActions.renderNativeConversation(snapshot),
    composerActions.applyNativeComposerAction,
    queueActions.enqueueNativeMessage,
    queueActions.renderNativeQueuedMessage,
  );
  const renderActions = createNativeRenderActions(
    elements,
    state,
    dependencies,
    view,
    interactionActions.renderNativeInteraction,
    composerActions.applyNativeComposerAction,
    queueActions.renderNativeQueuedMessage,
    dispatchActions.flushNativeQueuedMessage,
  );
  const controlActions = createNativeControlActions(
    state,
    dependencies,
    view,
    renderActions.renderNativeConversation,
  );

  const { setNativeConversationVisible, respondToNativeInteraction, closeNativePlanDialog } =
    interactionActions;
  const { applyNativeComposerAction, finishNativeSendAnimation, playNativeSendAnimation } =
    composerActions;
  const { renderNativeQueuedMessage, enqueueNativeMessage, drainNativeQueuedMessageToComposer } =
    queueActions;
  const { deliverNativeMessage, flushNativeQueuedMessage, interruptNativeTurn } = dispatchActions;
  const { renderNativeConversation, scheduleNativeConversationRender } = renderActions;
  const {
    resizeNativeComposer,
    renderPendingNativeAttachments,
    applyNativeAttachmentResult,
    nativeClipboardFileName,
    importNativeAttachments,
  } = attachmentActions;
  const {
    updateNativeControls,
    openNativeModelMenu,
    openNativeSpeedMenu,
    openNativeModeMenu,
    openNativeEffortMenu,
  } = controlActions;

  return {
    applyNativeComposerAction,
    applyNativeAttachmentResult,
    closeNativePlanDialog,
    deliverNativeMessage,
    drainNativeQueuedMessageToComposer,
    enqueueNativeMessage,
    finishNativeSendAnimation,
    flushNativeQueuedMessage,
    importNativeAttachments,
    interruptNativeTurn,
    nativeClipboardFileName,
    openNativeEffortMenu,
    openNativeModeMenu,
    openNativeModelMenu,
    openNativeSpeedMenu,
    playNativeSendAnimation,
    renderNativeConversation,
    renderNativeQueuedMessage,
    renderPendingNativeAttachments,
    resizeNativeComposer,
    respondToNativeInteraction,
    scheduleNativeConversationRender,
    setNativeConversationVisible,
    updateNativeControls,
  };
};
