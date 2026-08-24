// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus, WorkspaceState } from '../../src/shared/contracts';
import { createProjectsWorkspaceActions } from '../../src/renderer/features/projects/actions-workspace';
import type {
  ProjectsActionsDependencies,
  ProjectsRowsApi,
} from '../../src/renderer/features/projects/actions-dependencies';
import type { ProjectsElements } from '../../src/renderer/features/projects/elements';
import { createProjectsState } from '../../src/renderer/features/projects/state';
import type { WorkspaceRenderer } from '../../src/renderer/features/projects/workspace';
import { ClaudeLaunchAttemptRegistry } from '../../src/renderer/platform/claude-launch-attempt';

/*
 * These rows are rebuilt by every workspace re-render, so the button a user pressed is replaced by an
 * enabled one while the first request is still in flight — which is why the guard is keyed on the
 * target rather than on the element, and why it is worth a test. Opening a conversation is the case
 * that actually costs something: each accepted call spawns a real PTY in the main process.
 */

const workspaceState: WorkspaceState = {
  activeSessionId: 'session-1',
  projects: [],
  sessions: [
    {
      cwd: 'D:\\work\\repo',
      id: 'session-1',
      phase: 'running',
      ptyGeneration: 1,
      shell: 'powershell.exe',
      title: '对话',
    },
  ],
};

/** A deferred main-process reply, so a second click can be made to land mid-flight. */
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const setup = (): {
  actions: ReturnType<typeof createProjectsWorkspaceActions>;
  dependencies: ProjectsActionsDependencies;
} => {
  const dependencies = {
    beginClaudeLaunchAttempt: vi.fn(() => ({ generation: 1, sessionId: 'session-1' })),
    claudeLaunchAttempts: new ClaudeLaunchAttemptRegistry(),
    failClaudeLaunchAttempt: vi.fn(() => true),
    getWorkspaceState: () => workspaceState,
    hideTerminalContextMenu: vi.fn(),
    projectNameFromPath: (directoryPath: string) => directoryPath,
    refreshClaudeLaunchControls: vi.fn(),
    requestComposerFocus: vi.fn(),
    requestConfirmation: vi.fn(async () => true),
    resolveClaudeLaunchDecision: vi.fn(async () => ({ status: 'cancelled' as const })),
    renderClaudeLaunchResult: vi.fn(() => true),
    resultFailureMessage: (_result: unknown, fallback: string) => fallback,
    retryTerminalFitUntilMeasured: vi.fn(),
    setNativePanelVisible: vi.fn(),
    showToast: vi.fn(),
  } satisfies ProjectsActionsDependencies;

  const actions = createProjectsWorkspaceActions(
    {} as ProjectsElements,
    createProjectsState(),
    dependencies,
    { renderWorkspace: vi.fn() } as unknown as WorkspaceRenderer,
    { loadFolderHistory: vi.fn(async () => undefined) } as ProjectsRowsApi,
  );

  return { actions, dependencies };
};

beforeEach(() => {
  Reflect.deleteProperty(window, 'controlPanel');
});

describe('projects workspace actions', () => {
  it('spawns one conversation per double click, not two', async () => {
    const pending = deferred<{ ok: true; state: WorkspaceState }>();
    const openConversation = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { openConversation },
    });

    const { actions } = setup();
    // Both clicks land before the main process answers, exactly as an impatient double click does.
    const first = actions.openConversation('D:\\work\\repo');
    const second = actions.openConversation('D:\\work\\repo');
    pending.resolve({ ok: true, state: workspaceState });
    await Promise.all([first, second]);

    expect(openConversation).toHaveBeenCalledTimes(1);
  });

  it('releases the guard so a later click still works', async () => {
    const openConversation = vi.fn(async () => ({ ok: true, state: workspaceState }));
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { openConversation },
    });

    const { actions } = setup();
    await actions.openConversation('D:\\work\\repo');
    await actions.openConversation('D:\\work\\repo');

    expect(openConversation).toHaveBeenCalledTimes(2);
  });

  it('guards each project independently', async () => {
    const pending = deferred<{ ok: true; state: WorkspaceState }>();
    const openConversation = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { openConversation },
    });

    const { actions } = setup();
    const first = actions.openConversation('D:\\work\\one');
    const second = actions.openConversation('D:\\work\\two');
    pending.resolve({ ok: true, state: workspaceState });
    await Promise.all([first, second]);

    expect(openConversation).toHaveBeenCalledTimes(2);
  });

  it('does not stack a second confirmation while a close is being confirmed', async () => {
    const closeProject = vi.fn(async () => ({ ok: true, state: workspaceState }));
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { closeProject },
    });

    const confirmation = deferred<boolean>();
    const { actions, dependencies } = setup();
    const requestConfirmation = vi.mocked(dependencies.requestConfirmation);
    requestConfirmation.mockImplementation(() => confirmation.promise);

    const status = {
      cwd: 'D:\\work\\repo',
      id: 'session-1',
      phase: 'running',
      title: '对话',
    } as unknown as TerminalStatus;

    const first = actions.closeProject(status);
    const second = actions.closeProject(status);
    confirmation.resolve(true);
    await Promise.all([first, second]);

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(closeProject).toHaveBeenCalledTimes(1);
  });
});
