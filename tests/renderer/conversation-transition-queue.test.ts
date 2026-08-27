import { describe, expect, it, vi } from 'vitest';
import {
  ConversationTransitionQueue,
  resolveConversationTransitionConcurrency,
} from '../../src/renderer/features/projects/conversation-transition-queue';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe('conversation transition queue', () => {
  it.each([
    [1, 1],
    [2, 1],
    [4, 2],
    [8, 4],
    [12, 6],
    [32, 8],
  ])('derives a bounded device threshold from %i logical processors', (processors, expected) => {
    expect(resolveConversationTransitionConcurrency(processors)).toBe(expected);
  });

  it('runs up to the threshold concurrently and admits overflow FIFO', async () => {
    const queue = new ConversationTransitionQueue(2);
    const first = deferred<string>();
    const second = deferred<string>();
    const order: string[] = [];
    const states = [vi.fn(), vi.fn(), vi.fn()];

    const one = queue.enqueue(async () => {
      order.push('start-1');
      return first.promise;
    }, states[0]!);
    const two = queue.enqueue(async () => {
      order.push('start-2');
      return second.promise;
    }, states[1]!);
    const three = queue.enqueue(async () => {
      order.push('start-3');
      return 'three';
    }, states[2]!);

    await Promise.resolve();
    expect(order).toEqual(['start-1', 'start-2']);
    expect(states[2]).toHaveBeenLastCalledWith({ phase: 'queued', position: 1, total: 1 });

    first.resolve('one');
    await expect(one.result).resolves.toEqual({ status: 'completed', value: 'one' });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start-1', 'start-2', 'start-3']);
    await expect(three.result).resolves.toEqual({ status: 'completed', value: 'three' });
    second.resolve('two');
    await expect(two.result).resolves.toEqual({ status: 'completed', value: 'two' });
  });

  it('cancels an exact waiting task without starting it and compacts later positions', async () => {
    const queue = new ConversationTransitionQueue(1);
    const running = deferred<void>();
    const secondState = vi.fn();
    const thirdState = vi.fn();
    const first = queue.enqueue(() => running.promise, vi.fn());
    const secondOperation = vi.fn(async () => 'second');
    const second = queue.enqueue(secondOperation, secondState);
    const third = queue.enqueue(async () => 'third', thirdState);

    await Promise.resolve();
    expect(secondState).toHaveBeenLastCalledWith({ phase: 'queued', position: 1, total: 2 });
    expect(thirdState).toHaveBeenLastCalledWith({ phase: 'queued', position: 2, total: 2 });
    expect(second.cancel()).toBe(true);
    await expect(second.result).resolves.toEqual({ status: 'cancelled' });
    expect(secondOperation).not.toHaveBeenCalled();
    expect(thirdState).toHaveBeenLastCalledWith({ phase: 'queued', position: 1, total: 1 });

    running.resolve();
    await first.result;
    await expect(third.result).resolves.toEqual({ status: 'completed', value: 'third' });
  });
});
