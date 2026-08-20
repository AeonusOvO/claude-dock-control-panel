import type { ClaudeProviderId } from '../../shared/claude/providers';
import type { ClaudeProjectState } from '../../shared/contracts';

export interface RailShellDeps {
  claudeStates: Map<string, ClaudeProjectState>;
  connectionAdvancedDialog: HTMLDialogElement;
  getActiveSessionId: () => string;
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  setProviderGroupExpansionPending: (value: boolean) => void;
  applyDefaultProviderGroupExpansion: (providerId?: ClaudeProviderId) => void;
  renderProviderPicker: () => void;
  loadChatConfig: (force?: boolean) => Promise<void>;
  loadChatHistory: () => Promise<void>;
  renderChatUsage: () => void;
  focusInputAfterNavigation: () => void;
  loadPluginsCatalog: () => void;
  loadMcpCatalog: () => void;
  setConnectionPolling: (enabled: boolean) => void;
  getSettingsSelectedTab: () => string;
  getPanelResizer: () => HTMLElement;
  retryTerminalFitUntilMeasured: () => void;
}
