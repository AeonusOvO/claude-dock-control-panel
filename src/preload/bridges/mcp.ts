import { ipcRenderer } from 'electron';
import type {
  ControlPanelApi,
  McpCatalog,
  McpBackupView,
  McpOperationResult,
  McpTogglePreview,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const mcpBridge = {
  getMcpCatalog: (cwd, refreshRegistry) =>
    ipcRenderer.invoke(
      CHANNELS.MCP_GET_CATALOG,
      cwd,
      refreshRegistry ?? false,
    ) as Promise<McpCatalog>,
  installMcpServer: (input) =>
    ipcRenderer.invoke(CHANNELS.MCP_INSTALL, input) as Promise<McpOperationResult>,
  removeMcpServer: (input) =>
    ipcRenderer.invoke(CHANNELS.MCP_REMOVE, input) as Promise<McpOperationResult>,
  previewMcpToggle: (cwd, name, enabled) =>
    ipcRenderer.invoke(
      CHANNELS.MCP_TOGGLE_PREVIEW,
      cwd,
      name,
      enabled,
    ) as Promise<McpTogglePreview>,
  applyMcpToggle: (previewId, cwd) =>
    ipcRenderer.invoke(CHANNELS.MCP_TOGGLE_APPLY, previewId, cwd) as Promise<McpOperationResult>,
  discardMcpToggle: (previewId) =>
    ipcRenderer.invoke(CHANNELS.MCP_TOGGLE_DISCARD, previewId) as Promise<boolean>,
  getMcpBackups: () => ipcRenderer.invoke(CHANNELS.MCP_BACKUPS) as Promise<McpBackupView[]>,
  restoreMcpBackup: (backupId, cwd) =>
    ipcRenderer.invoke(CHANNELS.MCP_BACKUP_RESTORE, backupId, cwd) as Promise<McpOperationResult>,
} satisfies Partial<ControlPanelApi>;
