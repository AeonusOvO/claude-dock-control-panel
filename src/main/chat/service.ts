import type {
  ChatConnectionTestResult,
  ChatPreflightResult,
  ChatStartInput,
  SaveChatConfigInput,
} from '../../shared/contracts';
import {
  normalizeChatBaseUrl,
  type ChatConfigStore,
  type ChatRuntimeConfig,
  type ChatRuntimeSnapshot,
} from './config-store';
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

export interface StartedChatRequest {
  accepted: ChatPreflightResult;
  completion: Promise<void>;
}

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

  public captureRuntimeSnapshot(): ChatRuntimeSnapshot {
    return this.freezeRuntime(this.store.getRuntimeConfig());
  }

  public captureTestRuntimeSnapshot(input: SaveChatConfigInput): ChatRuntimeSnapshot {
    return this.freezeRuntime(this.store.resolveRuntimeConfig(input));
  }

  public start(
    input: ChatStartInput,
    runtime: ChatRuntimeSnapshot,
    onAccepted?: (prepared: ChatPreflightResult) => void,
  ): ChatPreflightResult {
    return this.startWithCompletion(input, runtime, onAccepted).accepted;
  }

  public startWithCompletion(
    input: ChatStartInput,
    runtime: ChatRuntimeSnapshot,
    onAccepted?: (prepared: ChatPreflightResult) => void,
  ): StartedChatRequest {
    const prepared = this.preflight(input);
    if (this.active.has(input.requestId)) {
      throw new Error('该对话请求已在运行。');
    }
    this.validateRuntimeConfig(runtime);
    onAccepted?.(prepared);

    const active: ActiveChatRequest = { controller: new AbortController() };
    this.active.set(input.requestId, active);
    this.emit({ requestId: input.requestId, type: 'start' });
    const completion = new Promise<void>((resolve) => {
      setImmediate(() => {
        // Request failures are emitted by `run`; either settlement must release infrastructure leases.
        void this.run(input.requestId, prepared.messages, runtime, active).then(resolve, resolve);
      });
    });
    return { accepted: prepared, completion };
  }

  public async test(input: SaveChatConfigInput): Promise<ChatConnectionTestResult> {
    return this.testRuntime(this.captureTestRuntimeSnapshot(input));
  }

  public async testRuntime(runtime: ChatRuntimeSnapshot): Promise<ChatConnectionTestResult> {
    this.validateRuntimeConfig(runtime);
    return this.probeRuntimeConfig(runtime);
  }

  private freezeRuntime(runtime: ChatRuntimeConfig): ChatRuntimeSnapshot {
    this.validateRuntimeConfig(runtime);
    return Object.freeze({ ...runtime });
  }

  private validateRuntimeConfig(config: ChatRuntimeConfig): void {
    normalizeChatBaseUrl(config.baseUrl);
    if (!config.model) {
      throw new Error('请先在“对话”选项卡中配置模型。');
    }
    if (config.authMode !== 'none' && !config.credential) {
      throw new Error('请先为独立对话配置接口凭据。');
    }
  }
}
