import type {
  ChatConnectionTestResult,
  ChatMessage,
  ChatRetryReason,
  ChatStreamEvent,
  ChatTokenUsage,
} from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import type { ChatAttachmentStore } from './attachment-store';
import type { ChatRuntimeConfig } from './config-store';
import {
  ChatStreamProviderError,
  directChatResponse,
  endpointFor,
  materializeLocalAttachments,
  mergeUsage,
  parseChatStreamDelta,
  requestHeaders,
  serializeChatRequestBody,
  STREAM_MAX_TOKENS_FALLBACK,
  usageFromPayload,
  validateChatRequest,
  type ParsedChatStreamDelta,
} from './protocol';

export type EmitChatEvent = (event: ChatStreamEvent) => void;
export type ChatFetch = typeof fetch;

export interface ActiveChatRequest {
  abortReason?: 'local-timeout' | 'manual';
  controller: AbortController;
}

export interface ChatServiceTimeouts {
  idleRepeatMs?: number;
  idleTimeoutMs?: number;
  maxTransientRetries?: number;
  probeTimeoutMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

const MAX_RESPONSE_LENGTH = 2_000_000;
const MAX_TEST_RESPONSE_LENGTH = 64 * 1024;
const IDLE_PROBE_REPEAT_MS = 60_000;
const REQUEST_IDLE_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRY_AFTER_MAX_DELAY_MS = 60_000;
const MAX_CHAT_REDIRECTS = 3;
const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const REDIRECT_HTTP_STATUSES = new Set([301, 302, 303, 307, 308]);
const reportChatFailure = createFailureReporter('chat');

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

interface ChatIdleMonitor {
  clear: () => void;
  touch: () => void;
}

interface ChatStreamAttempt {
  includeUsage: boolean;
  maxTokens?: number;
  thinking: boolean;
}

interface ChatRetryDiagnostic {
  retryAfterMs?: number;
  status?: number;
}

interface ChatResilientFetch {
  attempts: ChatStreamAttempt[];
  fetch: (attempt: ChatStreamAttempt) => Promise<Response>;
  retry: (
    retryReason: ChatRetryReason,
    detail: string,
    diagnostic?: ChatRetryDiagnostic,
  ) => Promise<boolean>;
  retryCount: () => number;
}

interface ChatSelectedResponse {
  attempt: ChatStreamAttempt;
  response: Response;
}

interface ChatStreamState {
  doneEvent: boolean;
  emittedOutput: boolean;
  providerUsage?: ChatTokenUsage;
  responseLength: number;
  stopReason?: string;
}

export abstract class ChatRequestRunner {
  protected readonly active = new Map<string, ActiveChatRequest>();
  private readonly idleRepeatMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxTransientRetries: number;
  private readonly probeTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  protected constructor(
    protected readonly emit: EmitChatEvent,
    private readonly fetchImpl: ChatFetch = fetch,
    protected readonly attachmentStore?: ChatAttachmentStore,
    timeouts: ChatServiceTimeouts = {},
    private readonly readHardIdleTimeoutMs: () => number = () => 0,
  ) {
    this.idleRepeatMs = timeouts.idleRepeatMs ?? IDLE_PROBE_REPEAT_MS;
    this.idleTimeoutMs = timeouts.idleTimeoutMs ?? REQUEST_IDLE_TIMEOUT_MS;
    this.maxTransientRetries = timeouts.maxTransientRetries ?? MAX_TRANSIENT_RETRIES;
    this.probeTimeoutMs = timeouts.probeTimeoutMs ?? TEST_TIMEOUT_MS;
    this.retryBaseDelayMs = timeouts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = timeouts.retryMaxDelayMs ?? RETRY_MAX_DELAY_MS;
    if (
      !Number.isFinite(this.idleRepeatMs) ||
      this.idleRepeatMs <= 0 ||
      !Number.isFinite(this.idleTimeoutMs) ||
      this.idleTimeoutMs <= 0 ||
      !Number.isInteger(this.maxTransientRetries) ||
      this.maxTransientRetries < 0 ||
      !Number.isFinite(this.probeTimeoutMs) ||
      this.probeTimeoutMs <= 0 ||
      !Number.isFinite(this.retryBaseDelayMs) ||
      this.retryBaseDelayMs <= 0 ||
      !Number.isFinite(this.retryMaxDelayMs) ||
      this.retryMaxDelayMs < this.retryBaseDelayMs
    ) {
      throw new Error('对话超时配置无效。');
    }
  }

  protected async probeRuntimeConfig(config: ChatRuntimeConfig): Promise<ChatConnectionTestResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.probeTimeoutMs);
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
      if (!direct.recognized) {
        throw new Error('接口响应格式与所选协议不一致。');
      }
      return {
        detail:
          direct.text === undefined && direct.refusal === undefined
            ? '连接成功；接口返回了有效协议结构，最小响应没有可见文本。'
            : '连接成功，接口、认证与模型响应均可用。',
        latencyMs: Date.now() - startedAt,
        ok: true,
        usage: mergeUsage(undefined, usageFromPayload(config.protocol, value)),
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const detail = aborted
        ? '连接测试超时，请检查接口地址与网络。'
        : sanitizeError(error, config.credential, '连接测试失败。');
      return {
        ...reportChatFailure('external-service', detail, error),
        detail,
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

  private async fetchWithRedirectPolicy(url: string, init: RequestInit): Promise<Response> {
    let currentUrl = new URL(url);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await this.fetchImpl(currentUrl.toString(), {
        ...init,
        // Node's built-in fetch uses Undici, whose connector enables TCP keepalive. Keep the
        // request persistence hint explicit on every initial request and accepted redirect hop.
        keepalive: true,
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

  private createIdleMonitor(
    requestId: string,
    config: ChatRuntimeConfig,
    active: ActiveChatRequest,
  ): ChatIdleMonitor {
    const { controller } = active;
    const configuredHardIdleTimeoutMs = this.readHardIdleTimeoutMs();
    const hardIdleTimeoutMs =
      Number.isFinite(configuredHardIdleTimeoutMs) && configuredHardIdleTimeoutMs > 0
        ? configuredHardIdleTimeoutMs
        : 0;
    const idleNoticeThresholdMs = hardIdleTimeoutMs || this.idleTimeoutMs;
    let idleTimeout: NodeJS.Timeout | undefined;
    let activityGeneration = 0;
    let idleNoticeEmitted = false;
    let lastActivityAt = Date.now();
    let probeInFlight = false;
    const scheduleIdleThreshold = (delayMs: number): void => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        void onIdleThreshold();
      }, delayMs);
    };
    const onIdleThreshold = async (): Promise<void> => {
      if (controller.signal.aborted || this.active.get(requestId) !== active) {
        return;
      }
      const generation = activityGeneration;
      const idleMs = Math.max(idleNoticeThresholdMs, Date.now() - lastActivityAt);
      if (hardIdleTimeoutMs > 0 && idleNoticeEmitted && idleMs >= hardIdleTimeoutMs * 2) {
        active.abortReason = 'local-timeout';
        controller.abort('local-timeout');
        return;
      }
      idleNoticeEmitted = true;
      this.emit({
        idleMs,
        probe: { detail: '正在旁路探测当前接口。' },
        requestId,
        type: 'idle',
      });
      if (!probeInFlight) {
        probeInFlight = true;
        try {
          const result = await this.probeRuntimeConfig(config);
          if (
            !controller.signal.aborted &&
            this.active.get(requestId) === active &&
            activityGeneration === generation
          ) {
            this.emit({
              idleMs: Math.max(idleNoticeThresholdMs, Date.now() - lastActivityAt),
              probe: { detail: result.detail, ok: result.ok },
              requestId,
              type: 'idle',
            });
          }
        } finally {
          probeInFlight = false;
        }
      }
      if (
        !controller.signal.aborted &&
        this.active.get(requestId) === active &&
        activityGeneration === generation
      ) {
        scheduleIdleThreshold(this.idleRepeatMs);
      }
    };
    const touch = (): void => {
      activityGeneration += 1;
      idleNoticeEmitted = false;
      lastActivityAt = Date.now();
      scheduleIdleThreshold(idleNoticeThresholdMs);
    };
    return {
      clear: () => {
        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }
      },
      touch,
    };
  }

  private createResilientFetch(
    requestId: string,
    messages: ChatMessage[],
    config: ChatRuntimeConfig,
    controller: AbortController,
    touchIdleTimeout: () => void,
  ): ChatResilientFetch {
    const endpoint = endpointFor(config.baseUrl, config.protocol);
    const fetchStream = (attempt: ChatStreamAttempt): Promise<Response> =>
      this.fetchWithRedirectPolicy(endpoint, {
        body: JSON.stringify(
          serializeChatRequestBody(config, messages, {
            includeUsage: attempt.includeUsage,
            maxTokens: attempt.maxTokens,
            stream: true,
            thinking: attempt.thinking,
          }),
        ),
        headers: requestHeaders(config, messages),
        method: 'POST',
        signal: controller.signal,
      });
    // Descend a compatibility ladder on 400/422: full request first, then drop the feature a
    // strict gateway is most likely rejecting (adaptive thinking / stream usage), then lower the
    // generation ceiling for gateways that cap max_tokens below our default.
    const attempts: ChatStreamAttempt[] =
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
    const retry = async (
      retryReason: ChatRetryReason,
      detail: string,
      diagnostic: ChatRetryDiagnostic = {},
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
    const fetchResilient = async (attempt: ChatStreamAttempt): Promise<Response> => {
      while (true) {
        let response: Response;
        try {
          response = await fetchStream(attempt);
        } catch (error) {
          if (controller.signal.aborted || error instanceof ChatRedirectError) {
            throw error;
          }
          const retrying = await retry('network', '网络连接失败，正在重新连接。');
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
        await retry('http-status', `接口暂时返回 HTTP ${status}，正在自动重试。`, {
          retryAfterMs: retryAfter,
          status,
        });
      }
    };
    return {
      attempts,
      fetch: fetchResilient,
      retry,
      retryCount: () => transientRetries,
    };
  }

  private async selectCompatibleResponse(
    resilientFetch: ChatResilientFetch,
  ): Promise<ChatSelectedResponse> {
    let attempt = resilientFetch.attempts[0]!;
    let response = await resilientFetch.fetch(attempt);
    for (
      let compatibilityIndex = 1;
      compatibilityIndex < resilientFetch.attempts.length;
      compatibilityIndex += 1
    ) {
      if (response.status !== 400 && response.status !== 422) {
        break;
      }
      await discardResponse(response);
      attempt = resilientFetch.attempts[compatibilityIndex]!;
      response = await resilientFetch.fetch(attempt);
    }
    return { attempt, response };
  }

  private async consumeDirectResponse(
    response: Response,
    requestId: string,
    config: ChatRuntimeConfig,
  ): Promise<void> {
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
      throw new ChatProtocolError('接口返回了非 SSE、非 JSON 的响应，请检查协议与最终接口地址。');
    }
    const direct = directChatResponse(config.protocol, value);
    if (!direct.text && !direct.refusal) {
      throw new ChatProtocolError('接口响应中没有可显示的模型文本。');
    }
    const usage = mergeUsage(undefined, usageFromPayload(config.protocol, value));
    if (direct.text) {
      this.emit({ delta: direct.text, requestId, type: 'delta', usage });
    }
    if (direct.refusal) {
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
  }

  private async applyStreamDelta(
    requestId: string,
    delta: ParsedChatStreamDelta,
    state: ChatStreamState,
    streamReader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    state.providerUsage = mergeUsage(state.providerUsage, delta.usage);
    state.stopReason = delta.stopReason ?? state.stopReason;
    for (const value of [delta.text, delta.thinking, delta.inputJson, delta.refusal]) {
      state.responseLength += value?.length ?? 0;
    }
    if (state.responseLength > MAX_RESPONSE_LENGTH) {
      await streamReader.cancel();
      throw new ChatProtocolError('模型响应超过安全长度限制，已停止接收。');
    }
    if (delta.text) {
      state.emittedOutput = true;
      this.emit({
        delta: delta.text,
        requestId,
        type: 'delta',
        usage: state.providerUsage,
      });
    }
    if (delta.thinking) {
      state.emittedOutput = true;
      this.emit({ delta: delta.thinking, requestId, type: 'thinking' });
    }
    if (delta.inputJson) {
      state.emittedOutput = true;
      this.emit({ delta: delta.inputJson, requestId, type: 'input-json' });
    }
    if (delta.refusal) {
      state.emittedOutput = true;
      this.emit({
        delta: delta.refusal,
        refusal: delta.refusal,
        requestId,
        stopReason: delta.stopReason ?? 'refusal',
        type: 'refusal',
      });
    }
    if (!delta.text && !delta.thinking && !delta.inputJson && !delta.refusal && delta.usage) {
      this.emit({ requestId, type: 'start', usage: state.providerUsage });
    }
    if (delta.done) {
      state.doneEvent = true;
    }
  }

  private async consumeEventStream(
    response: Response,
    requestId: string,
    config: ChatRuntimeConfig,
    touchIdleTimeout: () => void,
  ): Promise<void> {
    if (!response.body) {
      throw new IncompleteChatStreamError('接口未返回可读取的响应流。', false);
    }
    const streamReader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ChatStreamState = {
      doneEvent: false,
      emittedOutput: false,
      responseLength: 0,
    };
    let buffer = '';
    try {
      while (!state.doneEvent) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await streamReader.read();
        } catch {
          throw new IncompleteChatStreamError(
            state.emittedOutput
              ? '响应流在生成过程中断开；已保留收到的部分回答。'
              : '响应流在首个有效内容到达前断开。',
            state.emittedOutput,
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
            state.doneEvent = true;
            break;
          }
          let delta: ParsedChatStreamDelta;
          try {
            delta = parseChatStreamDelta(config.protocol, JSON.parse(data));
          } catch (error) {
            if (error instanceof ChatStreamProviderError && error.retryable) {
              throw new IncompleteChatStreamError(error.message, state.emittedOutput);
            }
            throw error;
          }
          await this.applyStreamDelta(requestId, delta, state, streamReader);
          if (state.doneEvent) {
            break;
          }
        }
        if (chunk.done) {
          break;
        }
      }
      if (!state.doneEvent) {
        throw new IncompleteChatStreamError(
          state.emittedOutput
            ? '响应流在结束标记前断开；已保留收到的部分回答。'
            : '响应流结束但没有返回协议结束标记。',
          state.emittedOutput,
        );
      }
    } catch (error) {
      try {
        await streamReader.cancel();
      } catch {
        // A broken provider stream may reject cancellation after the read failure.
      }
      throw error;
    }
    try {
      await streamReader.cancel();
    } catch {
      // A completed provider stream may already have closed its body.
    }
    this.emit({
      requestId,
      stopReason: state.stopReason,
      type: 'done',
      usage: state.providerUsage,
    });
  }

  private async consumeProviderResponse(
    selected: ChatSelectedResponse,
    resilientFetch: ChatResilientFetch,
    requestId: string,
    config: ChatRuntimeConfig,
    controller: AbortController,
    touchIdleTimeout: () => void,
  ): Promise<void> {
    let { response } = selected;
    while (true) {
      if (!response.ok) {
        const error = await responseError(response);
        if (TRANSIENT_HTTP_STATUSES.has(response.status) && resilientFetch.retryCount() > 0) {
          throw new Error(`${error.message}（已自动重试 ${resilientFetch.retryCount()} 次）`);
        }
        throw error;
      }
      try {
        if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
          await this.consumeEventStream(response, requestId, config, touchIdleTimeout);
        } else {
          await this.consumeDirectResponse(response, requestId, config);
        }
        return;
      } catch (error) {
        if (
          !controller.signal.aborted &&
          error instanceof IncompleteChatStreamError &&
          !error.emittedOutput &&
          (await resilientFetch.retry('stream-incomplete', '响应尚未开始便已断开，正在重新请求。'))
        ) {
          response = await resilientFetch.fetch(selected.attempt);
          continue;
        }
        throw error;
      }
    }
  }

  private async executeRequest(
    requestId: string,
    messages: ChatMessage[],
    config: ChatRuntimeConfig,
    controller: AbortController,
    touchIdleTimeout: () => void,
  ): Promise<void> {
    const providerMessages = await materializeLocalAttachments(messages, this.attachmentStore);
    if (controller.signal.aborted) {
      throw new Error('对话请求已停止。');
    }
    const resilientFetch = this.createResilientFetch(
      requestId,
      providerMessages,
      config,
      controller,
      touchIdleTimeout,
    );
    const selected = await this.selectCompatibleResponse(resilientFetch);
    await this.consumeProviderResponse(
      selected,
      resilientFetch,
      requestId,
      config,
      controller,
      touchIdleTimeout,
    );
  }

  protected async run(
    requestId: string,
    messages: ChatMessage[],
    config: ChatRuntimeConfig,
    active: ActiveChatRequest,
  ): Promise<void> {
    const { controller } = active;
    const idleMonitor = this.createIdleMonitor(requestId, config, active);
    idleMonitor.touch();
    try {
      await this.executeRequest(requestId, messages, config, controller, idleMonitor.touch);
    } catch (error) {
      this.emit({
        ...(controller.signal.aborted
          ? {
              abortReason: active.abortReason ?? 'manual',
              type: 'aborted' as const,
            }
          : {
              continuable:
                error instanceof IncompleteChatStreamError && error.emittedOutput
                  ? true
                  : undefined,
              error: sanitizeError(error, config.credential, '独立对话请求失败。'),
              type: 'error' as const,
            }),
        requestId,
      });
    } finally {
      idleMonitor.clear();
      if (this.active.get(requestId) === active) {
        this.active.delete(requestId);
      }
    }
  }
}
