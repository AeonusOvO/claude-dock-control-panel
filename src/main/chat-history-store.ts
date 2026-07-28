import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatTokenUsage,
  SaveChatConversationInput,
} from '../shared/contracts';

interface StoredChatHistoryFile {
  conversations: ChatConversation[];
  version: 1;
}

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 200_000;
const MAX_TOTAL_MESSAGE_LENGTH = 1_000_000;
const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cloneConversation = (conversation: ChatConversation): ChatConversation => ({
  ...conversation,
  messages: conversation.messages.map((message) => ({ ...message })),
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

const validateMessages = (value: unknown): ChatMessage[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new Error('对话历史消息数量无效。');
  }
  let totalLength = 0;
  const messages = value.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('role' in message) ||
      (message.role !== 'assistant' && message.role !== 'system' && message.role !== 'user') ||
      !('content' in message) ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new Error('对话历史包含无效或过长的消息。');
    }
    totalLength += message.content.length;
    return { content: message.content, role: message.role };
  });
  if (totalLength > MAX_TOTAL_MESSAGE_LENGTH) {
    throw new Error('对话历史内容超过本地保存上限。');
  }
  return messages;
};

const titleFor = (messages: ChatMessage[]): string => {
  const seed = messages.find((message) => message.role === 'user')?.content ?? '新对话';
  const normalized = seed.replace(/\s+/g, ' ').trim();
  return normalized.length > 40 ? `${normalized.slice(0, 39)}…` : normalized || '新对话';
};

const summaryOf = (conversation: ChatConversation): ChatConversationSummary => ({
  createdAt: conversation.createdAt,
  id: conversation.id,
  messageCount: conversation.messageCount,
  title: conversation.title,
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
    const messages = validateMessages(record.messages);
    return {
      createdAt: record.createdAt,
      id: record.id,
      messageCount: messages.length,
      messages,
      title: record.title,
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

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'chat-history.json');
  }

  public list(): ChatConversationSummary[] {
    return this.load().conversations.map(summaryOf);
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
    const messages = validateMessages(input.messages);
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
      title: titleFor(messages),
      updatedAt: now,
      usage: { ...input.usage },
    };
    history.conversations = [
      conversation,
      ...history.conversations.filter((item) => item.id !== conversation.id),
    ].slice(0, MAX_CONVERSATIONS);
    this.persist(history);
    return cloneConversation(conversation);
  }

  public delete(conversationId: string): boolean {
    this.validateId(conversationId);
    const history = this.load();
    const next = history.conversations.filter((conversation) => conversation.id !== conversationId);
    if (next.length === history.conversations.length) {
      return false;
    }
    history.conversations = next;
    this.persist(history);
    return true;
  }

  private validateId(conversationId: string): void {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      throw new Error('对话历史标识无效。');
    }
  }

  private load(): StoredChatHistoryFile {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        conversations?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) {
        return { conversations: [], version: 1 };
      }
      return {
        conversations: parsed.conversations
          .map(parseConversation)
          .filter((conversation): conversation is ChatConversation => Boolean(conversation))
          .sort((first, second) => second.updatedAt - first.updatedAt)
          .slice(0, MAX_CONVERSATIONS),
        version: 1,
      };
    } catch {
      return { conversations: [], version: 1 };
    }
  }

  private persist(store: StoredChatHistoryFile): void {
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
