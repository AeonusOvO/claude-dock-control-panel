import { describe, expect, it, vi } from 'vitest';
import { runProcess } from '../../src/main/infra/windows-command';

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Windows command streaming', () => {
  it('forwards complete output and removes the abort listener after success', async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const onLine = vi.fn();
    const output = await runProcess(
      process.execPath,
      [
        '-e',
        "process.stdout.write('first\\nsec'); process.stdout.write('ond\\n'); process.stderr.write('warning');",
      ],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      { maxBuffer: 64 * 1024, onLine, signal: controller.signal, timeout: 10_000 },
    );

    expect(output.stdout).toBe('first\nsecond\n');
    expect(output.stderr).toBe('warning');
    expect(onLine).toHaveBeenCalledWith('first', 'stdout');
    expect(onLine).toHaveBeenCalledWith('second', 'stdout');
    expect(onLine).toHaveBeenCalledWith('warning', 'stderr');
    const abortListener = addEventListener.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(abortListener).toBeDefined();
    expect(removeEventListener).toHaveBeenCalledWith('abort', abortListener);
  });

  it('rejects a pre-aborted command without spawning the requested executable', async () => {
    const controller = new AbortController();
    const abortError = new Error('already obsolete');
    controller.abort(abortError);

    await expect(
      runProcess(
        'definitely-not-a-real-executable.exe',
        [],
        { ...process.env },
        { signal: controller.signal },
      ),
    ).rejects.toBe(abortError);
  });

  it('kills a pending fixed process and removes its abort listener', async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const abortError = new Error('obsolete preflight');
    let childPid: number | undefined;
    const operation = runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(`ready:${process.pid}\\n`); setInterval(() => {}, 1_000);'],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      {
        maxBuffer: 64 * 1024,
        onLine: (line, stream) => {
          if (stream === 'stdout' && line.startsWith('ready:')) {
            childPid = Number(line.slice('ready:'.length));
          }
        },
        signal: controller.signal,
        timeout: 10_000,
      },
    );
    const outcome = operation.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );

    try {
      await vi.waitFor(() => expect(childPid).toBeTypeOf('number'));
      const startedPid = childPid as number;
      expect(processIsRunning(startedPid)).toBe(true);

      controller.abort(abortError);

      expect(await outcome).toEqual({ error: abortError, ok: false });
      const abortListener = addEventListener.mock.calls.find(([type]) => type === 'abort')?.[1];
      expect(abortListener).toBeDefined();
      expect(removeEventListener).toHaveBeenCalledWith('abort', abortListener);
      expect(processIsRunning(startedPid)).toBe(false);
    } finally {
      controller.abort();
      if (childPid && processIsRunning(childPid)) {
        process.kill(childPid);
      }
    }
  });

  it('preserves an exact frozen abort reason through process cleanup', async () => {
    const controller = new AbortController();
    const abortError = Object.freeze(new Error('frozen authoritative reason'));
    let childPid: number | undefined;
    const operation = runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(`ready:${process.pid}\n`); setInterval(() => {}, 1_000);'],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      {
        onLine: (line, stream) => {
          if (stream === 'stdout' && line.startsWith('ready:')) {
            childPid = Number(line.slice('ready:'.length));
          }
        },
        signal: controller.signal,
        timeout: 10_000,
      },
    );

    try {
      await vi.waitFor(() => expect(childPid).toBeTypeOf('number'));
      controller.abort(abortError);

      await expect(operation).rejects.toBe(abortError);
      expect(processIsRunning(childPid as number)).toBe(false);
    } finally {
      controller.abort();
      if (childPid && processIsRunning(childPid)) process.kill(childPid);
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'kills inherited-handle descendants after their root wrapper has already exited',
    async () => {
      const controller = new AbortController();
      const abortError = new Error('obsolete exited-root process tree');
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      let descendantReady = false;
      const operation = runProcess(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            `const child = spawn(process.execPath, ['-e', "process.stdout.write('descendant-ready\\\\n'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
            'process.stdout.write(`ready:${process.pid}:${child.pid}\\n`);',
            'setTimeout(() => process.exit(0), 200);',
          ].join(' '),
        ],
        { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        {
          maxBuffer: 64 * 1024,
          onLine: (line, stream) => {
            if (stream !== 'stdout') return;
            if (line === 'descendant-ready') {
              descendantReady = true;
              return;
            }
            if (!line.startsWith('ready:')) return;
            const [, parent, descendant] = line.split(':');
            parentPid = Number(parent);
            descendantPid = Number(descendant);
          },
          signal: controller.signal,
          timeout: 10_000,
        },
      );
      let settled = false;
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      try {
        await vi.waitFor(() => {
          expect(parentPid).toBeTypeOf('number');
          expect(descendantPid).toBeTypeOf('number');
          expect(descendantReady).toBe(true);
        });
        await vi.waitFor(() => expect(processIsRunning(parentPid as number)).toBe(false));
        expect(processIsRunning(descendantPid as number)).toBe(true);
        expect(settled).toBe(false);

        controller.abort(abortError);

        await expect(operation).rejects.toBe(abortError);
        await vi.waitFor(() => expect(processIsRunning(descendantPid as number)).toBe(false), {
          timeout: 2_000,
        });
      } finally {
        controller.abort();
        for (const pid of [descendantPid, parentPid]) {
          if (pid && processIsRunning(pid)) process.kill(pid);
        }
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'waits for the exact Windows process tree to terminate before cancellation settles',
    async () => {
      const controller = new AbortController();
      const abortError = new Error('obsolete process tree');
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      const operation = runProcess(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            'process.stdout.write(`ready:${process.pid}:${child.pid}\\n`);',
            'setInterval(() => {}, 1000);',
          ].join(' '),
        ],
        { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        {
          maxBuffer: 64 * 1024,
          onLine: (line, stream) => {
            if (stream !== 'stdout' || !line.startsWith('ready:')) return;
            const [, parent, descendant] = line.split(':');
            parentPid = Number(parent);
            descendantPid = Number(descendant);
          },
          signal: controller.signal,
          timeout: 10_000,
        },
      );

      try {
        await vi.waitFor(() => {
          expect(parentPid).toBeTypeOf('number');
          expect(descendantPid).toBeTypeOf('number');
        });
        expect(processIsRunning(parentPid as number)).toBe(true);
        expect(processIsRunning(descendantPid as number)).toBe(true);

        controller.abort(abortError);

        await expect(operation).rejects.toBe(abortError);
        expect(processIsRunning(parentPid as number)).toBe(false);
        expect(processIsRunning(descendantPid as number)).toBe(false);
      } finally {
        controller.abort();
        for (const pid of [descendantPid, parentPid]) {
          if (pid && processIsRunning(pid)) process.kill(pid);
        }
      }
    },
  );
});
