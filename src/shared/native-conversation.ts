export type ConversationRuntime = 'claude' | 'codex';
export type ConversationOwnerKind = 'native' | 'terminal';
export type ConversationRole = 'assistant' | 'system' | 'user';
export type ConversationPhase =
  'starting' | 'idle' | 'running' | 'requires-action' | 'stopping' | 'stopped' | 'failed';

export interface ConversationAttachmentInput {
  id: string;
  mediaType: string;
  name: string;
  /** Main-process-only resolved path. Renderer IPC values never get to choose this path. */
  path?: string;
  size: number;
}

export interface NativeAttachmentView {
  attachmentId: string;
  fileName: string;
  height: number;
  mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  previewDataUrl?: string;
  sizeBytes: number;
  width: number;
}

export interface NativeAttachmentImportResult {
  attachments: NativeAttachmentView[];
  message?: string;
  ok: boolean;
}

export interface NativeAttachmentBytesInput {
  bytes: ArrayBuffer;
  fileName: string;
}

export type ConversationInputBlock =
  { type: 'text'; text: string } | { type: 'image'; attachment: ConversationAttachmentInput };

export type ConversationContentBlock =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'image'; mediaType: string; name: string; source: string }
  | {
      id: string;
      type: 'tool';
      name: string;
      input: unknown;
      parentToolUseId?: string;
      status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
      output?: unknown;
      summary?: string;
    };

export interface ConversationMessageView {
  blocks: ConversationContentBlock[];
  createdAt: number;
  id: string;
  parentToolUseId?: string;
  role: ConversationRole;
  status: 'streaming' | 'complete' | 'aborted' | 'failed';
}

export interface ConversationTaskView {
  cancellable: boolean;
  description: string;
  id: string;
  kind: 'subagent' | 'background' | 'web' | 'workflow';
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'lost';
  summary?: string;
  updatedAt: number;
}

export interface ConversationUsageView {
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  timeToFirstTokenMs?: number;
}

export interface ConversationCommandView {
  aliases: string[];
  argumentHint?: string;
  description: string;
  mapping: 'adapter' | 'claudedock' | 'form' | 'terminal-only' | 'unknown';
  name: string;
}

export interface ModelCapabilityProfile {
  attachments: { image: boolean; reason?: string };
  evidence: 'runtime' | 'verified-catalog' | 'isolated-probe' | 'unknown';
  effort: {
    applied?: string;
    options: string[];
    requested?: string;
    supportsUltraWorkflow: boolean;
  };
  fast: {
    mechanism?: string;
    state: 'unavailable' | 'off' | 'requested' | 'confirmed' | 'fallback';
  };
  model: string;
  models?: Array<{
    attachments: { image: boolean; reason?: string };
    effortOptions: string[];
    id: string;
    label: string;
    supportsFast: boolean;
    supportsUltraWorkflow: boolean;
  }>;
  permissionModes: string[];
  profileKey: string;
  revision: number;
  runtime: ConversationRuntime;
  verifiedAt?: number;
}

export type ConversationInteraction =
  | {
      id: string;
      kind: 'permission';
      createdAt: number;
      title: string;
      description?: string;
      toolName: string;
      toolUseId: string;
      input: unknown;
      allowRemember: boolean;
    }
  | {
      id: string;
      kind: 'question';
      createdAt: number;
      title: string;
      questions: unknown[];
    }
  | {
      id: string;
      kind: 'plan';
      createdAt: number;
      title: string;
      markdown: string;
      approvalModes: string[];
    }
  | {
      id: string;
      kind: 'mcp';
      createdAt: number;
      title: string;
      description?: string;
      mode: 'form' | 'url';
      schema?: Record<string, unknown>;
      url?: string;
    };

export interface ConversationSnapshot {
  capabilities?: ModelCapabilityProfile;
  commands: ConversationCommandView[];
  conversationId: string;
  error?: string;
  interactions: ConversationInteraction[];
  messages: ConversationMessageView[];
  ownerKind: ConversationOwnerKind;
  phase: ConversationPhase;
  projectPath: string;
  revision: number;
  runtime: ConversationRuntime;
  sequence: number;
  tasks: ConversationTaskView[];
  usage: ConversationUsageView;
}

interface ConversationEventBase {
  conversationId: string;
  emittedAt: number;
  projectPath: string;
  revision: number;
  runtime: ConversationRuntime;
  sequence: number;
}

export type ConversationEvent =
  | (ConversationEventBase & {
      type: 'conversation.started';
      ownerKind: ConversationOwnerKind;
    })
  | (ConversationEventBase & {
      type: 'conversation.phase';
      phase: ConversationPhase;
    })
  | (ConversationEventBase & {
      type: 'message.upsert';
      message: ConversationMessageView;
    })
  | (ConversationEventBase & {
      type: 'message.delta';
      messageId: string;
      blockId: string;
      blockType: 'text' | 'thinking';
      delta: string;
    })
  | (ConversationEventBase & {
      type: 'tool.updated';
      messageId: string;
      block: Extract<ConversationContentBlock, { type: 'tool' }>;
    })
  | (ConversationEventBase & {
      type: 'interaction.requested';
      interaction: ConversationInteraction;
    })
  | (ConversationEventBase & {
      type: 'interaction.resolved';
      interactionId: string;
    })
  | (ConversationEventBase & {
      type: 'tasks.reconciled';
      tasks: ConversationTaskView[];
    })
  | (ConversationEventBase & {
      type: 'usage.updated';
      usage: ConversationUsageView;
    })
  | (ConversationEventBase & {
      type: 'submission.transcript-confirmed';
      clientSubmissionId: string;
    })
  | (ConversationEventBase & {
      type: 'capabilities.updated';
      capabilities: ModelCapabilityProfile;
    })
  | (ConversationEventBase & {
      type: 'commands.updated';
      commands: ConversationCommandView[];
    })
  | (ConversationEventBase & {
      type: 'conversation.error';
      message: string;
    });

export interface ConversationStartInput {
  allowBypassPermissions?: boolean;
  cliVersion?: string;
  conversationId: string;
  endpointIdentity?: string;
  model?: string;
  ownerKind: ConversationOwnerKind;
  permissionMode?: string;
  projectPath: string;
  resume: boolean;
}

export interface ConversationControlUpdate {
  effort?: string;
  expectedCapabilityRevision: number;
  fast?: boolean;
  model?: string;
  permissionMode?: string;
}

export interface ConversationSubmitInput {
  blocks: ConversationInputBlock[];
  clientSubmissionId: string;
}

export interface NativeConversationStartResult {
  conversationId: string;
  existingOwnerKind?: ConversationOwnerKind;
  message?: string;
  ok: boolean;
  reused: boolean;
  snapshot?: ConversationSnapshot;
}

export interface NativeConversationOperationResult {
  message?: string;
  ok: boolean;
  snapshot?: ConversationSnapshot;
}

export interface NativeConversationTerminalTransferResult extends NativeConversationOperationResult {
  terminalSessionId?: string;
}

export interface NativeConversationDraftResult extends NativeConversationOperationResult {
  draft?: ConversationSubmitInput;
}

export interface NativeConversationLaunchRequest {
  conversationId?: string;
  model?: string;
  permissionMode?: string;
  projectPath: string;
  resume?: boolean;
}

export interface NativeRecoverySubmissionView {
  clientSubmissionId: string;
  createdAt: number;
  promptDigest: string;
  sequence: number;
  state: string;
  updatedAt: number;
}

export interface NativeRecoveryView {
  clean: boolean;
  conversationId: string;
  launch: {
    capabilityRevision?: number;
    configFingerprint: string;
    effort?: string;
    endpointIdentity?: string;
    model?: string;
    permissionMode?: string;
    speed?: string;
  };
  ownerKind: ConversationOwnerKind;
  projectPath: string;
  runtime: ConversationRuntime;
  submissions: NativeRecoverySubmissionView[];
  updatedAt: number;
}

export type ConversationInteractionResponse =
  | { action: 'allow'; remember?: boolean; values?: Record<string, unknown> }
  | { action: 'deny'; message?: string }
  | { action: 'cancel' }
  | { action: 'submit'; values: Record<string, unknown> };

export interface ConversationAdapter {
  close(conversationId: string): Promise<void>;
  interrupt(conversationId: string): Promise<void>;
  listCommands(conversationId: string): Promise<ConversationCommandView[]>;
  respond(
    conversationId: string,
    interactionId: string,
    response: ConversationInteractionResponse,
  ): Promise<void>;
  start(input: ConversationStartInput): Promise<void>;
  stopTask(conversationId: string, taskId: string): Promise<void>;
  submit(conversationId: string, input: ConversationSubmitInput): Promise<void>;
  subscribe(listener: (event: ConversationEvent) => void): () => void;
  updateControls(conversationId: string, update: ConversationControlUpdate): Promise<void>;
}
