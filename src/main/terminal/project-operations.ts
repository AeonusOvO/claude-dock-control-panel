import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import type {
  DirectoryChoiceResult,
  WorkspaceResult,
  WorkspaceState,
} from '../../shared/contracts';
import type { ProjectDirectoryLifecycleCoordinator } from '../coordination/project-directory-lifecycle';
import { resolveDirectory } from '../infra/directory';
import { directoryDialogDefaultPath, directoryDialogError } from '../infra/directory-picker';
import { createFailureReporter } from '../infra/logger';
import type { WorkspaceStore } from '../stores/workspace';
import type { DescribeWorkspace, TerminalWorkspace } from './workspace';

export interface ProjectOperationDependencies {
  describeWorkspace: DescribeWorkspace;
  /* Fallback for the folder dialog and the ceiling the picker will not walk above. */
  homeDirectory: string;
  projectDirectoryLifecycle: ProjectDirectoryLifecycleCoordinator;
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

/** The folder-level operations shared by the tray menu and the project IPC handlers. */
export interface ProjectOperations {
  activateProject: (sessionId: string) => WorkspaceState;
  addProject: (directoryPath: string) => WorkspaceResult;
  chooseDirectory: (ownerWindow?: BrowserWindow) => Promise<DirectoryChoiceResult>;
  failedWorkspaceResult: (error: unknown) => WorkspaceResult;
}

const reportWorkspaceFailure = createFailureReporter('workspace');

export const createProjectOperations = ({
  describeWorkspace,
  homeDirectory,
  projectDirectoryLifecycle,
  workspace,
  workspaceStore,
}: ProjectOperationDependencies): ProjectOperations => {
  const chooseDirectory = async (ownerWindow?: BrowserWindow): Promise<DirectoryChoiceResult> => {
    const defaultPath = directoryDialogDefaultPath(
      workspace.getActiveStatus()?.cwd ?? homeDirectory,
      homeDirectory,
    );
    const options: Electron.OpenDialogOptions = {
      buttonLabel: '添加此项目',
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory'],
      title: '添加项目文件夹',
    };
    let result: Electron.OpenDialogReturnValue;
    try {
      result =
        ownerWindow && !ownerWindow.isDestroyed()
          ? await dialog.showOpenDialog(ownerWindow, options)
          : await dialog.showOpenDialog(options);
    } catch (ownedDialogError) {
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return { canceled: true, error: directoryDialogError(ownedDialogError) };
      }
      try {
        // A stale Windows owner handle can reject the native dialog. Retry once without a parent.
        result = await dialog.showOpenDialog(options);
      } catch (unownedDialogError) {
        return { canceled: true, error: directoryDialogError(unownedDialogError) };
      }
    }

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    try {
      return {
        canceled: false,
        path: resolveDirectory(result.filePaths[0]),
      };
    } catch (error) {
      return {
        canceled: true,
        error: error instanceof Error ? error.message : '所选文件夹无法访问。',
      };
    }
  };

  const failedWorkspaceResult = (error: unknown): WorkspaceResult => {
    const message = error instanceof Error ? error.message : '项目操作失败。';
    return {
      ...reportWorkspaceFailure('environment', message, error),
      error: message,
      ok: false,
      state: describeWorkspace(),
    };
  };

  const addProject = (directoryPath: string): WorkspaceResult => {
    try {
      const resolved = resolveDirectory(directoryPath);
      return projectDirectoryLifecycle.runOpenSync(resolved, (ownership) => {
        ownership.assertCurrent();
        const result = workspace.openProject(resolved);

        // Save to persistent workspace only while this open still owns the folder lifecycle.
        ownership.assertCurrent();
        workspaceStore.addProject(resolved);

        return {
          ok: true,
          reused: result.reused,
          state: describeWorkspace(result.state),
        };
      });
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  };

  const activateProject = (sessionId: string): WorkspaceState => {
    const state = workspace.activate(sessionId);
    const active = state.sessions.find((session) => session.id === state.activeSessionId);
    if (active) {
      workspaceStore.updateLastActive(active.cwd);
    }
    return describeWorkspace(state);
  };

  return { activateProject, addProject, chooseDirectory, failedWorkspaceResult };
};
