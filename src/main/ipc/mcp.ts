import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  McpBackupView,
  McpCatalog,
  McpOperationResult,
  McpTogglePreview,
} from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import { validateProjectPath } from './validation';
import { parseIpcRequestArgs } from '../../shared/ipc/schema';
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
    async (event, ...args: unknown[]): Promise<McpCatalog> => {
      validateSender(event);
      const [cwd, refreshRegistry] = parseIpcRequestArgs(CHANNELS.MCP_GET_CATALOG, args);
      return requireMcpManager().getCatalog(validateProjectPath(cwd), refreshRegistry);
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_INSTALL,
    async (event, ...args: unknown[]): Promise<McpOperationResult> => {
      validateSender(event);
      const [parsedInput] = parseIpcRequestArgs(CHANNELS.MCP_INSTALL, args);
      const input = { ...parsedInput, cwd: validateProjectPath(parsedInput.cwd) };
      return runMcpMutation(input.cwd, () => requireMcpManager().install(input));
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_REMOVE,
    async (event, ...args: unknown[]): Promise<McpOperationResult> => {
      validateSender(event);
      const [parsedInput] = parseIpcRequestArgs(CHANNELS.MCP_REMOVE, args);
      const input = { ...parsedInput, cwd: validateProjectPath(parsedInput.cwd) };
      return runMcpMutation(input.cwd, () => requireMcpManager().remove(input));
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_TOGGLE_PREVIEW,
    async (event, ...args: unknown[]): Promise<McpTogglePreview> => {
      validateSender(event);
      const [cwd, name, enabled] = parseIpcRequestArgs(CHANNELS.MCP_TOGGLE_PREVIEW, args);
      return requireMcpManager().previewToggle(validateProjectPath(cwd), name, enabled);
    },
  );
  ipcMain.handle(
    CHANNELS.MCP_TOGGLE_APPLY,
    async (event, ...args: unknown[]): Promise<McpOperationResult> => {
      validateSender(event);
      const [previewId, cwd] = parseIpcRequestArgs(CHANNELS.MCP_TOGGLE_APPLY, args);
      const validatedCwd = validateProjectPath(cwd);
      return runMcpMutation(validatedCwd, () =>
        requireMcpManager().applyToggle(previewId, validatedCwd),
      );
    },
  );
  ipcMain.handle(CHANNELS.MCP_TOGGLE_DISCARD, (event, ...args: unknown[]): boolean => {
    validateSender(event);
    const [previewId] = parseIpcRequestArgs(CHANNELS.MCP_TOGGLE_DISCARD, args);
    return requireMcpManager().discardToggle(previewId);
  });
  ipcMain.handle(CHANNELS.MCP_BACKUPS, (event): McpBackupView[] => {
    validateSender(event);
    return requireMcpManager().listBackups();
  });
  ipcMain.handle(
    CHANNELS.MCP_BACKUP_RESTORE,
    async (event, ...args: unknown[]): Promise<McpOperationResult> => {
      validateSender(event);
      const [backupId, cwd] = parseIpcRequestArgs(CHANNELS.MCP_BACKUP_RESTORE, args);
      const validatedCwd = validateProjectPath(cwd);
      return runMcpMutation(validatedCwd, () =>
        requireMcpManager().restoreBackup(backupId, validatedCwd),
      );
    },
  );
};
