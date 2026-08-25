import type { ManagedChatGptSetupProgress } from '../../../shared/contracts';
import type { ClaudeProviderGroupId, ClaudeProviderId } from '../../../shared/claude/providers';
import { ManagedChatGptOperationTracker } from './managed-chatgpt-operation';

export interface ConnectionFormState {
  selectedProviderId: ClaudeProviderId | undefined;
  selectedRouterProviderId: string | undefined;
  configFormSessionId: string;
  connectionEnvironmentReady: boolean;
  collapsedProviderGroups: Set<ClaudeProviderGroupId>;
  managedChatGptOperations: ManagedChatGptOperationTracker;
  managedChatGptProgress: ManagedChatGptSetupProgress | undefined;
  renderWizard: (() => void) | undefined;
  renderManagedChatGptProgress: ((progress: ManagedChatGptSetupProgress) => void) | undefined;
  wizardStep: 'choice' | 'configure';
}

export const createConnectionFormState = (): ConnectionFormState => ({
  selectedProviderId: undefined,
  selectedRouterProviderId: undefined,
  configFormSessionId: '',
  connectionEnvironmentReady: false,
  collapsedProviderGroups: new Set(),
  managedChatGptOperations: new ManagedChatGptOperationTracker(),
  managedChatGptProgress: undefined,
  renderWizard: undefined,
  renderManagedChatGptProgress: undefined,
  wizardStep: 'choice',
});
