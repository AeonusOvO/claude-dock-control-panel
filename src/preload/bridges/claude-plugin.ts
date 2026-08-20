import { ipcRenderer } from 'electron';
import type {
  ControlPanelApi,
  ClaudePluginCatalog,
  ClaudePluginOperationResult,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const claudePluginBridge = {
  getClaudePlugins: (refresh) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_GET,
      refresh ?? false,
    ) as Promise<ClaudePluginCatalog>,
  installClaudePlugin: (pluginId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_INSTALL,
      pluginId,
    ) as Promise<ClaudePluginOperationResult>,
  uninstallClaudePlugin: (pluginId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_UNINSTALL,
      pluginId,
    ) as Promise<ClaudePluginOperationResult>,
  setClaudePluginEnabled: (pluginId, enabled) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_SET_ENABLED,
      pluginId,
      enabled,
    ) as Promise<ClaudePluginOperationResult>,
  updateClaudePlugin: (pluginId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_UPDATE,
      pluginId,
    ) as Promise<ClaudePluginOperationResult>,
  addClaudePluginMarketplace: (source) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_ADD,
      source,
    ) as Promise<ClaudePluginOperationResult>,
  removeClaudePluginMarketplace: (name) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_REMOVE,
      name,
    ) as Promise<ClaudePluginOperationResult>,
  refreshClaudePluginMarketplaces: () =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_REFRESH,
    ) as Promise<ClaudePluginOperationResult>,
  updateAllClaudePlugins: () =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_PLUGINS_UPDATE_ALL) as Promise<ClaudePluginOperationResult>,
} satisfies Partial<ControlPanelApi>;
