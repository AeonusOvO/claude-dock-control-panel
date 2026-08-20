import { describe, expect, it, vi } from 'vitest';
import { ManagedChatGptGlobalSetupCoordinator } from '../../src/main/claude/managed-chatgpt-setup';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe('ManagedChatGptGlobalSetupCoordinator', () => {
  it('shares the same main-process transaction across repeated IPC requests', async () => {
    const coordinator = new ManagedChatGptGlobalSetupCoordinator<string>();
    const gate = deferred<string>();
    const firstOperation = vi.fn(() => gate.promise);
    const duplicateOperation = vi.fn(async () => 'duplicate');

    const first = coordinator.run(firstOperation);
    const duplicate = coordinator.run(duplicateOperation);

    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(duplicateOperation).not.toHaveBeenCalled();

    gate.resolve('ready');
    await expect(Promise.all([first, duplicate])).resolves.toEqual(['ready', 'ready']);
  });

  it('allows a new transaction after the shared request succeeds', async () => {
    const coordinator = new ManagedChatGptGlobalSetupCoordinator<number>();
    const operation = vi.fn(async () => operation.mock.calls.length);

    await expect(coordinator.run(operation)).resolves.toBe(1);
    await expect(coordinator.run(operation)).resolves.toBe(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('allows a new transaction after the shared request rejects', async () => {
    const coordinator = new ManagedChatGptGlobalSetupCoordinator<string>();
    const gate = deferred<string>();
    const firstOperation = vi.fn(() => gate.promise);

    const first = coordinator.run(firstOperation);
    const duplicate = coordinator.run(async () => 'duplicate');
    gate.reject(new Error('setup failed'));

    await expect(first).rejects.toThrow('setup failed');
    await expect(duplicate).rejects.toThrow('setup failed');
    await expect(coordinator.run(async () => 'retried')).resolves.toBe('retried');
    expect(firstOperation).toHaveBeenCalledTimes(1);
  });
});
