// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus, WorkspaceResult, WorkspaceState } from '../../src/shared/contracts';
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
 * enabled one while the first request is still in flight. Every accepted click must now own a real
 * PTY instead of being coalesced by folder, including clicks made before the first reply settles.
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
  rowsApi: ProjectsRowsApi;
  state: ReturnType<typeof createProjectsState>;
  workspaceRenderer: WorkspaceRenderer;
} => {
  const dependencies = {
    beginTerminalMask: vi.fn(() => () => undefined),
    beginWorkspaceTerminalPreview: vi.fn(() => () => undefined),
    beginClaudeLaunchAttempt: vi.fn(() => ({ generation: 1, sessionId: 'session-1' })),
    claudeLaunchAttempts: new ClaudeLaunchAttemptRegistry(),
    failClaudeLaunchAttempt: vi.fn(() => true),
    getWorkspaceState: () => workspaceState,
    hideTerminalContextMenu: vi.fn(),
    launchCreatedConversation: vi.fn(async () => true),
    projectNameFromPath: (directoryPath: string) => directoryPath,
    refreshClaudeLaunchControls: vi.fn(),
    setClaudeLaunchPresentationPhase: vi.fn(() => true),
    requestComposerFocus: vi.fn(),
    requestConfirmation: vi.fn(async () => true),
    resolveClaudeLaunchDecision: vi.fn(async () => ({ status: 'cancelled' as const })),
    renderClaudeLaunchResult: vi.fn(() => true),
    resultFailureMessage: (_result: unknown, fallback: string) => fallback,
    retryTerminalFitUntilMeasured: vi.fn(),
    setNativePanelVisible: vi.fn(),
    showToast: vi.fn(),
  } satisfies ProjectsActionsDependencies;

  const state = createProjectsState();
  const workspaceRenderer = { renderWorkspace: vi.fn() } as unknown as WorkspaceRenderer;
  const rowsApi = {
    loadFolderHistory: vi.fn(async () => undefined),
    renderProjectList: vi.fn(),
  } as ProjectsRowsApi;
  const actions = createProjectsWorkspaceActions(
    {} as ProjectsElements,
    state,
    dependencies,
    workspaceRenderer,
    rowsApi,
  );

  return { actions, dependencies, rowsApi, state, workspaceRenderer };
};

beforeEach(() => {
  Reflect.deleteProperty(window, 'controlPanel');
});

describe('projects workspace actions', () => {
  it('spawns one independently owned conversation for every rapid click', async () => {
    const pending = deferred<{ ok: true; state: WorkspaceState }>();
    const openConversation = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { openConversation, setWorkspaceTransitionBusy: vi.fn(async () => []) },
    });

    const { actions } = setup();
    // Both clicks land before the main process answers, exactly as an impatient double click does.
    const first = actions.openConversation('D:\\work\\repo');
    const second = actions.openConversation('D:\\work\\repo');
    pending.resolve({ ok: true, state: workspaceState });
    await Promise.all([first, second]);

    expect(openConversation).toHaveBeenCalledTimes(2);
  });

  it('projects a pending row and terminal preview before the main process replies', async () => {
    const pending = deferred<WorkspaceResult>();
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: {
        openConversation: vi.fn(() => pending.promise),
        setWorkspaceTransitionBusy: vi.fn(async () => []),
      },
    });

    const { actions, dependencies, state } = setup();
    const opening = actions.openConversation('D:\\work\\repo');

    expect([...state.pendingConversations.values()]).toEqual([
      expect.objectContaining({ kind: 'creating', projectPath: 'D:\\work\\repo' }),
    ]);
    expect(dependencies.beginWorkspaceTerminalPreview).toHaveBeenCalledWith('正在新建会话…');

    pending.resolve({ ok: false, state: workspaceState });
    await opening;
    expect(state.pendingConversations.size).toBe(0);
    expect(dependencies.showToast).toHaveBeenCalledWith('无法新建对话。', 'error');
  });

  it('launches ten rapid clicks with ten exact session owners', async () => {
    let sequence = 0;
    const openConversation = vi.fn(async (): Promise<WorkspaceResult> => {
      const createdSessionId = `created-${++sequence}`;
      return {
        createdSessionId,
        ok: true,
        runtime: 'claude',
        state: workspaceState,
      };
    });
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { openConversation, setWorkspaceTransitionBusy: vi.fn(async () => []) },
    });
    const { actions, dependencies } = setup();

    await Promise.all(Array.from({ length: 10 }, () => actions.openConversation('D:\\work\\repo')));
    await vi.waitFor(() => {
      expect(dependencies.launchCreatedConversation).toHaveBeenCalledTimes(10);
    });
    expect(dependencies.launchCreatedConversation).toHaveBeenNthCalledWith(
      10,
      'created-10',
      'claude',
    );
  });

  it('rolls back the exact temporary terminal when background launch fails', async () => {
    const closeProject = vi.fn(async () => ({ ok: true, state: workspaceState }));
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: {
        closeProject,
        openConversation: vi.fn(async () => ({
          createdSessionId: 'created-failed',
          ok: true,
          runtime: 'codex',
          state: workspaceState,
        })),
        setWorkspaceTransitionBusy: vi.fn(async () => []),
      },
    });
    const { actions, dependencies, state, workspaceRenderer } = setup();
    vi.mocked(dependencies.launchCreatedConversation).mockResolvedValue(false);

    await actions.openConversation('D:\\work\\repo');
    expect(state.transitioningConversations.get('created-failed')).toBe('creating');
    await vi.waitFor(() => {
      expect(closeProject).toHaveBeenCalledWith('created-failed');
    });
    expect(workspaceRenderer.renderWorkspace).toHaveBeenLastCalledWith(workspaceState);
    expect(dependencies.showToast).toHaveBeenCalledWith(
      expect.stringContaining('已撤销本次新建'),
      'error',
    );
    await vi.waitFor(() => {
      expect(state.transitioningConversations.has('created-failed')).toBe(false);
    });
  });

  it('reports a rollback failure instead of leaving an apparent success state', async () => {
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: {
        closeProject: vi.fn(async () => ({
          error: '终端仍忙碌',
          ok: false,
          state: workspaceState,
        })),
        openConversation: vi.fn(async () => ({
          createdSessionId: 'created-stuck',
          ok: true,
          runtime: 'claude',
          state: workspaceState,
        })),
        setWorkspaceTransitionBusy: vi.fn(async () => []),
      },
    });
    const { actions, dependencies, state } = setup();
    vi.mocked(dependencies.launchCreatedConversation).mockRejectedValue(new Error('CLI 启动异常'));

    await actions.openConversation('D:\\work\\repo');
    await vi.waitFor(() => {
      expect(dependencies.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/自动回滚未完成.*临时终端仍保留.*请手动关闭/u),
        'error',
      );
    });
    expect(state.failedConversationTransitions.get('created-stuck')).toBe('creating');
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
