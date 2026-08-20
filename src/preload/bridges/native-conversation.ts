import { ipcRenderer } from 'electron';
import type { ControlPanelApi } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const nativeConversationBridge = {
  startNativeConversation: (input) => ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_START, input),
  getNativeConversation: (conversationId) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_GET, conversationId),
  submitNativeConversation: (conversationId, input) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_SUBMIT, conversationId, input),
  respondNativeConversation: (conversationId, interactionId, response) =>
    ipcRenderer.invoke(
      CHANNELS.NATIVE_CONVERSATION_RESPOND,
      conversationId,
      interactionId,
      response,
    ),
  interruptNativeConversation: (conversationId) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_INTERRUPT, conversationId),
  stopNativeConversationTask: (conversationId, taskId) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_STOP_TASK, conversationId, taskId),
  updateNativeConversationControls: (conversationId, update) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_UPDATE_CONTROLS, conversationId, update),
  closeNativeConversation: (conversationId) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_CLOSE, conversationId),
  renameNativeConversation: (conversationId, title) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_RENAME, conversationId, title),
  transferNativeConversationToTerminal: (conversationId, draft, allowInterrupt) =>
    ipcRenderer.invoke(
      CHANNELS.NATIVE_CONVERSATION_TRANSFER_TO_TERMINAL,
      conversationId,
      draft,
      allowInterrupt ?? false,
    ),
  adoptTerminalConversation: (sessionId, allowInterrupt) =>
    ipcRenderer.invoke(
      CHANNELS.NATIVE_CONVERSATION_ADOPT_TERMINAL,
      sessionId,
      allowInterrupt ?? false,
    ),
  listNativeRecoveries: () => ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_LIST_RECOVERIES),
  restoreNativeDraft: (conversationId, clientSubmissionId, projectPath) =>
    ipcRenderer.invoke(
      CHANNELS.NATIVE_CONVERSATION_RESTORE_DRAFT,
      conversationId,
      clientSubmissionId,
      projectPath,
    ),
  discardNativeRecovery: (conversationId, projectPath) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_CONVERSATION_DISCARD_RECOVERY, conversationId, projectPath),
  onNativeConversation: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof listener>[0],
    ): void => listener(snapshot);
    ipcRenderer.on(CHANNELS.NATIVE_CONVERSATION_SNAPSHOT, callback);
    return () => ipcRenderer.removeListener(CHANNELS.NATIVE_CONVERSATION_SNAPSHOT, callback);
  },
  onConversationOwnerConflict: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      conflict: Parameters<typeof listener>[0],
    ): void => listener(conflict);
    ipcRenderer.on(CHANNELS.CONVERSATION_OWNER_CONFLICT, callback);
    return () => ipcRenderer.removeListener(CHANNELS.CONVERSATION_OWNER_CONFLICT, callback);
  },
} satisfies Partial<ControlPanelApi>;
