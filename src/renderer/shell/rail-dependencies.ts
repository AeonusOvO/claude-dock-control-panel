import type { ClaudeProviderId } from '../../shared/claude/providers';

export interface RailShellDeps {
  connectionAdvancedDialog: HTMLDialogElement;
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  setProviderGroupExpansionPending: (value: boolean) => void;
  applyDefaultProviderGroupExpansion: (providerId?: ClaudeProviderId) => void;
  renderProviderPicker: () => void;
  loadNextClaudeConnection: () => Promise<unknown>;
  showConnectionChoice: () => void;
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
