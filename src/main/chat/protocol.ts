import type {
  ChatContentBlock,
  ChatMessage,
  ChatPreflightResult,
  ChatProtocol,
  ChatStartInput,
  ChatTokenUsage,
} from '../../shared/contracts';
import type { ChatAttachmentStore } from './attachment-store';
import type { ChatRuntimeConfig } from './config-store';
import { validateChatMessages } from './history-store';

interface UsagePatch {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ParsedChatStreamDelta {
  done: boolean;
  inputJson?: string;
  refusal?: string;
  stopReason?: string;
  text?: string;
  thinking?: string;
  usage?: UsagePatch;
}

export interface ChatRequestBodyOptions {
  includeUsage: boolean;
  maxTokens?: number;
  stream: boolean;
  thinking?: boolean;
}

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
const RETRYABLE_STREAM_ERROR_TYPES = new Set(['api_error', 'overloaded_error', 'rate_limit_error']);
/**
 * The generation ceiling for one reply. 4096 silently truncated long answers, which read as the
 * model being "dumber" than the same gateway used from Claude Code. Gateways that cap lower reject
 * the request with a 400/422, which the retry ladder in run() handles.
 */
const STREAM_MAX_TOKENS = 64_000;
export const STREAM_MAX_TOKENS_FALLBACK = 8_192;
const IMAGE_MEDIA_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_MEDIA_TYPES = new Set(['application/pdf', 'text/plain']);

const base64ByteLength = (data: string): number => {
  if (
    data.length === 0 ||
    data.length > MAX_BASE64_LENGTH ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new Error('附件 base64 数据无效或超过 32 MB。');
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

const validateAttachmentMedia = (block: Exclude<ChatContentBlock, { type: 'text' }>): void => {
  const allowed = block.type === 'image' ? IMAGE_MEDIA_TYPES : DOCUMENT_MEDIA_TYPES;
  if (!allowed.has(block.mediaType.toLowerCase())) {
    throw new Error(
      block.type === 'image'
        ? '图片附件仅支持 JPEG、PNG、GIF 或 WebP。'
        : '文档附件仅支持 PDF、CSV 或纯文本。',
    );
  }
};

const hasVisibleBlock = (block: ChatContentBlock): boolean =>
  block.type !== 'text' || Boolean(block.text.trim());

/**
 * Validates and normalizes the renderer request. Unavailable attachments in older turns are
 * removed so one externally deleted file cannot permanently poison a conversation. The current
 * turn still has to contain visible content after repair.
 */
export const preflightChatRequest = (
  input: ChatStartInput,
  attachmentStore?: ChatAttachmentStore,
): ChatPreflightResult => {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.requestId !== 'string' ||
    !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)
  ) {
    throw new Error('对话请求格式无效。');
  }
  const messages = validateChatMessages(input.messages, {
    allowBase64: true,
    requireLastUser: true,
  });
  const removedAttachmentIds = new Set<string>();
  const repairedMessages = messages.flatMap((message, messageIndex) => {
    const content = (message.content as ChatContentBlock[]).flatMap<ChatContentBlock>((block) => {
      if (block.type === 'text') {
        return [block];
      }
      if (block.source.type === 'local') {
        if (!attachmentStore) {
          throw new Error('本地附件存储尚未接入对话服务。');
        }
        let attachment;
        try {
          attachment = attachmentStore.get(block.source.attachmentId);
        } catch {
          removedAttachmentIds.add(block.source.attachmentId);
          return [];
        }
        const normalized: ChatContentBlock = {
          fileName: attachment.fileName,
          mediaType: attachment.mediaType,
          source: { attachmentId: attachment.attachmentId, type: 'local' },
          type: attachment.type,
        };
        validateAttachmentMedia(normalized);
        return [normalized];
      }
      validateAttachmentMedia(block);
      return [block];
    });
    if (!content.some(hasVisibleBlock)) {
      if (messageIndex === messages.length - 1) {
        throw new Error('当前消息的附件已不可用，请重新选择后再发送。');
      }
      return [];
    }
    return [{ content, role: message.role }];
  });

  const normalized = validateChatMessages(repairedMessages, {
    allowBase64: true,
    requireLastUser: true,
  });
  let attachmentBytes = 0;
  for (const message of normalized) {
    for (const block of message.content as ChatContentBlock[]) {
      if (block.type === 'text') {
        continue;
      }
      if (block.source.type === 'local') {
        if (!attachmentStore) {
          throw new Error('本地附件存储尚未接入对话服务。');
        }
        attachmentBytes += attachmentStore.get(block.source.attachmentId).sizeBytes;
      } else if (block.source.type === 'base64') {
        attachmentBytes += base64ByteLength(block.source.data);
      }
      if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
        throw new Error('单次请求的附件总大小不能超过 32 MiB。');
      }
    }
  }
  const removed = [...removedAttachmentIds];
  return {
    messages: normalized,
    removedAttachmentIds: removed,
    ...(removed.length > 0
      ? { warning: `已自动移除 ${removed.length} 个在本机不可用的历史附件。` }
      : {}),
  };
};

export const validateChatRequest = (
  input: ChatStartInput,
  attachmentStore?: ChatAttachmentStore,
): ChatMessage[] => preflightChatRequest(input, attachmentStore).messages;

export const endpointFor = (baseUrl: string, protocol: ChatProtocol): string => {
  const parsed = new URL(baseUrl);
  const expected = protocol === 'anthropic' ? 'messages' : 'chat/completions';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname.endsWith(`/v1/${expected}`)) {
    return parsed.toString();
  }
  parsed.pathname = pathname.endsWith('/v1')
    ? `${pathname}/${expected}`
    : `${pathname}/v1/${expected}`;
  return parsed.toString();
};

const hasRemoteFile = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type !== 'text' && block.source.type === 'file'),
  );

export const requestHeaders = (
  config: ChatRuntimeConfig,
  messages: ChatMessage[] = [],
): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.authMode === 'apiKey' && config.credential) {
    // Gateways disagree on which header carries the key: official Anthropic reads x-api-key,
    // while most OpenAI-style relays only read Authorization. Sending both keeps one saved
    // credential working across gateways that the project terminal already connects to.
    headers['x-api-key'] = config.credential;
    headers.authorization = `Bearer ${config.credential}`;
  } else if (config.authMode === 'bearer' && config.credential) {
    headers.authorization = `Bearer ${config.credential}`;
  }
  if (config.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (hasRemoteFile(messages)) {
      headers['anthropic-beta'] = 'files-api-2025-04-14';
    }
  }
  return headers;
};

const textBlocks = (message: ChatMessage): Extract<ChatContentBlock, { type: 'text' }>[] =>
  typeof message.content === 'string'
    ? [{ text: message.content, type: 'text' as const }]
    : message.content.filter(
        (block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text',
      );

const attachmentData = (
  block: Exclude<ChatContentBlock, { type: 'text' }>,
  attachmentStore?: ChatAttachmentStore,
): string | undefined => {
  if (block.source.type === 'base64') {
    return block.source.data;
  }
  if (block.source.type === 'local') {
    if (!attachmentStore) {
      throw new Error('本地附件存储尚未接入对话服务。');
    }
    return attachmentStore.readBase64(block.source.attachmentId);
  }
  return undefined;
};

export const materializeLocalAttachments = async (
  messages: ChatMessage[],
  attachmentStore?: ChatAttachmentStore,
): Promise<ChatMessage[]> => {
  const encoded = new Map<string, Promise<string>>();
  return Promise.all(
    messages.map(async (message) => ({
      content: await Promise.all(
        (message.content as ChatContentBlock[]).map(async (block): Promise<ChatContentBlock> => {
          if (block.type === 'text' || block.source.type !== 'local') {
            return block;
          }
          if (!attachmentStore) {
            throw new Error('本地附件存储尚未接入对话服务。');
          }
          let pending = encoded.get(block.source.attachmentId);
          if (!pending) {
            pending = attachmentStore.readBase64Async(block.source.attachmentId);
            encoded.set(block.source.attachmentId, pending);
          }
          return {
            ...(block.fileName ? { fileName: block.fileName } : {}),
            mediaType: block.mediaType,
            source: { data: await pending, type: 'base64' },
            type: block.type,
          };
        }),
      ),
      role: message.role,
    })),
  );
};

const anthropicContent = (
  message: ChatMessage,
  attachmentStore?: ChatAttachmentStore,
): unknown[] => {
  const blocks =
    typeof message.content === 'string'
      ? [{ text: message.content, type: 'text' as const }]
      : message.content;
  const attachments = blocks
    .filter((block): block is Exclude<ChatContentBlock, { type: 'text' }> => block.type !== 'text')
    .map((block) => {
      const source =
        block.source.type === 'file'
          ? { file_id: block.source.fileId, type: 'file' }
          : {
              data: attachmentData(block, attachmentStore),
              media_type: block.mediaType,
              type: 'base64',
            };
      return { source, type: block.type };
    });
  return [
    ...attachments,
    ...blocks
      .filter(
        (block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text',
      )
      .map((block) => ({ text: block.text, type: 'text' })),
  ];
};

const openAiContent = (message: ChatMessage, attachmentStore?: ChatAttachmentStore): unknown[] => {
  const blocks =
    typeof message.content === 'string'
      ? [{ text: message.content, type: 'text' as const }]
      : message.content;
  return blocks.map((block) => {
    if (block.type === 'text') {
      return { text: block.text, type: 'text' };
    }
    const data = attachmentData(block, attachmentStore);
    if (block.type === 'image' && data) {
      return {
        image_url: { url: `data:${block.mediaType};base64,${data}` },
        type: 'image_url',
      };
    }
    return {
      file:
        block.source.type === 'file'
          ? { file_id: block.source.fileId }
          : {
              file_data: `data:${block.mediaType};base64,${data ?? ''}`,
              filename: block.fileName ?? 'attachment',
            },
      type: 'file',
    };
  });
};

export const serializeChatRequestBody = (
  config: ChatRuntimeConfig,
  messages: ChatMessage[],
  options: ChatRequestBodyOptions,
  attachmentStore?: ChatAttachmentStore,
): Record<string, unknown> => {
  if (config.protocol === 'anthropic') {
    return {
      max_tokens: options.stream ? (options.maxTokens ?? STREAM_MAX_TOKENS) : 1,
      messages: messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          content: anthropicContent(message, attachmentStore),
          role: message.role,
        })),
      model: config.model,
      stream: options.stream,
      system:
        messages
          .filter((message) => message.role === 'system')
          .flatMap(textBlocks)
          .map((block) => block.text)
          .join('\n\n') || undefined,
      thinking:
        options.stream && options.thinking
          ? { display: 'summarized', type: 'adaptive' }
          : undefined,
    };
  }
  return {
    max_tokens: options.stream ? undefined : 1,
    messages: messages.map((message) => ({
      content: openAiContent(message, attachmentStore),
      role: message.role,
    })),
    model: config.model,
    stream: options.stream,
    stream_options: options.stream && options.includeUsage ? { include_usage: true } : undefined,
  };
};

export class ChatStreamProviderError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface DirectChatResponse {
  recognized: boolean;
  refusal?: string;
  stopReason?: string;
  text?: string;
}

export const directChatResponse = (protocol: ChatProtocol, value: unknown): DirectChatResponse => {
  if (!value || typeof value !== 'object') {
    return { recognized: false };
  }
  const record = value as Record<string, unknown>;
  if (protocol === 'anthropic' && Array.isArray(record.content)) {
    const blocks = record.content.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    );
    return {
      recognized: true,
      refusal:
        blocks
          .filter((item) => item.type === 'refusal' && typeof item.refusal === 'string')
          .map((item) => String(item.refusal))
          .join('') || undefined,
      stopReason: typeof record.stop_reason === 'string' ? record.stop_reason : undefined,
      text:
        blocks
          .filter((item) => item.type === 'text' && typeof item.text === 'string')
          .map((item) => String(item.text))
          .join('') || undefined,
    };
  }
  if (protocol === 'openai' && Array.isArray(record.choices)) {
    const first = record.choices[0];
    if (first && typeof first === 'object') {
      const choice = first as Record<string, unknown>;
      const message =
        choice.message && typeof choice.message === 'object'
          ? (choice.message as Record<string, unknown>)
          : undefined;
      return {
        recognized: true,
        refusal: typeof message?.refusal === 'string' ? message.refusal : undefined,
        stopReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
        text: typeof message?.content === 'string' ? message.content : undefined,
      };
    }
    return { recognized: true };
  }
  return { recognized: false };
};

const finiteToken = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

export const usageFromPayload = (
  protocol: ChatProtocol,
  value: unknown,
): UsagePatch | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const directUsage =
    protocol === 'anthropic' && record.type === 'message_start'
      ? (record.message as { usage?: unknown } | undefined)?.usage
      : record.usage;
  if (!directUsage || typeof directUsage !== 'object') {
    return undefined;
  }
  const usage = directUsage as Record<string, unknown>;
  const inputTokens = finiteToken(
    protocol === 'anthropic' ? usage.input_tokens : usage.prompt_tokens,
  );
  const outputTokens = finiteToken(
    protocol === 'anthropic' ? usage.output_tokens : usage.completion_tokens,
  );
  const totalTokens = finiteToken(usage.total_tokens);
  return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    ? undefined
    : { inputTokens, outputTokens, totalTokens };
};

export const mergeUsage = (
  current: ChatTokenUsage | undefined,
  patch: UsagePatch | undefined,
): ChatTokenUsage | undefined => {
  if (!patch) {
    return current;
  }
  const inputTokens = patch.inputTokens ?? current?.inputTokens ?? 0;
  const outputTokens = patch.outputTokens ?? current?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    source: 'provider',
    totalTokens: patch.totalTokens ?? inputTokens + outputTokens,
  };
};

export const parseChatStreamDelta = (
  protocol: ChatProtocol,
  value: unknown,
): ParsedChatStreamDelta => {
  if (!value || typeof value !== 'object') {
    return { done: false };
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'error') {
    const error = record.error;
    const errorType =
      error && typeof error === 'object' && typeof (error as { type?: unknown }).type === 'string'
        ? (error as { type: string }).type
        : undefined;
    const detail =
      error &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '接口流返回错误。';
    throw new ChatStreamProviderError(
      detail,
      Boolean(errorType && RETRYABLE_STREAM_ERROR_TYPES.has(errorType)),
    );
  }
  const usage = usageFromPayload(protocol, value);
  if (protocol === 'anthropic') {
    if (record.type === 'message_stop') {
      return { done: true, usage };
    }
    const delta =
      record.delta && typeof record.delta === 'object'
        ? (record.delta as Record<string, unknown>)
        : undefined;
    const contentBlock =
      record.content_block && typeof record.content_block === 'object'
        ? (record.content_block as Record<string, unknown>)
        : undefined;
    const stopReason =
      record.type === 'message_delta' && typeof delta?.stop_reason === 'string'
        ? delta.stop_reason
        : undefined;
    return {
      done: false,
      inputJson:
        record.type === 'content_block_delta' &&
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
          ? delta.partial_json
          : undefined,
      refusal:
        record.type === 'content_block_delta' &&
        delta?.type === 'refusal_delta' &&
        typeof delta.refusal === 'string'
          ? delta.refusal
          : record.type === 'content_block_start' &&
              contentBlock?.type === 'refusal' &&
              typeof contentBlock.refusal === 'string'
            ? contentBlock.refusal
            : stopReason === 'refusal'
              ? '模型拒绝了此请求。'
              : undefined,
      stopReason,
      text:
        record.type === 'content_block_delta' &&
        delta?.type === 'text_delta' &&
        typeof delta.text === 'string'
          ? delta.text
          : undefined,
      thinking:
        record.type === 'content_block_delta' &&
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
          ? delta.thinking
          : undefined,
      usage,
    };
  }

  const choices = record.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const choice =
    first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
  const delta =
    choice?.delta && typeof choice.delta === 'object'
      ? (choice.delta as Record<string, unknown>)
      : undefined;
  return {
    // OpenAI-compatible streams send a usage-only chunk after finish_reason. Keep reading until
    // [DONE] or EOF so final provider token counts are not discarded.
    done: false,
    refusal: typeof delta?.refusal === 'string' ? delta.refusal : undefined,
    stopReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
    text: typeof delta?.content === 'string' ? delta.content : undefined,
    usage,
  };
};
