import type { SubscriptionProvider } from '../claude/subscriptions';
import type { ClaudeNextConversationConnectionState } from './claude';

/** Deliberately excludes tokens, authorization URLs and local proxy credentials. */
export interface SubscriptionState {
  revision: number;
  attempt?: string;
  provider?: SubscriptionProvider;
  phase: 'idle' | 'preparing' | 'authorizing' | 'testing' | 'complete' | 'error';
  busy: boolean;
  cancellable: boolean;
  message: string;
  userCode?: string;
}

export interface SubscriptionResult {
  ok: boolean;
  message: string;
  state: SubscriptionState;
  nextConnection?: ClaudeNextConversationConnectionState;
}
