import type { FailureMetadata } from '../diagnostics/failure';
import type { ClaudeCredentialAction } from './claude';

export type ChatProtocol = 'anthropic' | 'openai' | 'openai-responses';

export type ChatAuthMode = 'apiKey' | 'bearer' | 'none';

export type ChatIdleTimeoutMinutes = 0 | 5 | 10 | 30;

export type ChatMessageRole = 'assistant' | 'system' | 'user';

export type ChatStreamEventType =
  | 'aborted'
  | 'delta'
  | 'done'
  | 'error'
  | 'idle'
  | 'input-json'
  | 'refusal'
  | 'retrying'
  | 'start'
  | 'thinking';

export type ChatRetryReason = 'http-status' | 'network' | 'stream-incomplete';

export type ChatTokenUsageSource = 'estimated' | 'provider';

export interface ChatConfigView {
  authMode: ChatAuthMode;
  baseUrl: string;
  credentialConfigured: boolean;
  model: string;
  protocol: ChatProtocol;
  preset?: string;
}

export interface SaveChatConfigInput {
  autoDetect?: boolean;
  authMode: ChatAuthMode;
  baseUrl: string;
  credential?: string;
  credentialAction: ClaudeCredentialAction;
  model: string;
  protocol: ChatProtocol;
  preset?: string;
}

export type ChatAttachmentSource =
  | { attachmentId: string; type: 'local' }
  | { data: string; type: 'base64' }
  | { fileId: string; type: 'file' };

export type ChatContentBlock =
  | { text: string; type: 'text' }
  | {
      fileName?: string;
      mediaType: string;
      source: ChatAttachmentSource;
      type: 'document' | 'image';
    };

export interface ChatMessage {
  /**
   * Strings are accepted only as the 1.x compatibility/input path. Main-process validation
   * normalizes every newly persisted or transmitted message to content blocks.
   */
  content: ChatContentBlock[] | string;
  role: ChatMessageRole;
}

export interface ChatAttachmentView {
  attachmentId: string;
  fileName: string;
  mediaType: string;
  /** Small renderer-safe image preview. Full attachment bytes never cross IPC. */
  previewDataUrl?: string;
  sizeBytes: number;
  type: 'document' | 'image';
}

export interface ChatAttachmentImportError {
  message: string;
  path: string;
}

export interface ChatAttachmentImportResult extends FailureMetadata {
  attachments: ChatAttachmentView[];
  draftId?: string;
  errors: ChatAttachmentImportError[];
  ok: boolean;
}

export interface ChatAttachmentImportInput {
  draftId?: string;
  paths: string[];
}

/** One clipboard payload. Pasted images arrive as bytes with no path on disk. */
export interface ChatAttachmentBytesInput {
  bytes: ArrayBuffer;
  fileName: string;
}

export interface ChatAttachmentBytesImportInput {
  draftId?: string;
  sources: ChatAttachmentBytesInput[];
}

export interface ChatTokenUsage {
  inputTokens: number;
  outputTokens: number;
  source: ChatTokenUsageSource;
  totalTokens: number;
}

export interface ChatStartInput {
  draftId?: string;
  messages: ChatMessage[];
  requestId: string;
}

export interface ChatPreflightResult {
  messages: ChatMessage[];
  removedAttachmentIds: string[];
  warning?: string;
}

export interface ChatStreamEvent {
  abortReason?: 'local-timeout' | 'manual';
  attempt?: number;
  continuable?: boolean;
  delta?: string;
  detail?: string;
  error?: string;
  idleMs?: number;
  maxAttempts?: number;
  probe?: ChatIdleProbeResult;
  refusal?: string;
  requestId: string;
  retryAfterMs?: number;
  retryReason?: ChatRetryReason;
  stopReason?: string;
  status?: number;
  type: ChatStreamEventType;
  usage?: ChatTokenUsage;
}

export interface ChatIdleProbeResult extends FailureMetadata {
  detail: string;
  ok?: boolean;
}

export interface ChatConversationSummary {
  createdAt: number;
  id: string;
  messageCount: number;
  title: string;
  /** True once the user renamed the conversation, which stops the derived title from overwriting it. */
  titleCustom?: boolean;
  updatedAt: number;
  usage: ChatTokenUsage;
}

export interface ChatConversation extends ChatConversationSummary {
  messages: ChatMessage[];
}

export interface SaveChatConversationInput {
  conversationId?: string;
  messages: ChatMessage[];
  usage: ChatTokenUsage;
}

export interface ChatConnectionTestResult extends FailureMetadata {
  detail: string;
  latencyMs: number;
  ok: boolean;
  usage?: ChatTokenUsage;
}
