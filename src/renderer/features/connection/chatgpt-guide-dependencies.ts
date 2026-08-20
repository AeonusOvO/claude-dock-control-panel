import type {
  ClaudePreset,
  ClaudeProjectState,
  ManagedChatGptSetupProgress,
} from '../../../shared/contracts';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import type { ManagedChatGptOperationTracker } from './managed-chatgpt-operation';

export interface ChatGptSubscriptionGuideDeps {
  getActiveSessionId: () => string;
  claudeStates: Map<string, ClaudeProjectState>;
  managedChatGptOperations: ManagedChatGptOperationTracker;
  setRenderManagedChatGptProgress: (
    renderer: ((progress: ManagedChatGptSetupProgress) => void) | undefined,
  ) => void;
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  claudeConfigForm: HTMLFormElement;
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void;
  renderClaudeState: (state: ClaudeProjectState) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
