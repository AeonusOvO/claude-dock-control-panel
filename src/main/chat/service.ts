import type {
  ChatConnectionTestResult,
  ChatPreflightResult,
  ChatStartInput,
  SaveChatConfigInput,
} from '../../shared/contracts';
import type { ChatConfigStore, ChatRuntimeConfig } from './config-store';
import type { ChatAttachmentStore } from './attachment-store';
import {
  ChatRequestRunner,
  type ActiveChatRequest,
  type ChatFetch,
  type ChatServiceTimeouts,
  type EmitChatEvent,
} from './request-runner';
export type { ChatServiceTimeouts } from './request-runner';
import { preflightChatRequest } from './protocol';
export {
  directChatResponse,
  endpointFor,
  parseChatStreamDelta,
  preflightChatRequest,
  requestHeaders,
  serializeChatRequestBody,
  validateChatRequest,
} from './protocol';
export type { ChatRequestBodyOptions, ParsedChatStreamDelta } from './protocol';

export class ChatService extends ChatRequestRunner {
  public constructor(
    private readonly store: ChatConfigStore,
    emit: EmitChatEvent,
    fetchImpl: ChatFetch = fetch,
    attachmentStore?: ChatAttachmentStore,
    timeouts: ChatServiceTimeouts = {},
    readHardIdleTimeoutMs: () => number = () => 0,
  ) {
    super(emit, fetchImpl, attachmentStore, timeouts, readHardIdleTimeoutMs);
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
    return this.probeRuntimeConfig(config);
  }

  private validateRuntimeConfig(config: ChatRuntimeConfig): void {
    if (!config.model) {
      throw new Error('请先在“对话”选项卡中配置模型。');
    }
    if (config.authMode !== 'none' && !config.credential) {
      throw new Error('请先为独立对话配置接口凭据。');
    }
  }
}
