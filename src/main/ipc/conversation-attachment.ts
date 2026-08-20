import { CHANNELS } from '../../shared/ipc/channels';
import { clipboard, ipcMain, nativeImage } from 'electron';
import type { NativeAttachmentBytesInput } from '../../shared/conversation/native';
import type { NativeAttachmentStore } from '../conversation/attachment-store';
import { createFailureReporter } from '../infra/logger';
import { validateConversationId } from './validation';
import type { MainGuards } from './guards';

export interface ConversationAttachmentIpcDependencies {
  guards: Pick<MainGuards, 'validateSender'>;
  nativeAttachmentStore: NativeAttachmentStore;
}

const reportAttachmentFailure = createFailureReporter('attachment');

export const registerConversationAttachmentIpc = ({
  guards: { validateSender },
  nativeAttachmentStore,
}: ConversationAttachmentIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.NATIVE_ATTACHMENT_IMPORT_PATHS,
    async (event, conversationId: unknown, paths: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.length > 10 ||
        paths.some((item) => typeof item !== 'string' || item.length > 32_768)
      ) {
        throw new Error('图片选择结果无效。');
      }
      try {
        return {
          attachments: await nativeAttachmentStore.importFiles(validatedConversationId, paths),
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法安全导入图片。';
        return {
          ...reportAttachmentFailure('environment', message, error),
          attachments: [],
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.NATIVE_ATTACHMENT_IMPORT_BYTES,
    async (event, conversationId: unknown, sources: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      if (
        !Array.isArray(sources) ||
        sources.length === 0 ||
        sources.length > 10 ||
        sources.some(
          (source) =>
            !source ||
            typeof source !== 'object' ||
            typeof source.fileName !== 'string' ||
            !(source.bytes instanceof ArrayBuffer),
        )
      ) {
        throw new Error('粘贴图片数据无效。');
      }
      try {
        return {
          attachments: await nativeAttachmentStore.importBytes(
            validatedConversationId,
            sources as NativeAttachmentBytesInput[],
          ),
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法安全导入图片。';
        return {
          ...reportAttachmentFailure('environment', message, error),
          attachments: [],
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.NATIVE_ATTACHMENT_IMPORT_CLIPBOARD,
    async (event, conversationId: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return {
          ...reportAttachmentFailure(
            'user-input',
            '剪贴板中没有可读取的图片。',
            'clipboard-image-empty',
          ),
          attachments: [],
          ok: false,
        };
      }
      try {
        const bytes = image.toPNG();
        return {
          attachments: await nativeAttachmentStore.importBytes(validatedConversationId, [
            {
              bytes: Uint8Array.from(bytes).buffer,
              fileName: '剪贴板图片.png',
            },
          ]),
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法安全导入剪贴板图片。';
        return {
          ...reportAttachmentFailure('environment', message, error),
          attachments: [],
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.NATIVE_ATTACHMENT_READ,
    (event, conversationId: unknown, attachmentId: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      const validatedAttachmentId = validateConversationId(attachmentId);
      const attachment = nativeAttachmentStore.get(validatedConversationId, validatedAttachmentId);
      const resolved = nativeAttachmentStore.resolve(
        validatedConversationId,
        validatedAttachmentId,
      );
      const image = resolved.path
        ? nativeImage.createFromPath(resolved.path)
        : nativeImage.createEmpty();
      return image.isEmpty()
        ? attachment
        : {
            ...attachment,
            previewDataUrl: image.resize({ height: 160, quality: 'good', width: 240 }).toDataURL(),
          };
    },
  );
  ipcMain.handle(
    CHANNELS.NATIVE_ATTACHMENT_REMOVE,
    (event, conversationId: unknown, attachmentId: unknown) => {
      validateSender(event);
      return nativeAttachmentStore.remove(
        validateConversationId(conversationId),
        validateConversationId(attachmentId),
      );
    },
  );
};
