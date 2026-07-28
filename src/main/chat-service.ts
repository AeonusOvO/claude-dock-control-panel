import type {
  ChatConnectionTestResult,
  ChatMessage,
  ChatProtocol,
  ChatStartInput,
  ChatStreamEvent,
  ChatTokenUsage,
  SaveChatConfigInput,
} from '../shared/contracts';
import type { ChatConfigStore, ChatRuntimeConfig } from './chat-config-store';

type EmitChatEvent = (event: ChatStreamEvent) => void;
type ChatFetch = typeof fetch;

interface UsagePatch {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

const MAX_MESSAGE_COUNT = 100;
const MAX_MESSAGE_LENGTH = 200_000;
const MAX_TOTAL_MESSAGE_LENGTH = 1_000_000;
const MAX_RESPONSE_LENGTH = 2_000_000;
const MAX_TEST_RESPONSE_LENGTH = 64 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 15_000;

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

const requestHeaders = (config: ChatRuntimeConfig): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.authMode === 'apiKey' && config.credential) {
    headers['x-api-key'] = config.credential;
  } else if (config.authMode === 'bearer' && config.credential) {
    headers.authorization = `Bearer ${config.credential}`;
  }
  if (config.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
};

const requestBody = (
  config: ChatRuntimeConfig,
  messages: ChatMessage[],
  stream: boolean,
  includeUsage: boolean,
): Record<string, unknown> => {
  if (config.protocol === 'anthropic') {
    return {
      max_tokens: stream ? 4096 : 1,
      messages: messages.filter((message) => message.role !== 'system'),
      model: config.model,
      stream,
      system:
        messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n\n') || undefined,
    };
  }
  return {
    max_tokens: stream ? undefined : 1,
    messages,
    model: config.model,
    stream,
    stream_options: stream && includeUsage ? { include_usage: true } : undefined,
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

const streamDelta = (
  protocol: ChatProtocol,
  value: unknown,
): { done: boolean; text?: string; usage?: UsagePatch } => {
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
  const usage = usageFromPayload(protocol, value);
  if (protocol === 'anthropic') {
    if (record.type === 'message_stop') {
      return { done: true, usage };
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
      usage,
    };
  }

  const choices = record.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const delta =
    first && typeof first === 'object' ? (first as { delta?: unknown }).delta : undefined;
  return {
    // OpenAI-compatible streams send the usage-only chunk after the choice's finish_reason.
    // Keep reading until [DONE] or EOF so the final provider token counts are not discarded.
    done: false,
    text:
      delta &&
      typeof delta === 'object' &&
      typeof (delta as { content?: unknown }).content === 'string'
        ? (delta as { content: string }).content
        : undefined,
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
    this.validateRuntimeConfig(config);

    const controller = new AbortController();
    this.active.set(input.requestId, controller);
    this.emit({ requestId: input.requestId, type: 'start' });
    void this.run(input.requestId, messages, config, controller);
  }

  public async test(input: SaveChatConfigInput): Promise<ChatConnectionTestResult> {
    const config = this.store.resolveRuntimeConfig(input);
    this.validateRuntimeConfig(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(endpointFor(config.baseUrl, config.protocol), {
        body: JSON.stringify(requestBody(config, [{ content: '.', role: 'user' }], false, false)),
        headers: requestHeaders(config),
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw await responseError(response);
      }
      const raw = await readResponseText(response, MAX_TEST_RESPONSE_LENGTH);
      const value = JSON.parse(raw) as unknown;
      if (directResponseText(config.protocol, value) === undefined) {
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
    this.active.get(requestId)?.abort();
  }

  public shutdown(): void {
    for (const controller of this.active.values()) {
      controller.abort();
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

  private async run(
    requestId: string,
    messages: ChatMessage[],
    config: ChatRuntimeConfig,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const fetchStream = (includeUsage: boolean): Promise<Response> =>
        this.fetchImpl(endpointFor(config.baseUrl, config.protocol), {
          body: JSON.stringify(requestBody(config, messages, true, includeUsage)),
          headers: requestHeaders(config),
          method: 'POST',
          signal: controller.signal,
        });
      let response = await fetchStream(true);
      if (config.protocol === 'openai' && (response.status === 400 || response.status === 422)) {
        try {
          await response.body?.cancel();
        } catch {
          // The failed compatibility response may already be closed; the retry is still safe.
        }
        response = await fetchStream(false);
      }
      if (!response.ok) {
        throw await responseError(response);
      }

      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const raw = await readResponseText(response, MAX_RESPONSE_LENGTH);
        const value = JSON.parse(raw) as unknown;
        const text = directResponseText(config.protocol, value);
        if (!text) {
          throw new Error('接口响应中没有可显示的模型文本。');
        }
        this.emit({
          delta: text,
          requestId,
          type: 'delta',
          usage: mergeUsage(undefined, usageFromPayload(config.protocol, value)),
        });
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
      let providerUsage: ChatTokenUsage | undefined;
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
          providerUsage = mergeUsage(providerUsage, delta.usage);
          if (delta.text) {
            responseLength += delta.text.length;
            if (responseLength > MAX_RESPONSE_LENGTH) {
              throw new Error('模型响应超过安全长度限制，已停止接收。');
            }
            this.emit({
              delta: delta.text,
              requestId,
              type: 'delta',
              usage: providerUsage,
            });
          } else if (delta.usage) {
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
      this.emit({ requestId, type: 'done', usage: providerUsage });
    } catch (error) {
      this.emit({
        ...(controller.signal.aborted
          ? { type: 'aborted' as const }
          : {
              error: sanitizeError(error, config.credential, '独立对话请求失败。'),
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
