import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ProjectDirectoryLifecycleCoordinator } from '../../src/main/coordination/project-directory-lifecycle';
import { WorkspaceStore } from '../../src/main/stores/workspace';
import { createProjectOperations } from '../../src/main/terminal/project-operations';
import { TerminalWorkspace } from '../../src/main/terminal/workspace';
import { createDescribeWorkspace } from '../../src/main/terminal/workspace-view';

vi.mock('electron', () => ({ dialog: {} }));
it('remembers and publishes a folder before a Claude connection exists without starting a terminal', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-first-project-'));
  try {
    const onState = vi.fn();
    const createTerminal = vi.fn(() => {
      throw new Error('unexpected terminal');
    });
    const workspace = new TerminalWorkspace(vi.fn(), onState, createTerminal);
    const workspaceStore = new WorkspaceStore(root);
    const operations = createProjectOperations({
      workspace,
      workspaceStore,
      describeWorkspace: createDescribeWorkspace({ workspace, workspaceStore }),
      hasNextClaudeConnection: () => false,
      homeDirectory: root,
      projectDirectoryLifecycle: new ProjectDirectoryLifecycleCoordinator(),
    });
    for (let i = 0; i < 2; i++) {
      expect(operations.addProject(root)).toMatchObject({
        ok: true,
        needsClaudeConnection: true,
        state: { projects: [{ path: root, remembered: true, open: false }], sessions: [] },
      });
    }
    expect(new WorkspaceStore(root).getProjects()).toHaveLength(1);
    expect(onState).toHaveBeenCalledTimes(2);
    expect(createTerminal).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
