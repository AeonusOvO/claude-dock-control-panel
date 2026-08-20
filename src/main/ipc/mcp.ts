import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  McpBackupView,
  McpCatalog,
  McpOperationResult,
  McpTogglePreview,
} from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import { validateMcpInstallInput, validateMcpRemoveInput, validateProjectPath } from './validation';
import type { MainGuards } from './guards';

export interface McpIpcDependencies {
  guards: Pick<
    MainGuards,
    'assertExternalRoutingWritesAllowed' | 'requireMcpManager' | 'validateSender'
  >;
}

const reportMcpFailure = createFailureReporter('mcp');

export const registerMcpIpc = ({
  guards: { assertExternalRoutingWritesAllowed, requireMcpManager, validateSender },
}: McpIpcDependencies): void => {
  /* Every mutation reports the catalog it produced, so the renderer never has to re-fetch to see it. */
  const runMcpMutation = async (
    cwd: string,
    operation: () => Promise<string>,
  ): Promise<McpOperationResult> => {
    try {
      assertExternalRoutingWritesAllowed();
      const message = await operation();
      return { catalog: await requireMcpManager().getCatalog(cwd, true), message, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP 操作失败。';
      return {
        ...reportMcpFailure('external-service', message, error),
        catalog: await requireMcpManager().getCatalog(cwd, true),
        error: message,
        ok: false,
      };
    }
  };
  ipcMain.handle(
    CHANNELS.MCP_GET_CATALOG,
    async (event, cwd: unknown, refresh: unknown): Promise<McpCatalog> => {
      validateSender(event);
      return requireMcpManager().getCatalog(validateProjectPath(cwd), refresh === true);
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_INSTALL,
    async (event, rawInput: unknown): Promise<McpOperationResult> => {
      validateSender(event);
      const input = validateMcpInstallInput(rawInput);
      return runMcpMutation(input.cwd, () => requireMcpManager().install(input));
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_REMOVE,
    async (event, rawInput: unknown): Promise<McpOperationResult> => {
      validateSender(event);
      const input = validateMcpRemoveInput(rawInput);
      return runMcpMutation(input.cwd, () => requireMcpManager().remove(input));
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_TOGGLE_PREVIEW,
    async (event, cwd: unknown, name: unknown, enabled: unknown): Promise<McpTogglePreview> => {
      validateSender(event);
      if (typeof name !== 'string' || typeof enabled !== 'boolean') {
        throw new Error('MCP 启停参数无效。');
      }
      return requireMcpManager().previewToggle(validateProjectPath(cwd), name, enabled);
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_TOGGLE_APPLY,
    async (event, previewId: unknown, cwd: unknown): Promise<McpOperationResult> => {
      validateSender(event);
      if (typeof previewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(previewId)) {
        throw new Error('MCP 改动预览标识无效。');
      }
      const validatedCwd = validateProjectPath(cwd);
      return runMcpMutation(validatedCwd, () => requireMcpManager().applyToggle(previewId));
    },
  );
  ipcMain.handle(CHANNELS.MCP_BACKUPS, (event): McpBackupView[] => {
    validateSender(event);
    return requireMcpManager().listBackups();
  });
  ipcMain.handle(
    CHANNELS.MCP_BACKUP_RESTORE,
    async (event, backupId: unknown, cwd: unknown): Promise<McpOperationResult> => {
      validateSender(event);
      if (typeof backupId !== 'string') throw new Error('MCP 备份标识无效。');
      const validatedCwd = validateProjectPath(cwd);
      return runMcpMutation(validatedCwd, () =>
        requireMcpManager().restoreBackup(backupId, validatedCwd),
      );
    },
  );
};
