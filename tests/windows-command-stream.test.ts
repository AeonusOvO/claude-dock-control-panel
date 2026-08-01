import { describe, expect, it, vi } from 'vitest';
import { runProcess } from '../src/main/windows-command';

describe('Windows command streaming', () => {
  it('forwards complete stdout and stderr lines while preserving buffered output', async () => {
    const onLine = vi.fn();
    const output = await runProcess(
      process.execPath,
      [
        '-e',
        "process.stdout.write('first\\nsec'); process.stdout.write('ond\\n'); process.stderr.write('warning');",
      ],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      { maxBuffer: 64 * 1024, onLine, timeout: 10_000 },
    );

    expect(output.stdout).toBe('first\nsecond\n');
    expect(output.stderr).toBe('warning');
    expect(onLine).toHaveBeenCalledWith('first', 'stdout');
    expect(onLine).toHaveBeenCalledWith('second', 'stdout');
    expect(onLine).toHaveBeenCalledWith('warning', 'stderr');
  });
});
