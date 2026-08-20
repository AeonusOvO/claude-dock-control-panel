import { ipcRenderer } from 'electron';
import type { ControlPanelApi, ChatStreamEvent } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const chatBridge = {
  getChatConfig: () => ipcRenderer.invoke(CHANNELS.CHAT_GET_CONFIG),
  saveChatConfig: (input) => ipcRenderer.invoke(CHANNELS.CHAT_SAVE_CONFIG, input),
  testChatConnection: (input) => ipcRenderer.invoke(CHANNELS.CHAT_TEST_CONNECTION, input),
  importChatAttachments: (input) => ipcRenderer.invoke(CHANNELS.CHAT_IMPORT_ATTACHMENTS, input),
  importChatAttachmentBytes: (input) =>
    ipcRenderer.invoke(CHANNELS.CHAT_IMPORT_ATTACHMENT_BYTES, input),
  importChatClipboardImage: (draftId) =>
    ipcRenderer.invoke(CHANNELS.CHAT_IMPORT_CLIPBOARD_IMAGE, draftId),
  readChatAttachment: (attachmentId) =>
    ipcRenderer.invoke(CHANNELS.CHAT_READ_ATTACHMENT, attachmentId),
  deleteChatDraftAttachment: (draftId, attachmentId) =>
    ipcRenderer.invoke(CHANNELS.CHAT_DELETE_DRAFT_ATTACHMENT, draftId, attachmentId),
  releaseChatAttachmentDraft: (draftId) =>
    ipcRenderer.invoke(CHANNELS.CHAT_RELEASE_ATTACHMENT_DRAFT, draftId),
  getChatConversations: () => ipcRenderer.invoke(CHANNELS.CHAT_LIST_CONVERSATIONS),
  getChatConversation: (conversationId) =>
    ipcRenderer.invoke(CHANNELS.CHAT_GET_CONVERSATION, conversationId),
  saveChatConversation: (input) => ipcRenderer.invoke(CHANNELS.CHAT_SAVE_CONVERSATION, input),
  renameChatConversation: (conversationId, title) =>
    ipcRenderer.invoke(CHANNELS.CHAT_RENAME_CONVERSATION, conversationId, title),
  deleteChatConversation: (conversationId) =>
    ipcRenderer.invoke(CHANNELS.CHAT_DELETE_CONVERSATION, conversationId),
  preflightChat: (input) => ipcRenderer.invoke(CHANNELS.CHAT_PREFLIGHT, input),
  startChat: (input) => ipcRenderer.invoke(CHANNELS.CHAT_START, input),
  stopChat: (requestId) => ipcRenderer.invoke(CHANNELS.CHAT_STOP, requestId) as Promise<void>,
  onChatStream: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, streamEvent: ChatStreamEvent): void => {
      listener(streamEvent);
    };
    ipcRenderer.on(CHANNELS.CHAT_STREAM, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.CHAT_STREAM, callback);
    };
  },
} satisfies Partial<ControlPanelApi>;
