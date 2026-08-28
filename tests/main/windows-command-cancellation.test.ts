import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runProcess } from '../../src/main/infra/windows-command';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const processFixture = (pid: number) =>
  Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: vi.fn(() => true),
    pid,
    signalCode: null,
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  });

describe('Windows command cancellation race', () => {
  it.skipIf(process.platform !== 'win32')(
    'cleans descendants when the root exits before taskkill can reach it',
    async () => {
      const root = processFixture(1234);
      const taskkill = processFixture(2345);
      const cleanup = processFixture(3456);
      vi.mocked(spawn).mockImplementation((executable) => {
        if (executable === 'fixture.exe') return root as unknown as ReturnType<typeof spawn>;
        if (executable === 'taskkill.exe') {
          root.exitCode = 0;
          queueMicrotask(() => taskkill.emit('close', 128, null));
          return taskkill as unknown as ReturnType<typeof spawn>;
        }
        if (executable === 'powershell.exe') {
          queueMicrotask(() => {
            root.stdout.end();
            root.stderr.end();
            root.emit('close', 0, null);
            cleanup.emit('close', 0, null);
          });
          return cleanup as unknown as ReturnType<typeof spawn>;
        }
        throw new Error('Unexpected process');
      });
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const operation = runProcess('fixture.exe', [], {}, { signal: controller.signal });
      controller.abort(reason);
      await expect(operation).rejects.toBe(reason);
      expect(vi.mocked(spawn).mock.calls.map(([command]) => command)).toEqual([
        'fixture.exe',
        'taskkill.exe',
        'powershell.exe',
      ]);
      expect(reason).toMatchObject({
        termination: {
          cleanupTimedOut: false,
          directKillAttempted: false,
          exitedRootCleanupAttempted: true,
          treeKillCode: 0,
          treeKillTimedOut: false,
        },
      });
    },
  );
});
