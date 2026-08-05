import { describe, expect, it } from 'vitest';
import { SessionOperationCoordinator } from '../src/main/session-operation-coordinator';

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
