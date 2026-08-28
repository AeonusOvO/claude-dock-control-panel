import type {
  ChatAttachmentView,
  ChatConfigView,
  ChatConversationSummary,
  ChatMessage,
  ChatTokenUsage,
} from '../../../shared/contracts';
import { estimateChatUsage } from '../../../shared/conversation/chat-usage';
import type { MarkdownStreamRenderer } from '../../platform/markdown';

/*
 * Chat history titles get the same typewriter treatment as project conversations: the old name is
 * erased character by character and the new one typed in behind a blinking caret. The state lives
 * outside the DOM because the history list is rebuilt from scratch on every reload — each rebuild
 * re-reads the current frame, and each timer tick patches the live element between rebuilds.
 */
export interface ChatTitleAnimationState {
  chars: string[];
  keep: number;
  phase: 'erasing' | 'typing';
  target: string[];
  timer: number;
}

export const CHAT_TITLE_ERASE_MS = 24;
export const CHAT_TITLE_TYPE_MS = 44;
export const CHAT_TITLE_PHASE_PAUSE_MS = 200;

/** Clipboard payloads have no path on disk, so a name has to be synthesized from the MIME type. */
export const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/tab-separated-values': '.tsv',
};

export interface ChatState {
  chatConfigLoadGeneration: number;
  activeChatAttachmentDraftId: string | undefined;
  activeChatConversationId: string | undefined;
  activeChatIdleNoticeElement: HTMLElement | undefined;
  activeChatProviderUsage: ChatTokenUsage | undefined;
  activeChatReply: string;
  activeChatReplyElement: HTMLElement | undefined;
  activeChatReplyStream: MarkdownStreamRenderer | undefined;
  activeChatRequestId: string;
  activeChatRequestMessages: ChatMessage[];
  activeChatThinking: string;
  activeChatThinkingElement: HTMLElement | undefined;
  activeChatUsage: ChatTokenUsage;
  chatAttachmentImportQueue: Promise<void>;
  chatConfig: ChatConfigView | undefined;
  chatConfigLoadPromise: Promise<void> | undefined;
  chatConversations: ChatConversationSummary[];
  chatMessages: ChatMessage[];
  chatSubmissionInFlight: boolean;
  chatTitleAnimations: Map<string, ChatTitleAnimationState>;
  conversationBusyLeaseActive: boolean;
  pendingChatAttachments: ChatAttachmentView[];
  queuedChatAttachmentImports: number;
}

export const createChatState = (): ChatState => ({
  chatConfigLoadGeneration: 0,
  activeChatAttachmentDraftId: undefined,
  activeChatConversationId: undefined,
  activeChatIdleNoticeElement: undefined,
  activeChatProviderUsage: undefined,
  activeChatReply: '',
  activeChatReplyElement: undefined,
  activeChatReplyStream: undefined,
  activeChatRequestId: '',
  activeChatRequestMessages: [],
  activeChatThinking: '',
  activeChatThinkingElement: undefined,
  activeChatUsage: estimateChatUsage([]),
  chatAttachmentImportQueue: Promise.resolve(),
  chatConfig: undefined,
  chatConfigLoadPromise: undefined,
  chatConversations: [],
  chatMessages: [],
  chatSubmissionInFlight: false,
  chatTitleAnimations: new Map(),
  conversationBusyLeaseActive: false,
  pendingChatAttachments: [],
  queuedChatAttachmentImports: 0,
});
