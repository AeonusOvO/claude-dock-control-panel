import { ipcRenderer } from 'electron';
import type { ControlPanelApi } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';
import { parseClaudeExecutionSettingsDto } from '../../shared/ipc/schema';

export const claudeExecutionSettingsBridge = {
  getClaudeExecutionSettings: () =>
    ipcRenderer
      .invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_GET)
      .then(parseClaudeExecutionSettingsDto),
  updateClaudeExecutionSettings: (requested) =>
    ipcRenderer
      .invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, requested)
      .then(parseClaudeExecutionSettingsDto),
  useRecommendedClaudeExecutionSettings: () =>
    ipcRenderer
      .invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED)
      .then(parseClaudeExecutionSettingsDto),
  restoreClaudeExecutionSettingsDefault: () =>
    ipcRenderer
      .invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT)
      .then(parseClaudeExecutionSettingsDto),
} satisfies Partial<ControlPanelApi>;
