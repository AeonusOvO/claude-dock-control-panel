import type {
  ConversationCommandView,
  ConversationContentBlock,
  ConversationEvent,
  ConversationInteractionResponse,
  ConversationStartInput,
  ConversationTaskView,
} from '../../shared/conversation/native';
import type { AsyncInputQueue, SdkQuery } from './agent-adapter-bootstrap';

export type AgentEventBody<T = ConversationEvent> = T extends ConversationEvent
  ? Omit<T, 'conversationId' | 'emittedAt' | 'projectPath' | 'revision' | 'runtime' | 'sequence'>
  : never;

export interface PendingInteraction {
  abort: () => void;
  complete: (response: ConversationInteractionResponse) => void;
}

export interface ToolLocation {
  block: Extract<ConversationContentBlock, { type: 'tool' }>;
  messageId: string;
}

export interface AgentSession {
  allowQuestionInteraction: boolean;
  assistantStreamSequence: number;
  assistantStreams: Map<string, string>;
  capabilityRevision: number;
  commands: ConversationCommandView[];
  effort?: string;
  fast: boolean;
  input: ConversationStartInput;
  initialization: Record<string, unknown>;
  interactions: Map<string, PendingInteraction>;
  model?: string;
  models: Record<string, unknown>[];
  permissionMode: string;
  query: SdkQuery;
  queue: AsyncInputQueue;
  revision: number;
  runtimeModel?: string;
  sequence: number;
  tasks: Map<string, ConversationTaskView>;
  tools: Map<string, ToolLocation>;
}

/**
 * The stream mappers need to publish events without owning the listener set, and the sequence and
 * revision stamps only exist on the adapter, so emission is handed to them as a callback.
 */
export type AgentEventEmit = (session: AgentSession, event: AgentEventBody) => void;
