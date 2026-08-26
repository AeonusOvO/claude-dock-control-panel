import { describe, expect, it, vi } from 'vitest';
import type { PtyGeneration, TerminalStatus } from '../../src/shared/contracts';
import type { ManagedTerminal } from '../../src/main/terminal/workspace';
import { TerminalWorkspace } from '../../src/main/terminal/workspace';
import { normalizeTerminalSize } from '../../src/main/infra/directory';

interface FakeTerminal extends ManagedTerminal {
  emitData: (ptyGeneration: PtyGeneration, data: string) => void;
}

const createFakeFactory = () => {
  const terminals = new Map<string, FakeTerminal>();

  const factory = (
    id: string,
    initialCwd: string,
    initialTitle: string,
    onData: (ptyGeneration: PtyGeneration, data: string) => void,
    onStatus: (status: TerminalStatus) => void,
  ): FakeTerminal => {
    let processGeneration: PtyGeneration | undefined;
    let status: TerminalStatus = {
      cwd: initialCwd,
      id,
      phase: 'stopped',
      ptyGeneration: 0,
      shell: 'Windows PowerShell',
      title: initialTitle,
    };
    const update = (next: TerminalStatus): TerminalStatus => {
      status = next;
      onStatus({ ...status });
      return { ...status };
    };
    const startTerminal = (pid: number): TerminalStatus => {
      if (processGeneration !== undefined) {
        return { ...status };
      }
      const ptyGeneration = status.ptyGeneration + 1;
      processGeneration = ptyGeneration;
      return update({
        cwd: status.cwd,
        id,
        phase: 'running',
        pid,
        ptyGeneration,
        shell: status.shell,
        title: status.title,
      });
    };
    const stopTerminal = (emitStatus = true): TerminalStatus => {
      processGeneration = undefined;
      if (emitStatus) {
        return update({
          cwd: status.cwd,
          id,
          phase: 'stopped',
          ptyGeneration: status.ptyGeneration,
          shell: status.shell,
          title: status.title,
        });
      }
      return { ...status };
    };
    const terminal: FakeTerminal = {
      emitData: (ptyGeneration, data) => {
        if (ptyGeneration === processGeneration) {
          onData(ptyGeneration, data);
        }
      },
      getStatus: () => ({ ...status }),
      resize: vi.fn((cols: number, rows: number) => ({ cols, rows })),
      restart: vi.fn(() => {
        stopTerminal(false);
        return startTerminal(200 + terminals.size);
      }),
      setTitle: vi.fn((title: string) => update({ ...status, title })),
      start: vi.fn(() => startTerminal(100 + terminals.size)),
      stop: vi.fn(stopTerminal),
      stopIfGeneration: vi.fn((expectedGeneration, emitStatus = true) =>
        expectedGeneration === status.ptyGeneration ? stopTerminal(emitStatus) : undefined,
      ),
      write: vi.fn(
        (expectedGeneration, _data) =>
          expectedGeneration === processGeneration && status.phase === 'running',
      ),
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
    const { ptyGeneration } = workspace.getStatus(sessionId);

    expect(workspace.resize(sessionId, ptyGeneration, 120, 40)).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  it('rejects a resize owned by a stale PTY generation', () => {
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    const sessionId = workspace.getState().activeSessionId;
    const staleGeneration = workspace.getStatus(sessionId).ptyGeneration;
    const restarted = workspace.restart(sessionId);
    const terminal = terminals.get(sessionId);

    expect(workspace.resize(sessionId, staleGeneration, 120, 40)).toBeUndefined();
    expect(terminal?.resize).not.toHaveBeenCalled();
    expect(workspace.resize(sessionId, restarted.ptyGeneration, 120, 40)).toEqual({
      cols: 120,
      rows: 40,
    });
    expect(terminal?.resize).toHaveBeenCalledOnce();
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

    const alphaGeneration = workspace.getStatus('session-1').ptyGeneration;
    const betaGeneration = workspace.getStatus('session-2').ptyGeneration;
    terminals.get('session-1')?.emitData(alphaGeneration, 'alpha output');
    terminals.get('session-2')?.emitData(betaGeneration, 'beta output');
    expect(dataListener).toHaveBeenNthCalledWith(1, 'session-1', alphaGeneration, 'alpha output');
    expect(dataListener).toHaveBeenNthCalledWith(2, 'session-2', betaGeneration, 'beta output');
  });

  it('invalidates pending launch authority before every active-session change', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    const activeSessionIds: string[] = [];
    workspace.setBeforeActiveSessionChange(() => {
      activeSessionIds.push(workspace.getState().activeSessionId);
    });

    workspace.openProject('D:\\Project Alpha');
    workspace.openProject('D:\\Project Beta');
    workspace.activate('session-1');
    workspace.activate('session-1');
    workspace.openConversation('D:\\Project Alpha');

    expect(activeSessionIds).toEqual(['', 'session-1', 'session-2', 'session-1']);
  });

  it('rejects terminal data from an obsolete PTY generation', () => {
    const dataListener = vi.fn();
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(dataListener, vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    const staleGeneration = workspace.getStatus('session-1').ptyGeneration;
    const restarted = workspace.restart('session-1');
    const terminal = terminals.get('session-1');

    terminal?.emitData(staleGeneration, 'stale output');
    expect(dataListener).not.toHaveBeenCalled();
    terminal?.emitData(restarted.ptyGeneration, 'fresh output');
    expect(dataListener).toHaveBeenCalledOnce();
    expect(dataListener).toHaveBeenCalledWith('session-1', restarted.ptyGeneration, 'fresh output');
  });

  it('uses the current theme for future starts and restarts without touching live sessions', () => {
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory, 'graphite');

    workspace.openProject('D:\\Project Alpha');
    const terminal = terminals.get('session-1');
    expect(terminal?.start).toHaveBeenCalledWith('D:\\Project Alpha', {}, 'graphite');

    workspace.setTheme('telegram');
    expect(terminal?.start).toHaveBeenCalledTimes(1);

    workspace.restart('session-1');
    expect(terminal?.restart).toHaveBeenCalledWith(undefined, {}, 'telegram');
    workspace.start('session-1');
    expect(terminal?.start).toHaveBeenLastCalledWith(undefined, {}, 'telegram');
  });

  it('rejects writes owned by a stale PTY generation', () => {
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    const staleGeneration = workspace.getStatus('session-1').ptyGeneration;
    const restarted = workspace.restart('session-1');
    const terminal = terminals.get('session-1');

    expect(workspace.write('session-1', staleGeneration, 'stale input')).toBe(false);
    expect(workspace.write('session-1', restarted.ptyGeneration, 'fresh input')).toBe(true);
    expect(terminal?.write).toHaveBeenNthCalledWith(1, staleGeneration, 'stale input');
    expect(terminal?.write).toHaveBeenNthCalledWith(2, restarted.ptyGeneration, 'fresh input');
  });

  it('rejects stops owned by a stale PTY generation', () => {
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    const staleGeneration = workspace.getStatus('session-1').ptyGeneration;
    const restarted = workspace.restart('session-1');

    expect(workspace.stopIfGeneration('session-1', staleGeneration)).toBeUndefined();
    expect(workspace.getStatus('session-1')).toMatchObject({
      phase: 'running',
      ptyGeneration: restarted.ptyGeneration,
    });
    expect(terminals.get('session-1')?.stopIfGeneration).toHaveBeenCalledWith(
      staleGeneration,
      true,
    );
  });

  it('advances the PTY generation once on restart and not at all on stop', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');
    const started = workspace.getStatus('session-1');

    const restarted = workspace.restart('session-1');
    expect(restarted.ptyGeneration).toBe(started.ptyGeneration + 1);

    const stopped = workspace.stop('session-1');
    expect(stopped).toMatchObject({
      phase: 'stopped',
      ptyGeneration: restarted.ptyGeneration,
    });
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

  it('captures the selected engine per conversation without mutating sibling sessions', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);

    workspace.openProject('D:\\Project Alpha', 'claude');
    workspace.openConversation('D:\\Project Alpha', undefined, 'codex');
    workspace.openConversation('D:\\Project Alpha', undefined, 'claude');

    expect(workspace.getDevelopmentRuntime('session-1')).toBe('claude');
    expect(workspace.getDevelopmentRuntime('session-2')).toBe('codex');
    expect(workspace.getDevelopmentRuntime('session-3')).toBe('claude');
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

  it('syncs Claude automatic titles without letting stale ticks undo a manual rename', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace(vi.fn(), vi.fn(), factory);
    workspace.openProject('D:\\Project Alpha');

    expect(workspace.syncClaudeSessionTitle('session-1', '  修复登录重定向  ')).toBe(true);
    expect(workspace.getStatus('session-1').title).toBe('修复登录重定向');

    workspace.renameSession('session-1', '自定义登录标题');
    expect(workspace.syncClaudeSessionTitle('session-1', '修复登录重定向')).toBe(false);
    expect(workspace.getStatus('session-1').title).toBe('自定义登录标题');

    expect(workspace.syncClaudeSessionTitle('session-1', '自定义登录标题')).toBe(false);
    expect(workspace.syncClaudeSessionTitle('session-1', '最终登录标题')).toBe(true);
    expect(workspace.getStatus('session-1').title).toBe('最终登录标题');
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
