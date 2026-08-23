import { ipcMain } from 'electron';
import type { ClaudeExecutionSettingsView } from '../../shared/contracts/claude-execution-settings';
import { CHANNELS } from '../../shared/ipc/channels';
import { parseClaudeExecutionSettingsDto, parseIpcRequestArgs } from '../../shared/ipc/schema';
import { toClaudeExecutionSettingsDto } from '../claude/execution-settings-dto';
import type { MainGuards } from './guards';

export interface ClaudeExecutionSettingsIpcDependencies {
  guards: Pick<MainGuards, 'requireClaudeExecutionSettingsService' | 'validateSender'>;
}

export const registerClaudeExecutionSettingsIpc = ({
  guards: { requireClaudeExecutionSettingsService, validateSender },
}: ClaudeExecutionSettingsIpcDependencies): void => {
  const project = async (operation: () => Promise<ClaudeExecutionSettingsView>) =>
    parseClaudeExecutionSettingsDto(toClaudeExecutionSettingsDto(await operation()));

  ipcMain.handle(CHANNELS.CLAUDE_EXECUTION_SETTINGS_GET, (event, ...args: unknown[]) => {
    validateSender(event);
    parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_GET, args);
    return project(() => requireClaudeExecutionSettingsService().get());
  });

  ipcMain.handle(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, (event, ...args: unknown[]) => {
    validateSender(event);
    const [requested] = parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, args);
    return project(() => requireClaudeExecutionSettingsService().update(requested));
  });

  ipcMain.handle(
    CHANNELS.CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED,
    (event, ...args: unknown[]) => {
      validateSender(event);
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED, args);
      return project(() => requireClaudeExecutionSettingsService().useRecommended());
    },
  );

  ipcMain.handle(
    CHANNELS.CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT,
    (event, ...args: unknown[]) => {
      validateSender(event);
      parseIpcRequestArgs(CHANNELS.CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT, args);
      return project(() => requireClaudeExecutionSettingsService().resetToClaudeDefault());
    },
  );
};
