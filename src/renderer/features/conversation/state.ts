import { ComposerSubmitCoordinator } from '../../platform/composer-submit';
import type {
  ConversationInteraction,
  ConversationSnapshot,
  NativeAttachmentView,
  NativeRecoveryView,
} from '../../../shared/conversation/native';

/**
 * The composer owns exactly one action button. `data-action` decides whether it sends or stops,
 * `data-sending` marks the outgoing animation and `data-stopping` marks the halo that grows only
 * after the stop button has actually been pressed.
 */
export type NativeComposerAction = 'send' | 'stop';

/**
 * Committed-but-undelivered input, parked above the composer while a turn is still running. It is
 * deliberately renderer-only: the adapter hands prompts to an `AsyncInputQueue` that wakes a parked
 * consumer synchronously and exposes no dequeue hook, so the main process has no observable moment
 * where "the model started reading it" — a `queued` message status in the snapshot would be a lie.
 */
export interface NativeQueuedMessage {
  attachments: NativeAttachmentView[];
  text: string;
}

export interface ConversationState {
  activeNativeConversationId: string;
  expandedNativePlan: Extract<ConversationInteraction, { kind: 'plan' }> | undefined;
  lastNativeComposerHeight: number;
  lastNativeQueuedSignature: string;
  nativeAttachmentImporting: boolean;
  nativeControlsUpdating: boolean;
  /** Conversation UUID displayed over each workspace tab, mirroring the main process binding. */
  nativeConversationBySession: Map<string, string>;
  nativeConversationClosingTimer: number | undefined;
  nativeConversationRenderFrame: number | undefined;
  nativeConversationSnapshots: Map<string, ConversationSnapshot>;
  nativeConversationStartingSessionId: string | undefined;
  nativeConversationSubmissions: Map<string, string>;
  nativeMessageRenderKeys: WeakMap<HTMLElement, string>;
  nativePermissionModes: Map<string, string>;
  /** Conversations whose queued message should be delivered automatically once the turn goes idle. */
  nativeQueuedAutoFlush: Set<string>;
  /**
   * The queued entry currently in flight. It is held separately from `nativeQueuedMessages` so the
   * bar can keep showing "正在发送…" during the handover without the map entry being re-merged by a
   * failed delivery putting the same content back.
   */
  nativeQueuedDispatch: { conversationId: string; message: NativeQueuedMessage } | undefined;
  nativeQueuedMessages: Map<string, NativeQueuedMessage>;
  nativeRecoveries: NativeRecoveryView[];
  nativeSendAnimating: boolean;
  nativeSendAnimationTimer: number | undefined;
  nativeSubmits: ComposerSubmitCoordinator;
  pendingNativeAttachments: NativeAttachmentView[];
  pendingNativeConversationRenders: Map<string, ConversationSnapshot>;
}

export const createConversationState = (): ConversationState => ({
  activeNativeConversationId: '',
  expandedNativePlan: undefined,
  lastNativeComposerHeight: -1,
  lastNativeQueuedSignature: '\u0000',
  nativeAttachmentImporting: false,
  nativeControlsUpdating: false,
  nativeConversationBySession: new Map(),
  nativeConversationClosingTimer: undefined,
  nativeConversationRenderFrame: undefined,
  nativeConversationSnapshots: new Map(),
  nativeConversationStartingSessionId: undefined,
  nativeConversationSubmissions: new Map(),
  nativeMessageRenderKeys: new WeakMap(),
  nativePermissionModes: new Map(),
  nativeQueuedAutoFlush: new Set(),
  nativeQueuedDispatch: undefined,
  nativeQueuedMessages: new Map(),
  nativeRecoveries: [],
  nativeSendAnimating: false,
  nativeSendAnimationTimer: undefined,
  nativeSubmits: new ComposerSubmitCoordinator(),
  pendingNativeAttachments: [],
  pendingNativeConversationRenders: new Map(),
});
