import { describe, expect, it } from 'vitest';
import { SessionOperationCoordinator } from '../../src/main/coordination/session-operation';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('SessionOperationCoordinator', () => {
  it('keeps an invalidated lease exclusive until the cancelled callback unwinds', async () => {
    const sessions = new Set(['session-a']);
    const coordinator = new SessionOperationCoordinator((sessionId) => sessions.has(sessionId));
    const entered = deferred();
    const continueOperation = deferred();
    const first = coordinator.run('session-a', async (assertCurrent) => {
      entered.resolve();
      await continueOperation.promise;
      assertCurrent();
    });
    await entered.promise;

    const cancelled = coordinator.invalidateAndWait('session-a');
    let cancellationSettled = false;
    void cancelled.then(() => {
      cancellationSettled = true;
    });

    expect(coordinator.isBusy('session-a')).toBe(true);
    expect(cancellationSettled).toBe(false);
    await expect(coordinator.run('session-a', async () => undefined)).rejects.toThrow('尚未完成');

    continueOperation.resolve();
    await expect(first).rejects.toThrow('已被新的终端或会话操作取消');
    await cancelled;
    expect(cancellationSettled).toBe(true);
    expect(coordinator.isBusy('session-a')).toBe(false);
    await expect(coordinator.run('session-a', async () => 'replacement')).resolves.toBe(
      'replacement',
    );
  });

  it('reserves a latest-intent replacement before cancelled cleanup unwinds', async () => {
    const coordinator = new SessionOperationCoordinator(() => true);
    const firstEntered = deferred();
    const cleanupEntered = deferred();
    const releaseCleanup = deferred();
    const replacementEntered = deferred();
    const releaseReplacement = deferred();

    const first = coordinator.run('session-a', async (assertCurrent, signal) => {
      firstEntered.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      try {
        assertCurrent();
      } finally {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      }
    });
    await firstEntered.promise;

    const replacement = coordinator.runLatest('session-a', async (assertCurrent) => {
      assertCurrent();
      replacementEntered.resolve();
      await releaseReplacement.promise;
      assertCurrent();
      return 'replacement';
    });
    await cleanupEntered.promise;
    let replacementStarted = false;
    void replacementEntered.promise.then(() => {
      replacementStarted = true;
    });
    await Promise.resolve();
    expect(replacementStarted).toBe(false);
    expect(coordinator.isBusy('session-a')).toBe(true);
    await expect(coordinator.run('session-a', async () => undefined)).rejects.toThrow('尚未完成');

    releaseCleanup.resolve();
    await expect(first).rejects.toThrow('已被新的终端或会话操作取消');
    await replacementEntered.promise;
    expect(coordinator.isBusy('session-a')).toBe(true);
    releaseReplacement.resolve();
    await expect(replacement).resolves.toBe('replacement');
    expect(coordinator.isBusy('session-a')).toBe(false);
  });

  it('aborts a lease synchronously but waits for cancelled cleanup to unwind', async () => {
    const coordinator = new SessionOperationCoordinator(() => true);
    const entered = deferred();
    const cleanupEntered = deferred();
    const releaseCleanup = deferred();
    let observedSignal: AbortSignal | undefined;

    const operation = coordinator.run('session-a', async (assertCurrent, signal) => {
      observedSignal = signal;
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      });
      entered.resolve();
      await aborted;
      try {
        assertCurrent();
      } finally {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      }
    });
    await entered.promise;

    const unwound = coordinator.invalidateAndWait('session-a');
    expect(observedSignal?.aborted).toBe(true);
    await cleanupEntered.promise;
    let unwoundSettled = false;
    void unwound.then(() => {
      unwoundSettled = true;
    });
    await Promise.resolve();
    expect(unwoundSettled).toBe(false);
    await expect(coordinator.run('session-a', async () => undefined)).rejects.toThrow('尚未完成');

    releaseCleanup.resolve();
    await expect(operation).rejects.toThrow('已被新的终端或会话操作取消');
    await unwound;
    expect(unwoundSettled).toBe(true);
  });

  it('makes repeated invalidation idempotent for one abort reason and completion barrier', async () => {
    const coordinator = new SessionOperationCoordinator(() => true);
    const entered = deferred();
    let abortEvents = 0;
    let abortReason: unknown;

    const operation = coordinator.run('session-a', async (assertCurrent, signal) => {
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            abortEvents += 1;
            abortReason = signal.reason;
            resolve();
          },
          { once: true },
        );
      });
      entered.resolve();
      await aborted;
      assertCurrent();
    });
    await entered.promise;

    const first = coordinator.invalidateAndWait('session-a');
    coordinator.invalidate('session-a');
    const second = coordinator.invalidateAndWait('session-a');

    expect(first).toBe(second);
    expect(abortEvents).toBe(1);
    expect(abortReason).toBeInstanceOf(Error);
    await expect(operation).rejects.toBe(abortReason);
    await expect(first).resolves.toBeUndefined();
  });

  it('cancels only the lease that owns the exact operation signal', async () => {
    const coordinator = new SessionOperationCoordinator(() => true);
    const entered = deferred<AbortSignal>();
    const operation = coordinator.run('session-a', async (assertCurrent, signal) => {
      entered.resolve(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      assertCurrent();
    });
    const ownedSignal = await entered.promise;

    await expect(
      coordinator.invalidateAndWaitIfSignal('session-a', new AbortController().signal),
    ).resolves.toBe(false);
    expect(ownedSignal.aborted).toBe(false);
    expect(coordinator.isBusy('session-a')).toBe(true);

    const cancelled = coordinator.invalidateAndWaitIfSignal('session-a', ownedSignal);
    expect(ownedSignal.aborted).toBe(true);
    await expect(operation).rejects.toThrow('已被新的终端或会话操作取消');
    await expect(cancelled).resolves.toBe(true);
    expect(coordinator.isBusy('session-a')).toBe(false);
  });

  it('invalidates an operation when its workspace session disappears', async () => {
    const sessions = new Set(['session-a']);
    const coordinator = new SessionOperationCoordinator((sessionId) => sessions.has(sessionId));

    await expect(
      coordinator.run('session-a', async (assertCurrent) => {
        sessions.delete('session-a');
        assertCurrent();
      }),
    ).rejects.toThrow('已被新的终端或会话操作取消');
  });

  it('allows independent sessions to run concurrently', async () => {
    const coordinator = new SessionOperationCoordinator(() => true);
    const releaseA = deferred();
    const releaseB = deferred();
    const operationA = coordinator.run('session-a', async () => {
      await releaseA.promise;
      return 'a';
    });
    const operationB = coordinator.run('session-b', async () => {
      await releaseB.promise;
      return 'b';
    });

    expect(coordinator.isBusy('session-a')).toBe(true);
    expect(coordinator.isBusy('session-b')).toBe(true);
    releaseB.resolve();
    await expect(operationB).resolves.toBe('b');
    expect(coordinator.isBusy('session-a')).toBe(true);
    releaseA.resolve();
    await expect(operationA).resolves.toBe('a');
  });
});
