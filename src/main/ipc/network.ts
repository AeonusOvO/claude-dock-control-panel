import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import { resolveDirectory } from '../infra/directory';
import type { WorkspaceStore } from '../stores/workspace';
import { sameDirectory, type TerminalWorkspace } from '../terminal/workspace';
import { validateNetworkProvider, validateNetworkPreflightRunInput } from './validation';
import type { MainGuards } from './guards';

export interface NetworkIpcDependencies {
  guards: Pick<MainGuards, 'requireNetworkPreflightService' | 'validateSender'>;
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

const requireOwnedProjectDirectory = (
  candidate: string,
  workspace: TerminalWorkspace,
  workspaceStore: WorkspaceStore,
): string => {
  const resolved = resolveDirectory(candidate);
  const isOpen = workspace
    .getState()
    .sessions.some((session) => sameDirectory(session.cwd, resolved));
  const isRemembered = workspaceStore
    .getProjects()
    .some((project) => sameDirectory(project.path, resolved));
  if (!isOpen && !isRemembered) {
    throw new Error('网络预检只能使用已打开或已保存的项目目录。');
  }
  return resolved;
};

export const registerNetworkIpc = ({
  guards: { requireNetworkPreflightService, validateSender },
  workspace,
  workspaceStore,
}: NetworkIpcDependencies): void => {
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_GET, (event, provider: unknown) => {
    validateSender(event);
    return requireNetworkPreflightService().get(validateNetworkProvider(provider));
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_RUN, (event, value: unknown) => {
    validateSender(event);
    const input = validateNetworkPreflightRunInput(value);
    const cwd =
      input.cwd === undefined
        ? undefined
        : requireOwnedProjectDirectory(input.cwd, workspace, workspaceStore);
    return requireNetworkPreflightService().run(cwd === undefined ? input : { ...input, cwd });
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_INVALIDATE, (event, reason: unknown) => {
    validateSender(event);
    requireNetworkPreflightService().invalidate(
      typeof reason === 'string' ? reason.slice(0, 120) : 'renderer-request',
    );
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_GET_HISTORY, (event) => {
    validateSender(event);
    return requireNetworkPreflightService().getHistory();
  });
  ipcMain.handle(CHANNELS.NETWORK_PREFLIGHT_CLEAR_HISTORY, (event) => {
    validateSender(event);
    return requireNetworkPreflightService().clearHistory();
  });
};
