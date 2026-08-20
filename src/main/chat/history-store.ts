import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  ChatAttachmentSource,
  ChatContentBlock,
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatMessageRole,
  ChatTokenUsage,
  SaveChatConversationInput,
} from '../../shared/contracts';
import { ChatAttachmentStore, chatAttachmentIds, isChatAttachmentId } from './attachment-store';

interface StoredChatHistoryFile {
  conversations: ChatConversation[];
  version: 2;
}

export class ChatHistoryUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ChatHistoryUnavailableError';
  }
}

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 100;
const MAX_BLOCKS_PER_MESSAGE = 32;
const MAX_MESSAGE_TEXT_LENGTH = 200_000;
const MAX_TOTAL_TEXT_LENGTH = 1_000_000;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 127;
const MAX_FILE_ID_LENGTH = 512;
const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80] as const;
const RETRYABLE_WINDOWS_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const synchronousSleepBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface AtomicChatHistoryWriteOptions {
  encoding: 'utf8';
  flag: 'wx';
  mode: number;
}

export interface AtomicChatHistoryOperations {
  createTemporaryId: () => string;
  renameFile: (source: string, destination: string) => void;
  sleep: (delayMs: number) => void;
  unlinkFile: (filePath: string) => void;
  writeFile: (filePath: string, contents: string, options: AtomicChatHistoryWriteOptions) => void;
}

const defaultAtomicChatHistoryOperations: AtomicChatHistoryOperations = {
  createTemporaryId: randomUUID,
  renameFile: renameSync,
  sleep: (delayMs) => {
    Atomics.wait(synchronousSleepBuffer, 0, 0, delayMs);
  },
  unlinkFile: unlinkSync,
  writeFile: (filePath, contents, options) => {
    writeFileSync(filePath, contents, options);
  },
};

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

/** Replaces one history file without ever deleting its last valid destination bytes. */
export const replaceChatHistoryFileAtomically = (
  storagePath: string,
  contents: string,
  operationOverrides: Partial<AtomicChatHistoryOperations> = {},
): void => {
  const operations = {
    ...defaultAtomicChatHistoryOperations,
    ...operationOverrides,
  };
  const temporaryPath = `${storagePath}.tmp-${process.pid}-${operations.createTemporaryId()}`;
  let ownsTemporaryFile = false;
  try {
    try {
      operations.writeFile(temporaryPath, contents, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      ownsTemporaryFile = true;
    } catch (error) {
      // EEXIST means the exclusive create did not give us ownership; every other write failure may
      // have left bytes in our UUID-named path and is safe to clean without touching the destination.
      if (errorCode(error) !== 'EEXIST') {
        try {
          operations.unlinkFile(temporaryPath);
        } catch {
          // Preserve the write failure rather than replacing it with best-effort cleanup details.
        }
      }
      throw error;
    }

    for (let retryIndex = 0; ; retryIndex += 1) {
      try {
        operations.renameFile(temporaryPath, storagePath);
        ownsTemporaryFile = false;
        return;
      } catch (error) {
        const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
        if (
          !RETRYABLE_WINDOWS_RENAME_ERRORS.has(errorCode(error) ?? '') ||
          retryDelay === undefined
        ) {
          throw error;
        }
        operations.sleep(retryDelay);
      }
    }
  } finally {
    if (ownsTemporaryFile) {
      try {
        operations.unlinkFile(temporaryPath);
      } catch {
        // The primary write/rename result remains authoritative; only our unique temporary file is touched.
      }
    }
  }
};

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });

const cloneSource = (source: ChatAttachmentSource): ChatAttachmentSource => {
  if (source.type === 'local') {
    return { attachmentId: source.attachmentId, type: 'local' };
  }
  if (source.type === 'file') {
    return { fileId: source.fileId, type: 'file' };
  }
  return { data: source.data, type: 'base64' };
};

const cloneBlock = (block: ChatContentBlock): ChatContentBlock =>
  block.type === 'text'
    ? { text: block.text, type: 'text' }
    : {
        ...(block.fileName ? { fileName: block.fileName } : {}),
        mediaType: block.mediaType,
        source: cloneSource(block.source),
        type: block.type,
      };

export const cloneChatMessage = (message: ChatMessage): ChatMessage => ({
  content:
    typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => cloneBlock(block)),
  role: message.role,
});

const cloneConversation = (conversation: ChatConversation): ChatConversation => ({
  ...conversation,
  messages: conversation.messages.map(cloneChatMessage),
  usage: { ...conversation.usage },
});

const isUsage = (value: unknown): value is ChatTokenUsage => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.inputTokens) &&
    Number(record.inputTokens) >= 0 &&
    Number.isSafeInteger(record.outputTokens) &&
    Number(record.outputTokens) >= 0 &&
    Number.isSafeInteger(record.totalTokens) &&
    Number(record.totalTokens) >= 0 &&
    (record.source === 'estimated' || record.source === 'provider')
  );
};

const validRole = (value: unknown): value is ChatMessageRole =>
  value === 'assistant' || value === 'system' || value === 'user';

const validateTextBlock = (value: Record<string, unknown>): ChatContentBlock => {
  if (typeof value.text !== 'string' || value.text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new Error('对话历史包含无效或过长的文本块。');
  }
  return { text: value.text, type: 'text' };
};

const validateAttachmentSource = (value: unknown, allowBase64: boolean): ChatAttachmentSource => {
  if (!value || typeof value !== 'object') {
    throw new Error('对话历史包含无效附件来源。');
  }
  const source = value as Record<string, unknown>;
  if (source.type === 'local' && isChatAttachmentId(source.attachmentId)) {
    return { attachmentId: source.attachmentId, type: 'local' };
  }
  if (
    source.type === 'file' &&
    typeof source.fileId === 'string' &&
    source.fileId.length > 0 &&
    source.fileId.length <= MAX_FILE_ID_LENGTH &&
    !hasControlCharacter(source.fileId)
  ) {
    return { fileId: source.fileId, type: 'file' };
  }
  if (source.type === 'base64') {
    if (!allowBase64) {
      throw new Error('对话历史不能保存 base64 附件，请先导入本地附件。');
    }
    if (typeof source.data !== 'string' || source.data.length === 0 || /\s/.test(source.data)) {
      throw new Error('对话历史包含无效 base64 附件。');
    }
    return { data: source.data, type: 'base64' };
  }
  throw new Error('对话历史包含无效附件来源。');
};

const validateAttachmentBlock = (
  value: Record<string, unknown>,
  role: ChatMessageRole,
  allowBase64: boolean,
): ChatContentBlock => {
  if (role !== 'user') {
    throw new Error('只有用户消息可以包含附件。');
  }
  if (
    (value.type !== 'document' && value.type !== 'image') ||
    typeof value.mediaType !== 'string' ||
    value.mediaType.length === 0 ||
    value.mediaType.length > MAX_MEDIA_TYPE_LENGTH ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value.mediaType) ||
    (value.fileName !== undefined &&
      (typeof value.fileName !== 'string' ||
        value.fileName.length === 0 ||
        value.fileName.length > MAX_FILE_NAME_LENGTH ||
        hasControlCharacter(value.fileName)))
  ) {
    throw new Error('对话历史包含无效附件块。');
  }
  return {
    ...(typeof value.fileName === 'string' ? { fileName: value.fileName } : {}),
    mediaType: value.mediaType,
    source: validateAttachmentSource(value.source, allowBase64),
    type: value.type,
  };
};

export interface ValidateChatMessagesOptions {
  allowBase64?: boolean;
  requireLastUser?: boolean;
}

/**
 * The single canonical validator for persisted and outbound chat messages. String content is
 * normalized into a text block, so callers never need a separate migration pass for 1.x history.
 */
export const validateChatMessages = (
  value: unknown,
  options: ValidateChatMessagesOptions = {},
): ChatMessage[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new Error('对话历史消息数量无效。');
  }
  let totalTextLength = 0;
  const messages = value.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !('role' in candidate) ||
      !validRole(candidate.role) ||
      !('content' in candidate)
    ) {
      throw new Error('对话历史包含无效消息。');
    }
    const role = candidate.role;
    const rawBlocks =
      typeof candidate.content === 'string'
        ? [{ text: candidate.content, type: 'text' }]
        : candidate.content;
    if (
      !Array.isArray(rawBlocks) ||
      rawBlocks.length === 0 ||
      rawBlocks.length > MAX_BLOCKS_PER_MESSAGE
    ) {
      throw new Error('对话历史消息块数量无效。');
    }
    let messageTextLength = 0;
    let hasVisibleContent = false;
    const content = rawBlocks.map((block) => {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        throw new Error('对话历史包含无效内容块。');
      }
      const record = block as Record<string, unknown>;
      const normalized =
        record.type === 'text'
          ? validateTextBlock(record)
          : validateAttachmentBlock(record, role, options.allowBase64 ?? false);
      if (normalized.type === 'text') {
        messageTextLength += normalized.text.length;
        hasVisibleContent ||= Boolean(normalized.text.trim());
      } else {
        hasVisibleContent = true;
      }
      return normalized;
    });
    if (!hasVisibleContent || messageTextLength > MAX_MESSAGE_TEXT_LENGTH) {
      throw new Error('对话历史包含空消息或过长消息。');
    }
    totalTextLength += messageTextLength;
    return { content, role };
  });
  if (totalTextLength > MAX_TOTAL_TEXT_LENGTH) {
    throw new Error('对话历史文本超过本地保存上限。');
  }
  if (options.requireLastUser && messages.at(-1)?.role !== 'user') {
    throw new Error('对话最后一条消息必须是用户消息。');
  }
  return messages;
};

const textForMessage = (message: ChatMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter(
          (block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text',
        )
        .map((block) => block.text)
        .join(' ');

const titleFor = (messages: ChatMessage[]): string => {
  const firstUser = messages.find((message) => message.role === 'user');
  const seed = firstUser ? textForMessage(firstUser) : '新对话';
  const normalized = seed.replace(/\s+/g, ' ').trim();
  return normalized.length > 40 ? `${normalized.slice(0, 39)}…` : normalized || '附件对话';
};

export const MAX_CONVERSATION_TITLE_LENGTH = 60;

/**
 * Normalizes a user-supplied conversation name. Control characters would corrupt the sidebar label
 * and the persisted index, so they are stripped rather than escaped.
 */
const normalizeCustomTitle = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error('对话名称无效。');
  }
  const normalized = [...value.normalize('NFC')]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    throw new Error('对话名称不能为空。');
  }
  if (normalized.length > MAX_CONVERSATION_TITLE_LENGTH) {
    throw new Error(`对话名称不能超过 ${MAX_CONVERSATION_TITLE_LENGTH} 个字符。`);
  }
  return normalized;
};

const summaryOf = (conversation: ChatConversation): ChatConversationSummary => ({
  createdAt: conversation.createdAt,
  id: conversation.id,
  messageCount: conversation.messageCount,
  title: conversation.title,
  ...(conversation.titleCustom ? { titleCustom: true } : {}),
  updatedAt: conversation.updatedAt,
  usage: { ...conversation.usage },
});

const parseConversation = (value: unknown): ChatConversation | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !CONVERSATION_ID_PATTERN.test(record.id) ||
    typeof record.title !== 'string' ||
    !record.title.trim() ||
    record.title.length > 60 ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    !isUsage(record.usage)
  ) {
    return undefined;
  }
  try {
    const messages = validateChatMessages(record.messages);
    return {
      createdAt: record.createdAt,
      id: record.id,
      messageCount: messages.length,
      messages,
      title: record.title,
      ...(record.titleCustom === true ? { titleCustom: true } : {}),
      updatedAt: record.updatedAt,
      usage: { ...record.usage },
    };
  } catch {
    return undefined;
  }
};

export class ChatHistoryStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;
  private readonly attachmentStore: ChatAttachmentStore;

  public constructor(userDataPath: string, attachmentStore?: ChatAttachmentStore) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'chat-history.json');
    this.attachmentStore = attachmentStore ?? new ChatAttachmentStore(userDataPath);
  }

  public list(): ChatConversationSummary[] {
    return this.load().conversations.map(summaryOf);
  }

  /** Snapshot used by startup orphan collection; attachment bytes never leave the main process. */
  public referencedAttachmentIds(): ReadonlySet<string> {
    return chatAttachmentIds(
      this.load().conversations.flatMap((conversation) => conversation.messages),
    );
  }

  public get(conversationId: string): ChatConversation | undefined {
    this.validateId(conversationId);
    const conversation = this.load().conversations.find((item) => item.id === conversationId);
    return conversation ? cloneConversation(conversation) : undefined;
  }

  public save(input: SaveChatConversationInput): ChatConversation {
    if (!input || typeof input !== 'object' || !isUsage(input.usage)) {
      throw new Error('对话历史保存参数无效。');
    }
    const messages = validateChatMessages(input.messages);
    const history = this.load();
    const requestedId = input.conversationId;
    if (requestedId) {
      this.validateId(requestedId);
    }
    const existing = requestedId
      ? history.conversations.find((conversation) => conversation.id === requestedId)
      : undefined;
    const now = Date.now();
    const conversation: ChatConversation = {
      createdAt: existing?.createdAt ?? now,
      id: existing?.id ?? randomUUID(),
      messageCount: messages.length,
      messages,
      // A renamed conversation keeps its name; only derived titles follow the first user message.
      title: existing?.titleCustom ? existing.title : titleFor(messages),
      ...(existing?.titleCustom ? { titleCustom: true } : {}),
      updatedAt: now,
      usage: { ...input.usage },
    };
    const withoutCurrent = history.conversations.filter((item) => item.id !== conversation.id);
    const nextConversations = [conversation, ...withoutCurrent].slice(0, MAX_CONVERSATIONS);
    const removed = [
      ...(existing ? [existing] : []),
      ...withoutCurrent.slice(MAX_CONVERSATIONS - 1),
    ];
    history.conversations = nextConversations;
    this.persist(history);
    this.cleanupAttachments(removed, nextConversations);
    return cloneConversation(conversation);
  }

  public rename(conversationId: string, title: unknown): ChatConversation | undefined {
    this.validateId(conversationId);
    const normalized = normalizeCustomTitle(title);
    const history = this.load();
    const conversation = history.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      return undefined;
    }
    conversation.title = normalized;
    conversation.titleCustom = true;
    this.persist(history);
    return cloneConversation(conversation);
  }

  public delete(conversationId: string): boolean {
    this.validateId(conversationId);
    const history = this.load();
    const removed = history.conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (!removed) {
      return false;
    }
    history.conversations = history.conversations.filter(
      (conversation) => conversation.id !== conversationId,
    );
    this.persist(history);
    this.cleanupAttachments([removed], history.conversations);
    return true;
  }

  /**
   * Deletes attachment bytes that no retained conversation references any more.
   *
   * Only ever called after the history file is durably committed, so a failure here must not be
   * reported as a failure of the whole operation: telling the caller nothing was saved invites a
   * retry of a write that already succeeded. Leftover bytes are reclaimed by the startup orphan
   * collector instead, which is why swallowing is safe rather than a silent leak.
   */
  private cleanupAttachments(removed: ChatConversation[], retained: ChatConversation[]): void {
    try {
      const candidates = chatAttachmentIds(
        removed.flatMap((conversation) => conversation.messages),
      );
      const retainedIds = chatAttachmentIds(
        retained.flatMap((conversation) => conversation.messages),
      );
      this.attachmentStore.deleteUnreferenced(candidates, retainedIds);
    } catch {
      // Locked or already-removed attachment directories are reclaimed on the next startup sweep.
    }
  }

  private validateId(conversationId: string): void {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      throw new Error('对话历史标识无效。');
    }
  }

  private load(): StoredChatHistoryFile {
    let source: string;
    try {
      source = readFileSync(this.storagePath, 'utf8');
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return { conversations: [], version: 2 };
      }
      throw this.historyUnavailable(error);
    }

    try {
      const parsed = JSON.parse(source) as {
        conversations?: unknown;
        version?: unknown;
      };
      if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.conversations)) {
        throw new Error('历史文件版本或顶层结构无效。');
      }
      const conversations = parsed.conversations.map((candidate, index) => {
        const conversation = parseConversation(candidate);
        if (!conversation) {
          throw new Error(`第 ${index + 1} 条对话记录损坏。`);
        }
        return conversation;
      });
      const ids = new Set(conversations.map((conversation) => conversation.id));
      if (ids.size !== conversations.length) {
        throw new Error('历史文件包含重复的对话标识。');
      }
      return {
        conversations: conversations
          .sort((first, second) => second.updatedAt - first.updatedAt)
          .slice(0, MAX_CONVERSATIONS),
        version: 2,
      };
    } catch (error) {
      throw this.historyUnavailable(error);
    }
  }

  private historyUnavailable(_cause: unknown): ChatHistoryUnavailableError {
    const backupPath = `${this.storagePath}.corrupt.bak`;
    let backupDetail = '';
    try {
      copyFileSync(this.storagePath, backupPath, fsConstants.COPYFILE_EXCL);
      backupDetail = ` 原文件已保留为 ${path.basename(backupPath)}。`;
    } catch (backupError) {
      if (
        backupError &&
        typeof backupError === 'object' &&
        'code' in backupError &&
        (backupError as { code?: unknown }).code === 'EEXIST'
      ) {
        backupDetail = ` 已保留现有备份 ${path.basename(backupPath)}。`;
      }
    }
    return new ChatHistoryUnavailableError(
      `本机对话历史无法安全读取；ClaudeDock 已停止覆盖历史和清理附件。${backupDetail}`,
    );
  }

  private persist(store: StoredChatHistoryFile): void {
    mkdirSync(this.storageDirectory, { recursive: true });
    replaceChatHistoryFileAtomically(this.storagePath, `${JSON.stringify(store, null, 2)}\n`);
  }
}
