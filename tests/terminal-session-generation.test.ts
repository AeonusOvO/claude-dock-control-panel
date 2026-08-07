import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSession } from '../src/main/terminal-session';
import type { PtyGeneration, TerminalStatus } from '../src/shared/contracts';

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
      pid: nextPid++,
      process: 'powershell.exe',
      resize: vi.fn(),
      rows: 30,
      write: vi.fn(),
    } as unknown as ControlledPty;
    processes.push(terminal);
    return terminal;
  });

  return { processes, spawn };
});

vi.mock('@lydell/node-pty', () => ({
  spawn: ptyHarness.spawn,
}));

beforeEach(() => {
  ptyHarness.processes.splice(0);
  ptyHarness.spawn.mockClear();
});

describe('TerminalSession PTY generation ownership', () => {
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
