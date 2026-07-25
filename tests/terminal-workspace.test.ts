import { describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../src/shared/contracts';
import type { ManagedTerminal } from '../src/main/terminal-workspace';
import { TerminalWorkspace } from '../src/main/terminal-workspace';

interface FakeTerminal extends ManagedTerminal {
  emitData: (data: string) => void;
}

const createFakeFactory = () => {
  const terminals = new Map<string, FakeTerminal>();

  const factory = (
    id: string,
    initialCwd: string,
    onData: (data: string) => void,
    onStatus: (status: TerminalStatus) => void,
  ): FakeTerminal => {
    let status: TerminalStatus = {
      cwd: initialCwd,
      id,
      phase: 'stopped',
      shell: 'Windows PowerShell',
    };
    const update = (next: TerminalStatus): TerminalStatus => {
      status = next;
      onStatus({ ...status });
      return { ...status };
    };
    const terminal: FakeTerminal = {
      emitData: onData,
      getStatus: () => ({ ...status }),
      resize: vi.fn(),
      restart: vi.fn(() =>
        update({
          cwd: status.cwd,
          id,
          phase: 'running',
          pid: 200 + terminals.size,
          shell: status.shell,
        }),
      ),
      start: vi.fn(() =>
        update({
          cwd: status.cwd,
          id,
          phase: 'running',
          pid: 100 + terminals.size,
          shell: status.shell,
        }),
      ),
      stop: vi.fn((emitStatus = true) => {
        const next = {
          cwd: status.cwd,
          id,
          phase: 'stopped' as const,
          shell: status.shell,
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

describe('TerminalWorkspace', () => {
  it('opens independent running project sessions and routes their output', () => {
    const dataListener = vi.fn();
    const stateListener = vi.fn();
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace(
      'C:\\Users\\Tester',
      dataListener,
      stateListener,
      factory,
    );

    const result = workspace.openProject('D:\\Project Alpha');
    const state = workspace.getState();

    expect(result.reused).toBe(false);
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe('session-2');
    expect(state.sessions[1]).toMatchObject({
      cwd: 'D:\\Project Alpha',
      phase: 'running',
    });

    terminals.get('session-1')?.emitData('home output');
    terminals.get('session-2')?.emitData('project output');
    expect(dataListener).toHaveBeenNthCalledWith(1, 'session-1', 'home output');
    expect(dataListener).toHaveBeenNthCalledWith(2, 'session-2', 'project output');
  });

  it('reuses an already-open project without creating a duplicate session', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace('C:\\Users\\Tester', vi.fn(), vi.fn(), factory);

    workspace.openProject('D:\\Project Alpha');
    const result = workspace.openProject('d:\\project alpha');

    expect(result.reused).toBe(true);
    expect(result.state.sessions).toHaveLength(2);
    expect(result.state.activeSessionId).toBe('session-2');
  });

  it('keeps other projects running when the active project is closed', () => {
    const { factory, terminals } = createFakeFactory();
    const workspace = new TerminalWorkspace('C:\\Users\\Tester', vi.fn(), vi.fn(), factory);
    workspace.start('session-1');
    workspace.openProject('D:\\Project Alpha');

    const state = workspace.close('session-2');

    expect(state.activeSessionId).toBe('session-1');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.phase).toBe('running');
    expect(terminals.get('session-2')?.stop).toHaveBeenCalledWith(false);
  });

  it('creates a fresh stopped home session after closing the final project', () => {
    const { factory } = createFakeFactory();
    const workspace = new TerminalWorkspace('C:\\Users\\Tester', vi.fn(), vi.fn(), factory);

    const state = workspace.close('session-1');

    expect(state.activeSessionId).toBe('session-2');
    expect(state.sessions).toEqual([
      {
        cwd: 'C:\\Users\\Tester',
        id: 'session-2',
        phase: 'stopped',
        shell: 'Windows PowerShell',
      },
    ]);
  });
});
