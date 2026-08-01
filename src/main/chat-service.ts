import type {
  ChatConnectionTestResult,
  ChatContentBlock,
  ChatMessage,
  ChatPreflightResult,
  ChatProtocol,
  ChatRetryReason,
  ChatStartInput,
  ChatStreamEvent,
  ChatTokenUsage,
  SaveChatConfigInput,
} from '../shared/contracts';
import type { ChatConfigStore, ChatRuntimeConfig } from './chat-config-store';
import type { ChatAttachmentStore } from './chat-attachment-store';
import { validateChatMessages } from './chat-history-store';

type EmitChatEvent = (event: ChatStreamEvent) => void;
type ChatFetch = typeof fetch;

interface ActiveChatRequest {
  abortReason?: 'manual' | 'timeout';
  controller: AbortController;
}

export interface ChatServiceTimeouts {
  idleTimeoutMs?: number;
  maxTransientRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

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

const MAX_RESPONSE_LENGTH = 2_000_000;
const MAX_TEST_RESPONSE_LENGTH = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
const REQUEST_IDLE_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRY_AFTER_MAX_DELAY_MS = 60_000;
const MAX_CHAT_REDIRECTS = 3;
const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const REDIRECT_HTTP_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STREAM_ERROR_TYPES = new Set(['api_error', 'overloaded_error', 'rate_limit_error']);
/**
 * The generation ceiling for one reply. 4096 silently truncated long answers, which read as the
 * model being "dumber" than the same gateway used from Claude Code. Gateways that cap lower reject
 * the request with a 400/422, which the retry ladder in run() handles.
 */
const STREAM_MAX_TOKENS = 64_000;
const STREAM_MAX_TOKENS_FALLBACK = 8_192;
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

const materializeLocalAttachments = async (
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

const readResponseText = async (response: Response, maximumLength: number): Promise<string> => {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const chunk = await reader.read();
    text += decoder.decode(chunk.value, { stream: !chunk.done });
    if (text.length > maximumLength) {
      await reader.cancel();
      return text.slice(0, maximumLength);
    }
    if (chunk.done) {
      return text;
    }
  }
};

const responseError = async (response: Response): Promise<Error> => {
  const text = await readResponseText(response, 4096);
  let detail = text;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    detail =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : text;
  } catch {
    // Plain-text gateway errors are already suitable for display.
  }
  return new Error(`接口返回 ${response.status}：${detail || response.statusText}`);
};

class ChatRedirectError extends Error {}

class ChatProtocolError extends Error {}

class ChatStreamProviderError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

class IncompleteChatStreamError extends Error {
  public constructor(
    message: string,
    public readonly emittedOutput: boolean,
  ) {
    super(message);
  }
}

const retryAfterMilliseconds = (response: Response): number | undefined => {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(RETRY_AFTER_MAX_DELAY_MS, Math.round(seconds * 1000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.min(RETRY_AFTER_MAX_DELAY_MS, Math.max(0, date - Date.now()));
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });

interface DirectChatResponse {
  refusal?: string;
  stopReason?: string;
  text?: string;
}

export const directChatResponse = (protocol: ChatProtocol, value: unknown): DirectChatResponse => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  if (protocol === 'anthropic' && Array.isArray(record.content)) {
    const blocks = record.content.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    );
    return {
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
        refusal: typeof message?.refusal === 'string' ? message.refusal : undefined,
        stopReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
        text: typeof message?.content === 'string' ? message.content : undefined,
      };
    }
  }
  return {};
};

const finiteToken = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const usageFromPayload = (protocol: ChatProtocol, value: unknown): UsagePatch | undefined => {
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

const mergeUsage = (
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

const sanitizeError = (
  error: unknown,
  credential: string | undefined,
  fallback: string,
): string => {
  const message = error instanceof Error ? error.message : fallback;
  return credential ? message.replaceAll(credential, '•••') : message;
};

const discardResponse = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // A rejected compatibility response may already be closed.
  }
};

export class ChatService {
  private readonly active = new Map<string, ActiveChatRequest>();
  private readonly idleTimeoutMs: number;
  private readonly maxTransientRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  public constructor(
    private readonly store: ChatConfigStore,
    private readonly emit: EmitChatEvent,
    private readonly fetchImpl: ChatFetch = fetch,
    private readonly attachmentStore?: ChatAttachmentStore,
    timeouts: ChatServiceTimeouts = {},
  ) {
    this.idleTimeoutMs = timeouts.idleTimeoutMs ?? REQUEST_IDLE_TIMEOUT_MS;
    this.maxTransientRetries = timeouts.maxTransientRetries ?? MAX_TRANSIENT_RETRIES;
    this.retryBaseDelayMs = timeouts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = timeouts.retryMaxDelayMs ?? RETRY_MAX_DELAY_MS;
    if (
      !Number.isFinite(this.idleTimeoutMs) ||
      this.idleTimeoutMs <= 0 ||
      !Number.isInteger(this.maxTransientRetries) ||
      this.maxTransientRetries < 0 ||
      !Number.isFinite(this.retryBaseDelayMs) ||
      this.retryBaseDelayMs <= 0 ||
      !Number.isFinite(this.retryMaxDelayMs) ||
      this.retryMaxDelayMs < this.retryBaseDelayMs
    ) {
      throw new Error('对话超时配置无效。');
    }
  }

  public preflight(input: ChatStartInput): ChatPreflightResult {
    return preflightChatRequest(input, this.attachmentStore);
  }

  public start(
    input: ChatStartInput,
    onAccepted?: (prepared: ChatPreflightResult) => void,
  ): ChatPreflightResult {
    const prepared = this.preflight(input);
    if (this.active.has(input.requestId)) {
      throw new Error('该对话请求已在运行。');
    }
    const config = this.store.getRuntimeConfig();
    this.validateRuntimeConfig(config);
    onAccepted?.(prepared);

    const active: ActiveChatRequest = { controller: new AbortController() };
    this.active.set(input.requestId, active);
    this.emit({ requestId: input.requestId, type: 'start' });
    setImmediate(() => {
      void this.run(input.requestId, prepared.messages, config, active);
    });
    return prepared;
  }

  public async test(input: SaveChatConfigInput): Promise<ChatConnectionTestResult> {
    const config = this.store.resolveRuntimeConfig(input);
    this.validateRuntimeConfig(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const messages = validateChatRequest({
        messages: [{ content: '.', role: 'user' }],
        requestId: 'connection-test',
      });
      const response = await this.fetchWithRedirectPolicy(
        endpointFor(config.baseUrl, config.protocol),
        {
          body: JSON.stringify(
            serializeChatRequestBody(config, messages, {
              includeUsage: false,
              stream: false,
            }),
          ),
          headers: requestHeaders(config, messages),
          method: 'POST',
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw await responseError(response);
      }
      const raw = await readResponseText(response, MAX_TEST_RESPONSE_LENGTH);
      const value = JSON.parse(raw) as unknown;
      const direct = directChatResponse(config.protocol, value);
      if (direct.text === undefined && direct.refusal === undefined) {
        throw new Error('接口响应格式与所选协议不一致。');
      }
      return {
        detail: '连接成功，接口、认证与模型响应均可用。',
        latencyMs: Date.now() - startedAt,
        ok: true,
        usage: mergeUsage(undefined, usageFromPayload(config.protocol, value)),
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return {
        detail: aborted
          ? '连接测试超时，请检查接口地址与网络。'
          : sanitizeError(error, config.credential, '连接测试失败。'),
        latencyMs: Date.now() - startedAt,
        ok: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  public stop(requestId: string): void {
    const active = this.active.get(requestId);
    if (active) {
      active.abortReason = 'manual';
      active.controller.abort('manual');
    }
  }

  public shutdown(): void {
    for (const active of this.active.values()) {
      active.abortReason = 'manual';
      active.controller.abort('manual');
    }
    this.active.clear();
  }

  private validateRuntimeConfig(config: ChatRuntimeConfig): void {
    if (!config.model) {
      throw new Error('请先在“对话”选项卡中配置模型。');
    }
    if (config.authMode !== 'none' && !config.credential) {
      throw new Error('请先为独立对话配置接口凭据。');
    }
  }

  private async fetchWithRedirectPolicy(url: string, init: RequestInit): Promise<Response> {
    let currentUrl = new URL(url);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await this.fetchImpl(currentUrl.toString(), {
        ...init,
        redirect: 'manual',
      });
      if (!REDIRECT_HTTP_STATUSES.has(response.status)) {
        return response;
      }

      const location = response.headers.get('location');
      if (!location) {
        await discardResponse(response);
        throw new ChatRedirectError(
          `接口返回 HTTP ${response.status} 重定向，但没有提供 Location。`,
        );
      }

      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        await discardResponse(response);
        throw new ChatRedirectError(`接口返回 HTTP ${response.status}，但重定向地址无效。`);
      }

      if (response.status !== 307 && response.status !== 308) {
        await discardResponse(response);
        throw new ChatRedirectError(
          `接口返回 HTTP ${response.status}（目标 ${target.host}）；为避免 POST 被改写，已拒绝跟随。请改用最终消息接口地址。`,
        );
      }
      if (target.origin !== currentUrl.origin || target.username || target.password) {
        await discardResponse(response);
        throw new ChatRedirectError(
          `接口返回跨站 HTTP ${response.status} 重定向（目标 ${target.host}）；为避免凭据泄漏，已拒绝跟随。`,
        );
      }
      if (redirectCount >= MAX_CHAT_REDIRECTS) {
        await discardResponse(response);
        throw new ChatRedirectError(`接口重定向次数超过 ${MAX_CHAT_REDIRECTS} 次上限。`);
      }

      await discardResponse(response);
      currentUrl = target;
    }
  }

  private retryDelay(retryNumber: number): number {
    const ceiling = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** Math.max(0, retryNumber - 1),
    );
    return Math.max(1, Math.round(ceiling * (0.5 + Math.random() * 0.5)));
  }

  private async run(
    requestId: string,
    messages: ChatMessage[],
    config: ChatRuntimeConfig,
    active: ActiveChatRequest,
  ): Promise<void> {
    const { controller } = active;
    let idleTimeout: NodeJS.Timeout | undefined;
    const abortForTimeout = (): void => {
      if (!controller.signal.aborted) {
        active.abortReason = 'timeout';
        controller.abort('timeout');
      }
    };
    const touchIdleTimeout = (): void => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(abortForTimeout, this.idleTimeoutMs);
    };
    touchIdleTimeout();
    try {
      const providerMessages = await materializeLocalAttachments(messages, this.attachmentStore);
      if (controller.signal.aborted) {
        throw new Error('对话请求已停止。');
      }
      const endpoint = endpointFor(config.baseUrl, config.protocol);
      const fetchStream = (attempt: {
        includeUsage: boolean;
        maxTokens?: number;
        thinking: boolean;
      }): Promise<Response> =>
        this.fetchWithRedirectPolicy(endpoint, {
          body: JSON.stringify(
            serializeChatRequestBody(config, providerMessages, {
              includeUsage: attempt.includeUsage,
              maxTokens: attempt.maxTokens,
              stream: true,
              thinking: attempt.thinking,
            }),
          ),
          headers: requestHeaders(config, providerMessages),
          method: 'POST',
          signal: controller.signal,
        });
      // Descend a compatibility ladder on 400/422: full request first, then drop the feature a
      // strict gateway is most likely rejecting (adaptive thinking / stream usage), then lower the
      // generation ceiling for gateways that cap max_tokens below our default.
      const attempts: Array<{ includeUsage: boolean; maxTokens?: number; thinking: boolean }> =
        config.protocol === 'anthropic'
          ? [
              { includeUsage: true, thinking: true },
              { includeUsage: true, thinking: false },
              { includeUsage: true, maxTokens: STREAM_MAX_TOKENS_FALLBACK, thinking: false },
            ]
          : [
              { includeUsage: true, thinking: false },
              { includeUsage: false, thinking: false },
            ];
      let transientRetries = 0;
      const scheduleRetry = async (
        retryReason: ChatRetryReason,
        detail: string,
        diagnostic: { retryAfterMs?: number; status?: number } = {},
      ): Promise<boolean> => {
        if (transientRetries >= this.maxTransientRetries) {
          return false;
        }
        transientRetries += 1;
        const retryAfterMs = diagnostic.retryAfterMs ?? this.retryDelay(transientRetries);
        this.emit({
          attempt: transientRetries + 1,
          detail,
          maxAttempts: this.maxTransientRetries + 1,
          requestId,
          retryAfterMs,
          retryReason,
          status: diagnostic.status,
          type: 'retrying',
        });
        touchIdleTimeout();
        await waitForRetry(retryAfterMs, controller.signal);
        touchIdleTimeout();
        return true;
      };

      const fetchResilient = async (attempt: (typeof attempts)[number]): Promise<Response> => {
        while (true) {
          let response: Response;
          try {
            response = await fetchStream(attempt);
          } catch (error) {
            if (controller.signal.aborted || error instanceof ChatRedirectError) {
              throw error;
            }
            const retrying = await scheduleRetry('network', '网络连接失败，正在重新连接。');
            if (retrying) {
              continue;
            }
            const detail = error instanceof Error ? error.message : '未知网络错误';
            throw new Error(`网络连接失败，已自动重试 ${transientRetries} 次：${detail}`, {
              cause: error,
            });
          }
          touchIdleTimeout();
          if (!TRANSIENT_HTTP_STATUSES.has(response.status)) {
            return response;
          }
          if (transientRetries >= this.maxTransientRetries) {
            return response;
          }
          const status = response.status;
          const retryAfter = retryAfterMilliseconds(response);
          await discardResponse(response);
          await scheduleRetry('http-status', `接口暂时返回 HTTP ${status}，正在自动重试。`, {
            retryAfterMs: retryAfter,
            status,
          });
        }
      };

      let selectedAttempt = attempts[0]!;
      let response = await fetchResilient(selectedAttempt);
      for (
        let compatibilityIndex = 1;
        compatibilityIndex < attempts.length;
        compatibilityIndex += 1
      ) {
        if (response.status !== 400 && response.status !== 422) {
          break;
        }
        await discardResponse(response);
        selectedAttempt = attempts[compatibilityIndex]!;
        response = await fetchResilient(selectedAttempt);
      }

      while (true) {
        if (!response.ok) {
          const error = await responseError(response);
          if (TRANSIENT_HTTP_STATUSES.has(response.status) && transientRetries > 0) {
            throw new Error(`${error.message}（已自动重试 ${transientRetries} 次）`);
          }
          throw error;
        }

        let emittedOutput = false;
        let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
            let raw: string;
            try {
              raw = await readResponseText(response, MAX_RESPONSE_LENGTH);
            } catch {
              throw new IncompleteChatStreamError('接口响应在读取完成前断开。', false);
            }
            let value: unknown;
            try {
              value = JSON.parse(raw) as unknown;
            } catch {
              throw new ChatProtocolError(
                '接口返回了非 SSE、非 JSON 的响应，请检查协议与最终接口地址。',
              );
            }
            const direct = directChatResponse(config.protocol, value);
            if (!direct.text && !direct.refusal) {
              throw new ChatProtocolError('接口响应中没有可显示的模型文本。');
            }
            const usage = mergeUsage(undefined, usageFromPayload(config.protocol, value));
            if (direct.text) {
              emittedOutput = true;
              this.emit({ delta: direct.text, requestId, type: 'delta', usage });
            }
            if (direct.refusal) {
              emittedOutput = true;
              this.emit({
                delta: direct.refusal,
                refusal: direct.refusal,
                requestId,
                stopReason: direct.stopReason ?? 'refusal',
                type: 'refusal',
              });
            }
            this.emit({
              requestId,
              stopReason: direct.stopReason,
              type: 'done',
              usage,
            });
            return;
          }
          if (!response.body) {
            throw new IncompleteChatStreamError('接口未返回可读取的响应流。', false);
          }

          streamReader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let responseLength = 0;
          let doneEvent = false;
          let providerUsage: ChatTokenUsage | undefined;
          let stopReason: string | undefined;
          while (!doneEvent) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await streamReader.read();
            } catch {
              throw new IncompleteChatStreamError(
                emittedOutput
                  ? '响应流在生成过程中断开；已保留收到的部分回答。'
                  : '响应流在首个有效内容到达前断开。',
                emittedOutput,
              );
            }
            if (!chunk.done) {
              touchIdleTimeout();
            }
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            const lines = buffer.split(/\r?\n/);
            buffer = chunk.done ? '' : (lines.pop() ?? '');
            for (const line of lines) {
              if (!line.startsWith('data:')) {
                continue;
              }
              const data = line.slice(5).trim();
              if (!data) {
                continue;
              }
              if (data === '[DONE]') {
                doneEvent = true;
                break;
              }
              let delta: ParsedChatStreamDelta;
              try {
                delta = parseChatStreamDelta(config.protocol, JSON.parse(data));
              } catch (error) {
                if (error instanceof ChatStreamProviderError && error.retryable) {
                  throw new IncompleteChatStreamError(error.message, emittedOutput);
                }
                throw error;
              }
              providerUsage = mergeUsage(providerUsage, delta.usage);
              stopReason = delta.stopReason ?? stopReason;
              for (const value of [delta.text, delta.thinking, delta.inputJson, delta.refusal]) {
                responseLength += value?.length ?? 0;
              }
              if (responseLength > MAX_RESPONSE_LENGTH) {
                await streamReader.cancel();
                throw new ChatProtocolError('模型响应超过安全长度限制，已停止接收。');
              }
              if (delta.text) {
                emittedOutput = true;
                this.emit({
                  delta: delta.text,
                  requestId,
                  type: 'delta',
                  usage: providerUsage,
                });
              }
              if (delta.thinking) {
                emittedOutput = true;
                this.emit({ delta: delta.thinking, requestId, type: 'thinking' });
              }
              if (delta.inputJson) {
                emittedOutput = true;
                this.emit({ delta: delta.inputJson, requestId, type: 'input-json' });
              }
              if (delta.refusal) {
                emittedOutput = true;
                this.emit({
                  delta: delta.refusal,
                  refusal: delta.refusal,
                  requestId,
                  stopReason: delta.stopReason ?? 'refusal',
                  type: 'refusal',
                });
              }
              if (
                !delta.text &&
                !delta.thinking &&
                !delta.inputJson &&
                !delta.refusal &&
                delta.usage
              ) {
                this.emit({ requestId, type: 'start', usage: providerUsage });
              }
              if (delta.done) {
                doneEvent = true;
                break;
              }
            }
            if (chunk.done) {
              break;
            }
          }
          if (!doneEvent) {
            throw new IncompleteChatStreamError(
              emittedOutput
                ? '响应流在结束标记前断开；已保留收到的部分回答。'
                : '响应流结束但没有返回协议结束标记。',
              emittedOutput,
            );
          }
          try {
            await streamReader.cancel();
          } catch {
            // A completed provider stream may already have closed its body.
          }
          this.emit({ requestId, stopReason, type: 'done', usage: providerUsage });
          return;
        } catch (error) {
          try {
            await streamReader?.cancel();
          } catch {
            // A broken provider stream may reject cancellation after the read failure.
          }
          if (
            !controller.signal.aborted &&
            error instanceof IncompleteChatStreamError &&
            !error.emittedOutput &&
            (await scheduleRetry('stream-incomplete', '响应尚未开始便已断开，正在重新请求。'))
          ) {
            response = await fetchResilient(selectedAttempt);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.emit({
        ...(controller.signal.aborted
          ? {
              abortReason: active.abortReason ?? 'manual',
              type: 'aborted' as const,
            }
          : {
              error: sanitizeError(error, config.credential, '独立对话请求失败。'),
              type: 'error' as const,
            }),
        requestId,
      });
    } finally {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      if (this.active.get(requestId) === active) {
        this.active.delete(requestId);
      }
    }
  }
}
