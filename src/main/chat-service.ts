import type {
  ChatMessage,
  ChatProtocol,
  ChatStartInput,
  ChatStreamEvent,
} from '../shared/contracts';
import type { ChatConfigStore } from './chat-config-store';

type EmitChatEvent = (event: ChatStreamEvent) => void;
type ChatFetch = typeof fetch;

const MAX_MESSAGE_COUNT = 100;
const MAX_MESSAGE_LENGTH = 200_000;
const MAX_TOTAL_MESSAGE_LENGTH = 1_000_000;
const MAX_RESPONSE_LENGTH = 2_000_000;
const REQUEST_TIMEOUT_MS = 120_000;

const validateRequest = (input: ChatStartInput): ChatMessage[] => {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.requestId !== 'string' ||
    !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId) ||
    !Array.isArray(input.messages) ||
    input.messages.length === 0 ||
    input.messages.length > MAX_MESSAGE_COUNT
  ) {
    throw new Error('对话请求格式无效。');
  }

  let totalLength = 0;
  const messages = input.messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message.role !== 'assistant' && message.role !== 'system' && message.role !== 'user') ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new Error('对话消息格式无效或内容过长。');
    }
    totalLength += message.content.length;
    return { content: message.content, role: message.role };
  });

  if (totalLength > MAX_TOTAL_MESSAGE_LENGTH || messages.at(-1)?.role !== 'user') {
    throw new Error('对话内容总长度过大，或最后一条消息不是用户消息。');
  }
  return messages;
};

const endpointFor = (baseUrl: string, protocol: ChatProtocol): string => {
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

const responseError = async (response: Response): Promise<Error> => {
  const text = (await response.text()).slice(0, 4096);
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

const directResponseText = (protocol: ChatProtocol, value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (protocol === 'anthropic' && Array.isArray(record.content)) {
    return record.content
      .map((item) =>
        item &&
        typeof item === 'object' &&
        'text' in item &&
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('');
  }
  if (protocol === 'openai' && Array.isArray(record.choices)) {
    const first = record.choices[0];
    if (first && typeof first === 'object') {
      const message = (first as { message?: unknown }).message;
      if (message && typeof message === 'object') {
        const content = (message as { content?: unknown }).content;
        return typeof content === 'string' ? content : undefined;
      }
    }
  }
  return undefined;
};

const streamDelta = (protocol: ChatProtocol, value: unknown): { done: boolean; text?: string } => {
  if (!value || typeof value !== 'object') {
    return { done: false };
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'error') {
    const error = record.error;
    const detail =
      error &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '接口流返回错误。';
    throw new Error(detail);
  }
  if (protocol === 'anthropic') {
    if (record.type === 'message_stop') {
      return { done: true };
    }
    const delta = record.delta;
    return {
      done: false,
      text:
        record.type === 'content_block_delta' &&
        delta &&
        typeof delta === 'object' &&
        typeof (delta as { text?: unknown }).text === 'string'
          ? (delta as { text: string }).text
          : undefined,
    };
  }

  const choices = record.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const delta =
    first && typeof first === 'object' ? (first as { delta?: unknown }).delta : undefined;
  const finishReason =
    first && typeof first === 'object'
      ? (first as { finish_reason?: unknown }).finish_reason
      : undefined;
  return {
    done: typeof finishReason === 'string',
    text:
      delta &&
      typeof delta === 'object' &&
      typeof (delta as { content?: unknown }).content === 'string'
        ? (delta as { content: string }).content
        : undefined,
  };
};

export class ChatService {
  private readonly active = new Map<string, AbortController>();

  public constructor(
    private readonly store: ChatConfigStore,
    private readonly emit: EmitChatEvent,
    private readonly fetchImpl: ChatFetch = fetch,
  ) {}

  public start(input: ChatStartInput): void {
    const messages = validateRequest(input);
    if (this.active.has(input.requestId)) {
      throw new Error('该对话请求已在运行。');
    }
    const config = this.store.getRuntimeConfig();
    if (!config.model) {
      throw new Error('请先在“对话”选项卡中配置模型。');
    }
    if (config.authMode !== 'none' && !config.credential) {
      throw new Error('请先为独立对话配置接口凭据。');
    }

    const controller = new AbortController();
    this.active.set(input.requestId, controller);
    this.emit({ requestId: input.requestId, type: 'start' });
    void this.run(input.requestId, messages, config, controller);
  }

  public stop(requestId: string): void {
    this.active.get(requestId)?.abort();
  }

  public shutdown(): void {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.active.clear();
  }

  private async run(
    requestId: string,
    messages: ChatMessage[],
    config: ReturnType<ChatConfigStore['getRuntimeConfig']>,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.authMode === 'apiKey' && config.credential) {
        headers['x-api-key'] = config.credential;
      } else if (config.authMode === 'bearer' && config.credential) {
        headers.authorization = `Bearer ${config.credential}`;
      }
      if (config.protocol === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }

      const body =
        config.protocol === 'anthropic'
          ? {
              max_tokens: 4096,
              messages: messages.filter((message) => message.role !== 'system'),
              model: config.model,
              stream: true,
              system:
                messages
                  .filter((message) => message.role === 'system')
                  .map((message) => message.content)
                  .join('\n\n') || undefined,
            }
          : { messages, model: config.model, stream: true };
      const response = await this.fetchImpl(endpointFor(config.baseUrl, config.protocol), {
        body: JSON.stringify(body),
        headers,
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw await responseError(response);
      }

      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const raw = await response.text();
        const text = directResponseText(config.protocol, JSON.parse(raw));
        if (!text) {
          throw new Error('接口响应中没有可显示的模型文本。');
        }
        this.emit({ delta: text, requestId, type: 'delta' });
        this.emit({ requestId, type: 'done' });
        return;
      }
      if (!response.body) {
        throw new Error('接口未返回可读取的响应流。');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let responseLength = 0;
      let doneEvent = false;
      while (!doneEvent) {
        const chunk = await reader.read();
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
          const delta = streamDelta(config.protocol, JSON.parse(data));
          if (delta.text) {
            responseLength += delta.text.length;
            if (responseLength > MAX_RESPONSE_LENGTH) {
              throw new Error('模型响应超过安全长度限制，已停止接收。');
            }
            this.emit({ delta: delta.text, requestId, type: 'delta' });
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
      this.emit({ requestId, type: 'done' });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '独立对话请求失败。';
      const safeMessage = config.credential
        ? rawMessage.replaceAll(config.credential, '•••')
        : rawMessage;
      this.emit({
        ...(controller.signal.aborted
          ? { type: 'aborted' as const }
          : {
              error: safeMessage,
              type: 'error' as const,
            }),
        requestId,
      });
    } finally {
      clearTimeout(timeout);
      if (this.active.get(requestId) === controller) {
        this.active.delete(requestId);
      }
    }
  }
}
