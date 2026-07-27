import { describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../src/shared/contracts';
import type { ManagedTerminal } from '../src/main/terminal-workspace';
import { TerminalWorkspace } from '../src/main/terminal-workspace';
import { normalizeTerminalSize } from '../src/main/directory';

interface FakeTerminal extends ManagedTerminal {
  emitData: (data: string) => void;
}

const createFakeFactory = () => {
  const terminals = new Map<string, FakeTerminal>();

  const factory = (
    id: string,
    initialCwd: string,
    initialTitle: string,
    onData: (data: string) => void,
    onStatus: (status: TerminalStatus) => void,
  ): FakeTerminal => {
    let status: TerminalStatus = {
      cwd: initialCwd,
      id,
      phase: 'stopped',
      shell: 'Windows PowerShell',
      title: initialTitle,
    };
    const update = (next: TerminalStatus): TerminalStatus => {
      status = next;
      onStatus({ ...status });
      return { ...status };
    };
    const terminal: FakeTerminal = {
      emitData: onData,
      getStatus: () => ({ ...status }),
      resize: vi.fn((cols: number, rows: number) => ({ cols, rows })),
      restart: vi.fn(() =>
        update({
          cwd: status.cwd,
          id,
          phase: 'running',
          pid: 200 + terminals.size,
          shell: status.shell,
          title: status.title,
        }),
      ),
      setTitle: vi.fn((title: string) => update({ ...status, title })),
      start: vi.fn(() =>
        update({
          cwd: status.cwd,
          id,
          phase: 'running',
          pid: 100 + terminals.size,
          shell: status.shell,
          title: status.title,
        }),
      ),
      stop: vi.fn((emitStatus = true) => {
        const next = {
          cwd: status.cwd,
          id,
          phase: 'stopped' as const,
          shell: status.shell,
          title: status.title,
        };
        if (emitStatus) {
          return update(next);
        }
        status = next;
        return { ...status };
      }),
      write: vi.fn(),
    };
    terminals.set(id, terminal);
    return terminal;
  };

  return { factory, terminals };
};

describe('terminal size reconciliation', () => {
  /*
   * PSReadLine repaints its edit buffer with ABSOLUTE cursor moves (Ctrl+C emits e.g. `ESC[10;27H`).
   * If xterm and ConPTY disagree on the grid, that repaint lands on the wrong row and the previous
   * screen stays visible — the "two screens stacked" bug. So a resize must report back the size the
   * PTY really took, and the renderer follows it.
   */
  it('clamps the size the renderer asked for', () => {
    expect(normalizeTerminalSize(5, 2)).toEqual({ cols: 20, rows: 5 });
    expect(normalizeTerminalSize(9999, 9999)).toEqual({ cols: 500, rows: 200 });
    expect(normalizeTerminalSize(Number.NaN, Number.NaN)).toEqual({ cols: 80, rows: 24 });
  });

  it('passes the adopted size back out of the workspace', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    const sessionId = workspace.getState().activeSessionId;

    expect(workspace.resize(sessionId, 120, 40)).toEqual({ cols: 120, rows: 40 });
  });
});

describe('TerminalWorkspace', () => {
  /*
   * A conversation always belongs to a folder the user chose. Inventing one in the home directory
   * used to surface a phantom project named after the Windows account, so an empty workspace is a
   * legitimate state both at first launch and after the last conversation is closed.
   */
  it('starts with no conversation at all', () => {
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);

    expect(workspace.getState()).toEqual({ activeSessionId: '', sessions: [] });
    expect(workspace.getActiveStatus()).toBeUndefined();
    expect(terminals.size).toBe(0);
  });

  it('opens independent running project sessions and routes their output', () => {
    const dataListener = vi.fn();
    const stateListener = vi.fn();
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(dataListener, stateListener, factory);

    workspace.openProject('D:\\Project Alpha');
    const result = workspace.openProject('D:\\Project Beta');
    const state = workspace.getState();

    expect(result.reused).toBe(false);
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe('session-2');
    expect(state.sessions[1]).toMatchObject({
      cwd: 'D:\\Project Beta',
      phase: 'running',
      title: '对话 1',
    });

    terminals.get('session-1')?.emitData('alpha output');
    terminals.get('session-2')?.emitData('beta output');
    expect(dataListener).toHaveBeenNthCalledWith(1, 'session-1', 'alpha output');
    expect(dataListener).toHaveBeenNthCalledWith(2, 'session-2', 'beta output');
  });

  it('reuses an already-open project without creating a duplicate session', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);

    workspace.openProject('D:\\Project Alpha');
    const result = workspace.openProject('d:\\project alpha');

    expect(result.reused).toBe(true);
    expect(result.state.sessions).toHaveLength(1);
    expect(result.state.activeSessionId).toBe('session-1');
  });

  it('runs several concurrent conversations inside one project folder', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);

    workspace.openProject('D:\\Project Alpha');
    const state = workspace.openConversation('d:\\project alpha');

    expect(state.activeSessionId).toBe('session-2');
    expect(workspace.sessionIdsForDirectory('D:\\Project Alpha')).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(state.sessions.map((session) => session.title)).toEqual(['对话 1', '对话 2']);
    expect(state.sessions.filter((session) => session.phase === 'running')).toHaveLength(2);
  });

  it('closes every conversation of a folder at once', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    workspace.openProject('D:\\Project Beta');
    workspace.openConversation('D:\\Project Alpha');

    const state = workspace.closeDirectory('d:\\project alpha');

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.cwd).toBe('D:\\Project Beta');
    expect(workspace.sessionIdsForDirectory('D:\\Project Alpha')).toEqual([]);
  });

  it('renames a conversation and rejects unusable titles', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');

    const state = workspace.renameSession('session-1', '  重构登录流程  ');

    expect(state.sessions[0]?.title).toBe('重构登录流程');
    expect(() => workspace.renameSession('session-1', '   ')).toThrow(/1-60/);
    expect(() => workspace.renameSession('session-1', 'a\nb')).toThrow(/1-60/);
  });

  it('keeps other projects running when the active project is closed', () => {
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    workspace.openProject('D:\\Project Beta');

    const state = workspace.close('session-2');

    expect(state.activeSessionId).toBe('session-1');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.phase).toBe('running');
    expect(terminals.get('session-2')?.stop).toHaveBeenCalledWith(false);
  });

  it('falls back to an empty workspace after closing the final conversation', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');

    const state = workspace.close('session-1');

    expect(state).toEqual({ activeSessionId: '', sessions: [] });
    expect(workspace.getActiveStatus()).toBeUndefined();
  });
});
