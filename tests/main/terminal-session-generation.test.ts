import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSession } from '../../src/main/terminal/session';
import type { PtyGeneration, TerminalStatus } from '../../src/shared/contracts';
import {
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_TERMINAL_WRITE_LENGTH,
} from '../../src/shared/contracts/terminal';

interface ControlledPty {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  resize: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

const ptyHarness = vi.hoisted(() => {
  let nextPid = 4000;
  let forcedPid: number | undefined;
  const processes: ControlledPty[] = [];
  const spawn = vi.fn(() => {
    let dataListener: ((data: string) => void) | undefined;
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const terminal = {
      cols: 100,
      emitData: (data: string) => dataListener?.(data),
      emitExit: (exitCode: number) => exitListener?.({ exitCode }),
      kill: vi.fn(),
      onData: (listener: (data: string) => void) => {
        dataListener = listener;
        return { dispose: vi.fn() };
      },
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListener = listener;
        return { dispose: vi.fn() };
      },
      pid: forcedPid ?? nextPid++,
      process: 'powershell.exe',
      resize: vi.fn(),
      rows: 30,
      write: vi.fn(),
    } as unknown as ControlledPty;
    forcedPid = undefined;
    processes.push(terminal);
    return terminal;
  });

  return {
    forceNextPid: (pid: number | undefined) => (forcedPid = pid),
    processes,
    spawn,
  };
});

vi.mock('@lydell/node-pty', () => ({
  spawn: ptyHarness.spawn,
}));

// The session tree-terminates via taskkill on stop; keep unit tests from ever spawning it.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

beforeEach(() => {
  ptyHarness.forceNextPid(undefined);
  ptyHarness.processes.splice(0);
  ptyHarness.spawn.mockClear();
});

describe('TerminalSession PTY generation ownership', () => {
  it('publishes the adopted grid with every replacement generation before its output', () => {
    const statuses: TerminalStatus[] = [];
    const session = new TerminalSession('session-size', 'D:\\Project', '对话', vi.fn(), (status) =>
      statuses.push(status),
    );
    session.start();
    session.resize(159, 39);
    const restarted = session.restart();
    expect(restarted).toMatchObject({ ptyGeneration: 2, size: { cols: 159, rows: 39 } });
    expect(statuses.filter(({ ptyGeneration }) => ptyGeneration === 2)).toEqual([
      expect.objectContaining({ phase: 'starting', size: { cols: 159, rows: 39 } }),
      expect.objectContaining({ phase: 'running', size: { cols: 159, rows: 39 } }),
    ]);
    expect(ptyHarness.spawn).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cols: 159, rows: 39 }),
    );
  });

  it('starts the live ConPTY without loading PowerShell profiles', () => {
    const session = new TerminalSession('session-profile', 'D:\\Project', '对话', vi.fn(), vi.fn());

    session.start();

    expect(ptyHarness.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/i),
      ['-NoLogo', '-NoProfile', '-NoExit', '-Command', expect.any(String)],
      expect.objectContaining({
        useConpty: true,
        useConptyDll: true,
      }),
    );
  });

  it('forwards one maximum clipboard bracketed-paste payload as one PTY write', () => {
    const session = new TerminalSession('session-paste', 'D:\\Project', '对话', vi.fn(), vi.fn());
    const started = session.start();
    const terminal = ptyHarness.processes[0]!;
    const payload = `\x1b[200~${'x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH)}\x1b[201~`;

    expect(payload).toHaveLength(MAX_TERMINAL_WRITE_LENGTH);
    expect(session.write(started.ptyGeneration, payload)).toBe(true);
    expect(terminal.write).toHaveBeenCalledOnce();
    expect(terminal.write.mock.calls[0]?.[0]).toBe(payload);
  });

  it('ignores late data and exit callbacks from a replaced node-pty process', () => {
    const data: Array<{ data: string; ptyGeneration: PtyGeneration }> = [];
    const statuses: TerminalStatus[] = [];
    const session = new TerminalSession(
      'session-1',
      'D:\\Project',
      '对话 1',
      (ptyGeneration, chunk) => data.push({ data: chunk, ptyGeneration }),
      (status) => statuses.push(status),
    );

    const first = session.start();
    const firstProcess = ptyHarness.processes[0]!;
    const second = session.restart();
    const secondProcess = ptyHarness.processes[1]!;

    expect(first.ptyGeneration).toBe(1);
    expect(second).toMatchObject({
      phase: 'running',
      ptyGeneration: 2,
    });
    expect(firstProcess.kill).toHaveBeenCalledOnce();
    expect(secondProcess.kill).not.toHaveBeenCalled();

    firstProcess.emitData('stale output');
    firstProcess.emitExit(17);

    expect(data).toEqual([]);
    expect(session.getStatus()).toMatchObject({
      phase: 'running',
      pid: secondProcess.pid,
      ptyGeneration: second.ptyGeneration,
    });
    expect(statuses.filter(({ phase }) => phase === 'stopped')).toEqual([]);
    expect(secondProcess.kill).not.toHaveBeenCalled();

    expect(session.write(first.ptyGeneration, 'stale input')).toBe(false);
    expect(session.write(second.ptyGeneration, 'fresh input')).toBe(true);
    expect(firstProcess.write).not.toHaveBeenCalled();
    expect(secondProcess.write).toHaveBeenCalledOnce();
    expect(secondProcess.write).toHaveBeenCalledWith('fresh input');

    secondProcess.emitData('fresh output');
    secondProcess.emitExit(0);

    expect(data).toEqual([
      {
        data: 'fresh output',
        ptyGeneration: second.ptyGeneration,
      },
    ]);
    expect(session.getStatus()).toMatchObject({
      phase: 'stopped',
      ptyGeneration: second.ptyGeneration,
    });
    expect(statuses.filter(({ phase }) => phase === 'stopped')).toHaveLength(1);
  });

  it('advances once per spawn attempt while stop preserves the current generation', () => {
    ptyHarness.spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    const session = new TerminalSession('session-2', 'D:\\Project', '对话 2', vi.fn(), vi.fn());

    expect(session.start()).toMatchObject({
      phase: 'error',
      ptyGeneration: 1,
    });

    const running = session.start();
    expect(running).toMatchObject({
      phase: 'running',
      ptyGeneration: 2,
    });
    const runningProcess = ptyHarness.processes[0]!;

    expect(session.stop()).toMatchObject({
      phase: 'stopped',
      ptyGeneration: running.ptyGeneration,
    });
    expect(runningProcess.kill).toHaveBeenCalledOnce();

    expect(session.start()).toMatchObject({
      phase: 'running',
      ptyGeneration: running.ptyGeneration + 1,
    });
  });
});

describe('TerminalSession PID handshake', () => {
  const startSession = (killTree?: (pid: number) => void) => {
    const data: Array<{ data: string; ptyGeneration: PtyGeneration }> = [];
    const statuses: TerminalStatus[] = [];
    const session = new TerminalSession(
      'session-pid',
      'D:\\Project',
      '对话',
      (ptyGeneration, chunk) => data.push({ data: chunk, ptyGeneration }),
      (status) => statuses.push(status),
      killTree,
    );
    return { data, session, statuses };
  };

  it('captures the shell PID and strips the handshake sequence from the renderer stream', () => {
    const { data, session, statuses } = startSession();

    const started = session.start();
    const terminal = ptyHarness.processes[0]!;

    terminal.emitData('\x1b]CLAUDEDOCK_PID;7777\x07PS C:\\Project> ');

    expect(session.getStatus()).toMatchObject({ phase: 'running', pid: 7777 });
    expect(data).toEqual([{ data: 'PS C:\\Project> ', ptyGeneration: started.ptyGeneration }]);
    expect(statuses.filter((status) => status.pid === 7777)).toHaveLength(1);

    // Once the handshake is complete later frames flow through untouched.
    terminal.emitData('echo hi\r\n');
    expect(data).toHaveLength(2);
    expect(data[1]).toMatchObject({ data: 'echo hi\r\n' });
  });

  it('keeps the reported pty pid when the handshake never arrives', () => {
    const { data, session } = startSession();

    session.start();
    const terminal = ptyHarness.processes[0]!;

    terminal.emitData('plain output');

    expect(session.getStatus()).toMatchObject({ phase: 'running', pid: terminal.pid });
    expect(data).toEqual([{ data: 'plain output', ptyGeneration: 1 }]);
  });

  it('reassembles a handshake split across stream chunks', () => {
    const { data, session } = startSession();

    session.start();
    const terminal = ptyHarness.processes[0]!;

    terminal.emitData('before \x1b]CLAUDEDOCK_PI');
    expect(data).toEqual([{ data: 'before ', ptyGeneration: 1 }]);

    terminal.emitData('D;7777\x07after');
    expect(session.getStatus()).toMatchObject({ pid: 7777 });
    expect(data).toEqual([
      { data: 'before ', ptyGeneration: 1 },
      { data: 'after', ptyGeneration: 1 },
    ]);
  });

  it('flushes the stream unchanged once the handshake budget is exhausted', () => {
    const { data, session } = startSession();

    session.start();
    const terminal = ptyHarness.processes[0]!;

    const flood = 'x'.repeat(9_000);
    terminal.emitData(flood);
    expect(data).toEqual([{ data: flood, ptyGeneration: 1 }]);

    // Parsing is disabled afterwards: a late handshake reaches the renderer verbatim.
    terminal.emitData('\x1b]CLAUDEDOCK_PID;7777\x07tail');
    expect(data).toHaveLength(2);
    expect(data[1]).toMatchObject({ data: '\x1b]CLAUDEDOCK_PID;7777\x07tail' });
    expect(session.getStatus()).toMatchObject({ pid: terminal.pid });
  });

  it('re-arms the handshake for each new pty generation', () => {
    const { session } = startSession();

    session.start();
    ptyHarness.processes[0]!.emitData('\x1b]CLAUDEDOCK_PID;1111\x07');
    expect(session.getStatus()).toMatchObject({ pid: 1111 });

    session.restart();
    const second = ptyHarness.processes[1]!;
    second.emitData('\x1b]CLAUDEDOCK_PID;2222\x07');
    expect(session.getStatus()).toMatchObject({ pid: 2222, ptyGeneration: 2 });
  });

  it('terminates the shell process tree when stopping a running session', () => {
    const killTree = vi.fn();
    const { session } = startSession(killTree);

    session.start();
    const terminal = ptyHarness.processes[0]!;
    terminal.emitData('\x1b]CLAUDEDOCK_PID;7777\x07');

    session.stop();

    expect(terminal.kill).toHaveBeenCalledOnce();
    expect(killTree).toHaveBeenCalledOnce();
    expect(killTree).toHaveBeenCalledWith(7777);
  });

  it('skips tree termination while the pid is still unknown', () => {
    const killTree = vi.fn();
    const { session } = startSession(killTree);
    ptyHarness.forceNextPid(0);

    session.start();
    const terminal = ptyHarness.processes[0]!;
    expect(terminal.pid).toBe(0);

    session.stop();

    expect(terminal.kill).toHaveBeenCalledOnce();
    expect(killTree).not.toHaveBeenCalled();
  });
});
