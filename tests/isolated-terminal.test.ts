import { describe, expect, it, vi } from 'vitest';
import { IsolatedTerminal } from '../src/main/isolated-terminal';

describe('isolated terminal', () => {
  it('models a workspace slot without accepting terminal bytes or exposing a pid', () => {
    const onStatus = vi.fn();
    const terminal = new IsolatedTerminal('session-1', 'D:\\Fixture', '对话 1', onStatus);

    const running = terminal.start();
    expect(running).toMatchObject({
      cwd: 'D:\\Fixture',
      phase: 'running',
      ptyGeneration: 1,
      shell: 'Isolated fixture',
    });
    expect(running.pid).toBeUndefined();
    expect(terminal.write(running.ptyGeneration, 'whoami\r')).toBe(false);
    expect(terminal.resize(120, 40)).toEqual({ cols: 120, rows: 40 });
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects stale generation stops and advances the generation on restart', () => {
    const terminal = new IsolatedTerminal('session-1', 'D:\\Fixture', '对话 1', vi.fn());
    const first = terminal.start();
    expect(terminal.stopIfGeneration(first.ptyGeneration - 1)).toBeUndefined();
    expect(terminal.restart().ptyGeneration).toBe(first.ptyGeneration + 1);
  });
});
