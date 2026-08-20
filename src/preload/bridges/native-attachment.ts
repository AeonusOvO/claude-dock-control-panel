import { ipcRenderer } from 'electron';
import type { ControlPanelApi } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const nativeAttachmentBridge = {
  importNativeAttachmentPaths: (conversationId, paths) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_ATTACHMENT_IMPORT_PATHS, conversationId, paths),
  importNativeAttachmentBytes: (conversationId, sources) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_ATTACHMENT_IMPORT_BYTES, conversationId, sources),
  importNativeClipboardImage: (conversationId) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_ATTACHMENT_IMPORT_CLIPBOARD, conversationId),
  readNativeAttachment: (conversationId, attachmentId) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_ATTACHMENT_READ, conversationId, attachmentId),
  removeNativeAttachment: (conversationId, attachmentId) =>
    ipcRenderer.invoke(CHANNELS.NATIVE_ATTACHMENT_REMOVE, conversationId, attachmentId),
} satisfies Partial<ControlPanelApi>;
