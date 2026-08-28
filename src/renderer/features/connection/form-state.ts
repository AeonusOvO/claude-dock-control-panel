import type {
  ClaudeNextConversationConnectionState,
  ManagedChatGptSetupProgress,
  SubscriptionState,
} from '../../../shared/contracts';
import type { ClaudeProviderGroupId, ClaudeProviderId } from '../../../shared/claude/providers';
import { ManagedChatGptOperationTracker } from './managed-chatgpt-operation';

export interface ConnectionFormState {
  advancedSettings: boolean;
  selectedProviderId: ClaudeProviderId | undefined;
  selectedRouterProviderId: string | undefined;
  configFormSessionId: string;
  connectionEnvironmentReady: boolean;
  collapsedProviderGroups: Set<ClaudeProviderGroupId>;
  managedChatGptOperations: ManagedChatGptOperationTracker;
  managedChatGptProgress: ManagedChatGptSetupProgress | undefined;
  subscription: SubscriptionState | undefined;
  subscriptionPending: boolean;
  startSubscription: (() => void) | undefined;
  cancelSubscription: (() => Promise<boolean>) | undefined;
  renderSubscription: (() => void) | undefined;
  nextConnection: ClaudeNextConversationConnectionState;
  nextConnectionRevision: number;
  renderWizard: (() => void) | undefined;
  connectionSucceeded: (() => void) | undefined;
  renderManagedChatGptProgress: ((progress: ManagedChatGptSetupProgress) => void) | undefined;
  wizardStep: 'choice' | 'configure';
}

export const createConnectionFormState = (): ConnectionFormState => ({
  advancedSettings: false,
  selectedProviderId: undefined,
  selectedRouterProviderId: undefined,
  configFormSessionId: '',
  connectionEnvironmentReady: false,
  collapsedProviderGroups: new Set(),
  managedChatGptOperations: new ManagedChatGptOperationTracker(),
  managedChatGptProgress: undefined,
  subscription: undefined,
  subscriptionPending: false,
  startSubscription: undefined,
  cancelSubscription: undefined,
  renderSubscription: undefined,
  nextConnection: {},
  nextConnectionRevision: 0,
  renderWizard: undefined,
  connectionSucceeded: undefined,
  renderManagedChatGptProgress: undefined,
  wizardStep: 'choice',
});
