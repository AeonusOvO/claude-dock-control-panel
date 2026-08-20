import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  TerminalWorkspaceState,
  WorkspaceProjectView,
  WorkspaceState,
} from '../../shared/contracts';
import type { WorkspaceStore } from '../stores/workspace';
import { sameDirectory, type DescribeWorkspace, type TerminalWorkspace } from './workspace';

export interface WorkspaceViewDependencies {
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

/**
 * Merges the live terminal sessions with the folders remembered on disk. A folder stays in the
 * list after its last conversation is closed — closing a tab must never mean forgetting a project.
 */
export const createDescribeWorkspace = ({
  workspace,
  workspaceStore,
}: WorkspaceViewDependencies): DescribeWorkspace =>
  function describeWorkspace(state: TerminalWorkspaceState = workspace.getState()): WorkspaceState {
    const projects: WorkspaceProjectView[] = [];
    const indexOfPath = (candidate: string): number =>
      projects.findIndex((project) => sameDirectory(project.path, candidate));

    for (const session of state.sessions) {
      const existing = projects[indexOfPath(session.cwd)];
      if (existing) {
        existing.sessionIds.push(session.id);
      } else {
        projects.push({
          missing: false,
          name: path.basename(session.cwd) || session.cwd,
          open: true,
          path: session.cwd,
          remembered: false,
          sessionIds: [session.id],
        });
      }
    }

    for (const stored of workspaceStore.getProjects()) {
      const index = indexOfPath(stored.path);
      if (index >= 0) {
        const project = projects[index];
        if (project) {
          project.lastActiveAt = stored.lastActiveAt;
          project.remembered = true;
        }
        continue;
      }
      projects.push({
        lastActiveAt: stored.lastActiveAt,
        missing: !existsSync(stored.path),
        name: path.basename(stored.path) || stored.path,
        open: false,
        path: stored.path,
        remembered: true,
        sessionIds: [],
      });
    }

    projects.sort((left, right) => {
      if (left.open !== right.open) {
        return left.open ? -1 : 1;
      }
      return (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0);
    });

    return { ...state, projects };
  };
