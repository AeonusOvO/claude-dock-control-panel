// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TerminalStatus,
  WorkspaceProjectView,
  WorkspaceResult,
  WorkspaceState,
} from '../../src/shared/contracts';
import { createProjectsHistoryActions } from '../../src/renderer/features/projects/actions-history';
import { createProjectsWorkspaceActions } from '../../src/renderer/features/projects/actions-workspace';
import type {
  ProjectsActionsDependencies,
  ProjectsRowsApi,
} from '../../src/renderer/features/projects/actions-dependencies';
import type { ProjectsElements } from '../../src/renderer/features/projects/elements';
import { createProjectsState } from '../../src/renderer/features/projects/state';
import type { WorkspaceRenderer } from '../../src/renderer/features/projects/workspace';
import { ClaudeLaunchAttemptRegistry } from '../../src/renderer/platform/claude-launch-attempt';
import { ConversationTransitionQueue } from '../../src/renderer/features/projects/conversation-transition-queue';

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
const deferred = <T>(): {
  promise: Promise<T>;
  reject: (reason: Error) => void;
  resolve: (value: T) => void;
} => {
  let reject!: (reason: Error) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

const project: WorkspaceProjectView = {
  lastActiveAt: 1,
  missing: false,
  name: 'Repo',
  open: true,
  path: 'D:\\work\\repo',
  remembered: true,
  sessionIds: ['session-1'],
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
    setClaudeLaunchPaused: vi.fn(() => true),
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
    expect(dependencies.beginWorkspaceTerminalPreview).toHaveBeenCalledWith('正在读取配置…');

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
      expect.any(Function),
    );
  });

  it('keeps overflow queued and lets its exact cross cancel without opening a session', async () => {
    const launch = deferred<boolean>();
    const openConversation = vi.fn(async (): Promise<WorkspaceResult> => ({
      createdSessionId: 'created-running',
      ok: true,
      runtime: 'claude',
      state: workspaceState,
    }));
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: {
        openConversation,
        setWorkspaceTransitionBusy: vi.fn(async () => []),
      },
    });
    const { actions, dependencies, state } = setup();
    state.conversationTransitionQueue = new ConversationTransitionQueue(1);
    vi.mocked(dependencies.launchCreatedConversation).mockImplementation(() => launch.promise);

    const first = actions.openConversation('D:\\work\\repo');
    await vi.waitFor(() => {
      expect(dependencies.launchCreatedConversation).toHaveBeenCalledOnce();
    });
    const second = actions.openConversation('D:\\work\\repo');
    await vi.waitFor(() => {
      expect([...state.pendingConversations.values()]).toEqual([
        expect.objectContaining({ phase: 'queued', queuePosition: 1 }),
      ]);
    });
    expect([...state.pendingConversations.values()][0]?.cancel?.()).toBe(true);
    await second;

    expect(openConversation).toHaveBeenCalledOnce();
    expect(dependencies.showToast).toHaveBeenCalledWith('已取消排队中的新建对话');
    launch.resolve(true);
    await first;
  });

  it('shares admission with history restores and cancels queued history without touching main', async () => {
    const launch = deferred<boolean>();
    const openStoredConversation = vi.fn();
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: {
        openConversation: vi.fn(async (): Promise<WorkspaceResult> => ({
          createdSessionId: 'created-running',
          ok: true,
          runtime: 'claude',
          state: workspaceState,
        })),
        openStoredConversation,
        setWorkspaceTransitionBusy: vi.fn(async () => []),
      },
    });
    const { actions, dependencies, rowsApi, state, workspaceRenderer } = setup();
    state.conversationTransitionQueue = new ConversationTransitionQueue(1);
    vi.mocked(dependencies.launchCreatedConversation).mockImplementation(() => launch.promise);
    const stored = {
      conversationId: '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      lastActiveAt: 1,
      messageCount: 2,
      sessionId: '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      sessionName: '排队恢复稿',
    };
    state.storedConversations.set('d:\\work\\repo', [stored]);
    const historyActions = createProjectsHistoryActions(
      state,
      dependencies,
      workspaceRenderer,
      rowsApi,
      async () => null,
      async () => null,
    );

    const running = actions.openConversation('D:\\work\\repo');
    await vi.waitFor(() => expect(dependencies.launchCreatedConversation).toHaveBeenCalledOnce());
    const restoring = historyActions.resumeStoredConversation('D:\\work\\repo', stored);
    await vi.waitFor(() => {
      expect([...state.pendingConversations.values()]).toEqual([
        expect.objectContaining({ kind: 'restoring', phase: 'queued', queuePosition: 1 }),
      ]);
    });
    const refreshed = [
      stored,
      {
        ...stored,
        conversationId: 'new-history',
        sessionId: 'new-history',
        sessionName: '较新历史',
      },
    ];
    state.storedConversations.set('d:\\work\\repo', refreshed);
    expect([...state.pendingConversations.values()][0]?.cancel?.()).toBe(true);
    await restoring;

    expect(openStoredConversation).not.toHaveBeenCalled();
    expect(state.storedConversations.get('d:\\work\\repo')).toEqual(refreshed);
    expect(dependencies.showToast).toHaveBeenCalledWith('已取消排队中的历史对话“排队恢复稿”');
    launch.resolve(true);
    await running;
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
    const launch = deferred<boolean>();
    vi.mocked(dependencies.launchCreatedConversation).mockImplementation(() => launch.promise);

    const opening = actions.openConversation('D:\\work\\repo');
    await vi.waitFor(() => {
      expect(state.transitioningConversations.get('created-failed')).toBe('creating');
    });
    launch.resolve(false);
    await opening;
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

  it('removes a failed temporary session without offering archive confirmation', async () => {
    const closeProject = vi.fn(async () => ({ ok: true, state: workspaceState }));
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { closeProject },
    });
    const { actions, dependencies, state } = setup();
    state.failedConversationTransitions.set('session-1', 'creating');
    const status = workspaceState.sessions[0]!;

    await actions.closeProject(status);

    expect(dependencies.requestConfirmation).not.toHaveBeenCalled();
    expect(closeProject).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(dependencies.showToast).toHaveBeenCalledWith(expect.stringContaining('失败临时会话'));
  });

  it('renders a target-owned close lock immediately and unlocks after an IPC failure for retry', async () => {
    const pending = deferred<WorkspaceResult>();
    const closeProject = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'controlPanel', { configurable: true, value: { closeProject } });
    const { actions, dependencies, rowsApi, state } = setup();
    const releaseMask = vi.fn();
    vi.mocked(dependencies.beginTerminalMask).mockReturnValue(releaseMask);

    const first = actions.closeProject(workspaceState.sessions[0]!);
    expect(state.workspaceMutations.has('close:session-1')).toBe(true);
    expect(rowsApi.renderProjectList).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(dependencies.beginTerminalMask).toHaveBeenCalledWith('session-1', '正在关闭并归档…');
    await actions.closeProject(workspaceState.sessions[0]!);
    await actions.closeProjectFolder(project);
    expect(closeProject).toHaveBeenCalledOnce();

    pending.reject(new Error('终端停止失败'));
    await first;
    expect(state.workspaceMutations.size).toBe(0);
    expect(rowsApi.renderProjectList).toHaveBeenCalledTimes(2);
    expect(releaseMask).toHaveBeenCalledOnce();
    expect(dependencies.showToast).toHaveBeenCalledWith('终端停止失败', 'error');

    closeProject.mockResolvedValueOnce({ ok: true, state: workspaceState });
    await actions.closeProject(workspaceState.sessions[0]!);
    expect(closeProject).toHaveBeenCalledTimes(2);
  });

  it('releases the visible lock when the user cancels confirmation', async () => {
    const { actions, dependencies, rowsApi, state } = setup();
    vi.mocked(dependencies.requestConfirmation).mockResolvedValue(false);
    await actions.closeProject(workspaceState.sessions[0]!);
    expect(state.workspaceMutations.size).toBe(0);
    expect(rowsApi.renderProjectList).toHaveBeenCalledTimes(2);
    expect(dependencies.beginTerminalMask).not.toHaveBeenCalled();
  });

  it('keeps a folder close exclusive with child closes and new conversations until settled', async () => {
    const pending = deferred<WorkspaceResult>();
    const closeProjectFolder = vi.fn(() => pending.promise);
    const closeProject = vi.fn();
    const openConversation = vi.fn();
    Object.defineProperty(window, 'controlPanel', {
      configurable: true,
      value: { closeProject, closeProjectFolder, openConversation },
    });
    const { actions, dependencies, state, workspaceRenderer } = setup();
    const releaseMask = vi.fn();
    vi.mocked(dependencies.beginTerminalMask).mockReturnValue(releaseMask);

    const closing = actions.closeProjectFolder(project);
    await actions.closeProjectFolder({ ...project, path: project.path.toUpperCase() });
    await actions.closeProject(workspaceState.sessions[0]!);
    await actions.openConversation(project.path.toUpperCase());
    expect(closeProjectFolder).toHaveBeenCalledOnce();
    expect(closeProject).not.toHaveBeenCalled();
    expect(openConversation).not.toHaveBeenCalled();
    expect(dependencies.requestConfirmation).toHaveBeenCalledOnce();

    pending.resolve({ ok: false, state: workspaceState });
    await closing;
    expect(workspaceRenderer.renderWorkspace).toHaveBeenCalledWith(workspaceState);
    expect(state.workspaceMutations.size).toBe(0);
    expect(releaseMask).toHaveBeenCalledOnce();
    expect(dependencies.showToast).toHaveBeenCalledWith('无法关闭这个项目。', 'error');
  });

  it('allows independent conversations to close concurrently', async () => {
    const pending = deferred<WorkspaceResult>();
    const closeProject = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'controlPanel', { configurable: true, value: { closeProject } });
    const { actions, state } = setup();
    const first = actions.closeProject(workspaceState.sessions[0]!);
    const second = actions.closeProject({ ...workspaceState.sessions[0]!, id: 'session-2' });
    await Promise.resolve();
    expect(closeProject).toHaveBeenCalledTimes(2);
    expect(state.workspaceMutations.size).toBe(2);
    pending.resolve({ ok: true, state: workspaceState });
    await Promise.all([first, second]);
    expect(state.workspaceMutations.size).toBe(0);
  });
});
