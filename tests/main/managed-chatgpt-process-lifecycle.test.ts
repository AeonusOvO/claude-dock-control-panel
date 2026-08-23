import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedGatewayProcessLifecycle } from '../../src/main/claude/managed-chatgpt-process-lifecycle';

interface MutableTestChild {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  signalCode: NodeJS.Signals | null;
}

const testChild = (processId: number): MutableTestChild & ChildProcess =>
  ({
    exitCode: null,
    kill: vi.fn(() => true),
    pid: processId,
    signalCode: null,
  }) as unknown as MutableTestChild & ChildProcess;

const createLifecycle = (portAvailable = vi.fn(async () => true)) => {
  const invalidateModels = vi.fn();
  const onExactProcessExit = vi.fn();
  const lifecycle = new ManagedGatewayProcessLifecycle({
    invalidateModels,
    onExactProcessExit,
    portAvailable,
  });
  return { invalidateModels, lifecycle, onExactProcessExit, portAvailable };
};

const startChild = (
  lifecycle: ManagedGatewayProcessLifecycle,
  child: ChildProcess,
  suffix: string,
) =>
  lifecycle.start(child, {
    configSignature: `config-${suffix}`,
    environmentSignature: `environment-${suffix}`,
    executablePath: `C:\\gateway-${suffix}.exe`,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('managed ChatGPT gateway process replacement barrier', () => {
  it('waits for the exact delayed child exit before allowing replacement', async () => {
    vi.useFakeTimers();
    const { lifecycle, onExactProcessExit, portAvailable } = createLifecycle();
    const child = testChild(42);
    startChild(lifecycle, child, 'old');

    const stopped = lifecycle.stopForReplacement(8317, 'replacement barrier timed out');
    expect(child.kill).toHaveBeenCalledOnce();
    expect(lifecycle.activeProcess()).toBeUndefined();
    expect(portAvailable).not.toHaveBeenCalled();

    child.exitCode = 0;
    await vi.advanceTimersByTimeAsync(100);

    await expect(stopped).resolves.toBeUndefined();
    expect(portAvailable).toHaveBeenCalledWith(8317, expect.any(Number));
    expect(onExactProcessExit).toHaveBeenCalledWith(42);
    expect(lifecycle.currentOwnership()).toBeUndefined();
  });

  it('keeps waiting when the child exited but its port remains held', async () => {
    vi.useFakeTimers();
    const portAvailable = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { lifecycle } = createLifecycle(portAvailable);
    const child = testChild(42);
    startChild(lifecycle, child, 'old');
    let settled = false;

    const stopped = lifecycle
      .stopForReplacement(8317, 'replacement barrier timed out')
      .finally(() => {
        settled = true;
      });
    child.signalCode = 'SIGTERM';
    await vi.advanceTimersByTimeAsync(100);

    expect(portAvailable).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await expect(stopped).resolves.toBeUndefined();
    expect(portAvailable).toHaveBeenCalledTimes(2);
  });

  it('times out without making a still-owned stopping child active again', async () => {
    vi.useFakeTimers();
    const { lifecycle, onExactProcessExit, portAvailable } = createLifecycle();
    const child = testChild(42);
    const ownership = startChild(lifecycle, child, 'old');

    const stopped = lifecycle.stopForReplacement(8317, 'replacement barrier timed out');
    const rejection = expect(stopped).rejects.toThrow('replacement barrier timed out');
    await vi.advanceTimersByTimeAsync(2_100);

    await rejection;
    expect(lifecycle.activeProcess()).toBeUndefined();
    expect(lifecycle.currentOwnership()).toEqual(ownership);
    expect(portAvailable).not.toHaveBeenCalled();
    expect(onExactProcessExit).not.toHaveBeenCalled();
  });

  it('rejects stale child completion without clearing a replacement generation', async () => {
    vi.useFakeTimers();
    const { lifecycle, onExactProcessExit } = createLifecycle();
    const oldChild = testChild(42);
    const oldOwnership = startChild(lifecycle, oldChild, 'old');
    const stopped = lifecycle.stopForReplacement(8317, 'stale child barrier');
    const rejection = expect(stopped).rejects.toThrow('stale child barrier');

    expect(lifecycle.clear(oldOwnership)).toBe(true);
    const replacement = testChild(42);
    const replacementOwnership = startChild(lifecycle, replacement, 'replacement');
    oldChild.exitCode = 0;
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    lifecycle.complete(oldOwnership);
    expect(lifecycle.currentOwnership()).toEqual(replacementOwnership);
    expect(lifecycle.activeProcess()).toBe(replacement);
    expect(onExactProcessExit).not.toHaveBeenCalled();
  });

  it('bounds a never-settling injected port probe inside the replacement deadline', async () => {
    vi.useFakeTimers();
    const portAvailable = vi.fn(() => new Promise<boolean>(() => {}));
    const { lifecycle } = createLifecycle(portAvailable);
    const child = testChild(42);
    startChild(lifecycle, child, 'old');

    const stopped = lifecycle.stopForReplacement(8317, 'bounded barrier timed out');
    const rejection = expect(stopped).rejects.toThrow('bounded barrier timed out');
    child.exitCode = 0;
    await vi.advanceTimersByTimeAsync(2_100);

    await rejection;
    expect(portAvailable).toHaveBeenCalledWith(8317, expect.any(Number));
    expect(lifecycle.currentOwnership()?.processId).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks ownership after an awaited final port probe', async () => {
    vi.useFakeTimers();
    const { lifecycle, portAvailable } = createLifecycle();
    const oldChild = testChild(42);
    const oldOwnership = startChild(lifecycle, oldChild, 'old');
    const replacement = testChild(43);
    let replacementOwnership: ReturnType<typeof startChild> | undefined;
    portAvailable.mockImplementation(async () => {
      expect(lifecycle.clear(oldOwnership)).toBe(true);
      replacementOwnership = startChild(lifecycle, replacement, 'replacement');
      return true;
    });

    const stopped = lifecycle.stopForReplacement(8317, 'ownership changed');
    const rejection = expect(stopped).rejects.toThrow('ownership changed');
    oldChild.exitCode = 0;
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(lifecycle.currentOwnership()).toEqual(replacementOwnership);
    expect(lifecycle.activeProcess()).toBe(replacement);
  });

  it('keeps exact degraded ownership when signal delivery throws', async () => {
    vi.useFakeTimers();
    const { lifecycle } = createLifecycle();
    const child = testChild(42);
    child.kill.mockImplementation(() => {
      throw new Error('injected kill failure');
    });
    const ownership = startChild(lifecycle, child, 'kill-failure');

    const stopped = lifecycle.stopForReplacement(8317, 'child still alive');
    const rejection = expect(stopped).rejects.toThrow('child still alive');
    await vi.advanceTimersByTimeAsync(2_100);

    await rejection;
    expect(lifecycle.currentOwnership()).toEqual(ownership);
    expect(lifecycle.activeProcess()).toBeUndefined();
  });

  it('signals shutdown synchronously without waiting for exit or port release', () => {
    vi.useFakeTimers();
    const { lifecycle, portAvailable } = createLifecycle();
    const child = testChild(42);
    const ownership = startChild(lifecycle, child, 'shutdown');

    expect(lifecycle.stop()).toEqual(ownership);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(lifecycle.activeProcess()).toBeUndefined();
    expect(lifecycle.currentOwnership()).toEqual(ownership);
    expect(portAvailable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
