import { describe, expect, it, vi } from 'vitest';
import { BackgroundTaskCoordinator } from '../src/main/background-task-coordinator';

const deferred = <T>() => {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve: (value: T): void => resolve?.(value),
  };
};

describe('BackgroundTaskCoordinator', () => {
  it('limits concurrency and coalesces work with the same key', async () => {
    const coordinator = new BackgroundTaskCoordinator(2);
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const firstOperation = vi.fn(() => firstGate.promise);
    const secondOperation = vi.fn(() => secondGate.promise);
    const queuedOperation = vi.fn(async () => 'third');

    const first = coordinator.run('first', 'background', firstOperation);
    const duplicate = coordinator.run('first', 'interactive', firstOperation);
    const second = coordinator.run('second', 'background', secondOperation);
    const third = coordinator.run('third', 'background', queuedOperation);
    await Promise.resolve();

    expect(first).toBe(duplicate);
    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(secondOperation).toHaveBeenCalledTimes(1);
    expect(queuedOperation).not.toHaveBeenCalled();

    firstGate.resolve('first');
    await expect(first).resolves.toBe('first');
    await Promise.resolve();
    expect(queuedOperation).toHaveBeenCalledTimes(1);
    secondGate.resolve('second');
    await expect(Promise.all([duplicate, second, third])).resolves.toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('starts queued interactive work before older background work', async () => {
    const coordinator = new BackgroundTaskCoordinator(1);
    const gate = deferred<void>();
    const order: string[] = [];
    const running = coordinator.run('running', 'background', async () => {
      order.push('running');
      await gate.promise;
    });
    const background = coordinator.run('background', 'background', async () => {
      order.push('background');
    });
    const interactive = coordinator.run('interactive', 'interactive', async () => {
      order.push('interactive');
    });
    await Promise.resolve();

    gate.resolve();
    await running;
    await interactive;
    await background;
    expect(order).toEqual(['running', 'interactive', 'background']);
  });
});
