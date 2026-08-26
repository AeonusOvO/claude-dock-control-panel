import type {
  ClaudeNextConversationConnectionState,
  ClaudePreset,
  ManagedChatGptSetupProgress,
} from '../../../shared/contracts';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import type { ManagedChatGptOperationTracker } from './managed-chatgpt-operation';

export interface ChatGptSubscriptionGuideDeps {
  applyNextClaudeConnection: (state: ClaudeNextConversationConnectionState) => void;
  getNextClaudeConnection: () => ClaudeNextConversationConnectionState;
  managedChatGptOperations: ManagedChatGptOperationTracker;
  setRenderManagedChatGptProgress: (
    renderer: ((progress: ManagedChatGptSetupProgress) => void) | undefined,
  ) => void;
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  claudeConfigForm: HTMLFormElement;
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
