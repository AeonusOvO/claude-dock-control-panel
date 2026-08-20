import { CHANNELS } from '../../shared/ipc/channels';
import { clipboard, ipcMain, nativeImage } from 'electron';
import type {
  ChatAttachmentBytesImportInput,
  ChatAttachmentImportInput,
  ChatMessage,
  ChatStartInput,
  NetworkProviderId,
  SaveChatConfigInput,
  SaveChatConversationInput,
} from '../../shared/contracts';
import { ChatAttachmentStore, isChatAttachmentId } from '../chat/attachment-store';
import type { ChatConfigStore } from '../chat/config-store';
import type { ChatHistoryStore } from '../chat/history-store';
import type { ChatService } from '../chat/service';
import { createFailureReporter } from '../infra/logger';
import type { MainGuards } from './guards';

export interface ChatIpcDependencies {
  chatAttachmentStore: ChatAttachmentStore;
  chatConfigStore: ChatConfigStore;
  chatHistoryStore: ChatHistoryStore;
  chatService: ChatService;
  guards: Pick<MainGuards, 'assertOfficialProviderAllowed' | 'validateSender'>;
}

const reportAttachmentFailure = createFailureReporter('chat-attachment');

type ValidateSender = MainGuards['validateSender'];
type AssertOfficialProviderAllowed = MainGuards['assertOfficialProviderAllowed'];

const currentTurnLocalAttachmentIds = (messages: ChatMessage[]): Set<string> => {
  const message = messages.at(-1);
  if (!message || !Array.isArray(message.content)) {
    return new Set();
  }
  return new Set(
    message.content.flatMap((block) =>
      block.type !== 'text' && block.source.type === 'local' ? [block.source.attachmentId] : [],
    ),
  );
};

const officialProviderForChat = (
  chatConfigStore: ChatConfigStore,
): NetworkProviderId | undefined => {
  try {
    const hostname = new URL(chatConfigStore.getView().baseUrl).hostname.toLowerCase();
    if (hostname === 'api.anthropic.com') {
      return 'anthropic-claude';
    }
    if (hostname === 'api.openai.com' || hostname === 'chatgpt.com') {
      return hostname === 'api.openai.com' ? 'openai-api' : 'openai-codex';
    }
  } catch {
    // The chat config store already validates URLs; a malformed legacy value is treated as custom.
  }
  return undefined;
};

const registerChatConfigIpc = (
  chatConfigStore: ChatConfigStore,
  chatService: ChatService,
  validateSender: ValidateSender,
): void => {
  ipcMain.handle(CHANNELS.CHAT_GET_CONFIG, (event) => {
    validateSender(event);
    return chatConfigStore.getView();
  });
  ipcMain.handle(CHANNELS.CHAT_SAVE_CONFIG, (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话接入配置格式无效。');
    }
    return chatConfigStore.save(input as SaveChatConfigInput);
  });
  ipcMain.handle(CHANNELS.CHAT_TEST_CONNECTION, async (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话接入测试参数无效。');
    }
    return chatService.test(input as SaveChatConfigInput);
  });
};

const registerChatAttachmentIpc = (
  chatAttachmentStore: ChatAttachmentStore,
  chatHistoryStore: ChatHistoryStore,
  validateSender: ValidateSender,
): void => {
  ipcMain.handle(CHANNELS.CHAT_IMPORT_ATTACHMENTS, async (event, input: unknown) => {
    validateSender(event);
    const record =
      input && typeof input === 'object'
        ? (input as Partial<ChatAttachmentImportInput>)
        : undefined;
    const paths = record?.paths;
    if (
      !Array.isArray(paths) ||
      paths.some((filePath) => typeof filePath !== 'string') ||
      paths.length === 0 ||
      (record?.draftId !== undefined && typeof record.draftId !== 'string')
    ) {
      throw new Error('附件路径列表无效。');
    }
    try {
      const imported = await chatAttachmentStore.importDraftFiles(paths, record?.draftId);
      return {
        attachments: imported.attachments,
        draftId: imported.draftId,
        errors: [],
        ok: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法导入附件。';
      return {
        ...reportAttachmentFailure('environment', message, error),
        attachments: [],
        errors: paths.map((filePath) => ({ message, path: String(filePath) })),
        ok: false,
      };
    }
  });
  ipcMain.handle(CHANNELS.CHAT_IMPORT_ATTACHMENT_BYTES, async (event, input: unknown) => {
    validateSender(event);
    const record =
      input && typeof input === 'object'
        ? (input as Partial<ChatAttachmentBytesImportInput>)
        : undefined;
    const sources = record?.sources;
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some(
        (source) =>
          !source ||
          typeof source !== 'object' ||
          typeof source.fileName !== 'string' ||
          !(source.bytes instanceof ArrayBuffer || ArrayBuffer.isView(source.bytes)),
      ) ||
      (record?.draftId !== undefined && typeof record.draftId !== 'string')
    ) {
      throw new Error('粘贴的附件数据无效。');
    }
    try {
      const imported = await chatAttachmentStore.importDraftBytes(sources, record?.draftId);
      return {
        attachments: imported.attachments,
        draftId: imported.draftId,
        errors: [],
        ok: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法导入附件。';
      return {
        ...reportAttachmentFailure('environment', message, error),
        attachments: [],
        errors: sources.map((source) => ({ message, path: String(source?.fileName ?? '') })),
        ok: false,
      };
    }
  });
  ipcMain.handle(CHANNELS.CHAT_IMPORT_CLIPBOARD_IMAGE, async (event, draftId: unknown) => {
    validateSender(event);
    if (draftId !== undefined && typeof draftId !== 'string') {
      throw new Error('附件草稿标识无效。');
    }
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return {
        ...reportAttachmentFailure(
          'user-input',
          '剪贴板中没有可导入的图片。',
          'clipboard-image-empty',
        ),
        attachments: [],
        errors: [],
        ok: false,
      };
    }
    try {
      const bytes = image.toPNG();
      const imported = await chatAttachmentStore.importDraftBytes(
        [
          {
            bytes,
            fileName: '剪贴板图片.png',
          },
        ],
        draftId,
      );
      return {
        attachments: imported.attachments,
        draftId: imported.draftId,
        errors: [],
        ok: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法安全导入剪贴板图片。';
      return {
        ...reportAttachmentFailure('environment', message, error),
        attachments: [],
        errors: [{ message, path: '剪贴板图片' }],
        ok: false,
      };
    }
  });
  ipcMain.handle(
    CHANNELS.CHAT_DELETE_DRAFT_ATTACHMENT,
    async (event, draftId: unknown, attachmentId: unknown) => {
      validateSender(event);
      if (typeof draftId !== 'string' || typeof attachmentId !== 'string') {
        throw new Error('附件草稿或附件标识无效。');
      }
      return chatAttachmentStore.removeDraftAttachment(
        draftId,
        attachmentId,
        chatHistoryStore.referencedAttachmentIds(),
      );
    },
  );
  ipcMain.handle(CHANNELS.CHAT_RELEASE_ATTACHMENT_DRAFT, async (event, draftId: unknown) => {
    validateSender(event);
    if (typeof draftId !== 'string') {
      throw new Error('附件草稿标识无效。');
    }
    return chatAttachmentStore.releaseDraft(draftId, chatHistoryStore.referencedAttachmentIds());
  });
  ipcMain.handle(CHANNELS.CHAT_READ_ATTACHMENT, (event, attachmentId: unknown) => {
    validateSender(event);
    if (!isChatAttachmentId(attachmentId)) {
      throw new Error('附件标识无效。');
    }
    const attachment = chatAttachmentStore.get(attachmentId);
    if (attachment.type !== 'image') {
      return attachment;
    }
    const resolved = chatAttachmentStore.resolve(attachmentId);
    const image = nativeImage.createFromPath(resolved.filePath);
    if (image.isEmpty()) {
      return attachment;
    }
    const resized = image.resize({ height: 160, quality: 'good', width: 240 });
    return {
      ...attachment,
      previewDataUrl: resized.toDataURL(),
    };
  });
};

const registerChatHistoryIpc = (
  chatHistoryStore: ChatHistoryStore,
  validateSender: ValidateSender,
): void => {
  ipcMain.handle(CHANNELS.CHAT_LIST_CONVERSATIONS, (event) => {
    validateSender(event);
    return chatHistoryStore.list();
  });
  ipcMain.handle(CHANNELS.CHAT_GET_CONVERSATION, (event, conversationId: unknown) => {
    validateSender(event);
    if (typeof conversationId !== 'string') {
      throw new Error('对话历史标识无效。');
    }
    return chatHistoryStore.get(conversationId);
  });
  ipcMain.handle(CHANNELS.CHAT_SAVE_CONVERSATION, (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话历史保存参数无效。');
    }
    return chatHistoryStore.save(input as SaveChatConversationInput);
  });
  ipcMain.handle(
    CHANNELS.CHAT_RENAME_CONVERSATION,
    (event, conversationId: unknown, title: unknown) => {
      validateSender(event);
      if (typeof conversationId !== 'string') {
        throw new Error('对话历史标识无效。');
      }
      return chatHistoryStore.rename(conversationId, title);
    },
  );
  ipcMain.handle(CHANNELS.CHAT_DELETE_CONVERSATION, (event, conversationId: unknown) => {
    validateSender(event);
    if (typeof conversationId !== 'string') {
      throw new Error('对话历史标识无效。');
    }
    return chatHistoryStore.delete(conversationId);
  });
};

const registerChatRequestIpc = (
  chatAttachmentStore: ChatAttachmentStore,
  chatConfigStore: ChatConfigStore,
  chatService: ChatService,
  assertOfficialProviderAllowed: AssertOfficialProviderAllowed,
  validateSender: ValidateSender,
): void => {
  ipcMain.handle(CHANNELS.CHAT_PREFLIGHT, (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话请求格式无效。');
    }
    const request = input as ChatStartInput;
    const prepared = chatService.preflight(request);
    chatAttachmentStore.assertDraftMatches(
      request.draftId,
      currentTurnLocalAttachmentIds(prepared.messages),
    );
    return prepared;
  });
  ipcMain.handle(CHANNELS.CHAT_START, async (event, input: unknown) => {
    validateSender(event);
    if (!input || typeof input !== 'object') {
      throw new Error('对话请求格式无效。');
    }
    const request = input as ChatStartInput;
    const officialProvider = officialProviderForChat(chatConfigStore);
    if (officialProvider) {
      await assertOfficialProviderAllowed(
        officialProvider,
        'first-request',
        undefined,
        'conversation',
      );
    }
    return chatService.start(request, (prepared) => {
      chatAttachmentStore.commitDraft(
        request.draftId,
        currentTurnLocalAttachmentIds(prepared.messages),
      );
    });
  });
  ipcMain.handle(CHANNELS.CHAT_STOP, (event, requestId: unknown) => {
    validateSender(event);
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
      throw new Error('对话请求标识无效。');
    }
    chatService.stop(requestId);
  });
};

export const registerChatIpc = ({
  chatAttachmentStore,
  chatConfigStore,
  chatHistoryStore,
  chatService,
  guards: { assertOfficialProviderAllowed, validateSender },
}: ChatIpcDependencies): void => {
  registerChatConfigIpc(chatConfigStore, chatService, validateSender);
  registerChatAttachmentIpc(chatAttachmentStore, chatHistoryStore, validateSender);
  registerChatHistoryIpc(chatHistoryStore, validateSender);
  registerChatRequestIpc(
    chatAttachmentStore,
    chatConfigStore,
    chatService,
    assertOfficialProviderAllowed,
    validateSender,
  );
};
