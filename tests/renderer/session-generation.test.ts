import { describe, expect, it } from 'vitest';
import {
  orchestrateSessionOperation,
  OwnedOperationRegistry,
  OwnedSessionOperationRegistry,
  SessionGenerationRegistry,
} from '../../src/renderer/platform/session-generation';

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let reject = (_reason?: unknown): void => undefined;
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

describe('per-session asynchronous generations', () => {
  it('couples visible operation copy to the exact session generation', () => {
    const registry = new OwnedSessionOperationRegistry<'install' | 'update'>();
    const stale = registry.begin('session-a', 'install');
    const current = registry.begin('session-a', 'update');
    const independent = registry.begin('session-b', 'install');

    expect(registry.current('session-a')).toBe(current);
    expect(registry.current('session-b')).toBe(independent);
    expect(registry.finish(stale)).toBe(false);
    expect(registry.current('session-a')?.operation).toBe('update');
    expect(registry.finish(current)).toBe(true);
    expect(registry.isActive('session-a')).toBe(false);
  });

  it('lets one application-global operation owner fence every session', () => {
    const registry = new OwnedOperationRegistry<'install' | 'logout'>();
    const stale = registry.begin('session-a', 'install');
    const current = registry.begin('session-b', 'logout');

    expect(registry.current()).toBe(current);
    expect(registry.isActive()).toBe(true);
    expect(registry.finish(stale)).toBe(false);
    expect(registry.isCurrent(current)).toBe(true);
    expect(registry.finish(current)).toBe(true);
    expect(registry.isActive()).toBe(false);
  });

  it('allows independent sessions to settle in either order', async () => {
    const registry = new SessionGenerationRegistry();
    const first = deferred<string>();
    const second = deferred<string>();
    const applied = new Map<string, string>();

    const load = async (sessionId: string, request: Deferred<string>): Promise<void> => {
      const token = registry.begin(sessionId);
      const value = await request.promise;
      if (registry.finish(token)) {
        applied.set(sessionId, value);
      }
    };

    const firstLoad = load('session-a', first);
    const secondLoad = load('session-b', second);
    second.resolve('new-b');
    await secondLoad;
    first.resolve('new-a');
    await firstLoad;

    expect(applied).toEqual(
      new Map([
        ['session-b', 'new-b'],
        ['session-a', 'new-a'],
      ]),
    );
  });

  it('drops an older same-session response and rejection after a newer request begins', async () => {
    const registry = new SessionGenerationRegistry();
    const oldResponse = deferred<string>();
    const newResponse = deferred<string>();
    const oldRejection = deferred<string>();
    const newAfterRejection = deferred<string>();
    const applied: string[] = [];
    const errors: string[] = [];

    const load = async (request: Deferred<string>): Promise<void> => {
      const token = registry.begin('session-a');
      try {
        const value = await request.promise;
        if (registry.finish(token)) {
          applied.push(value);
        }
      } catch {
        if (registry.finish(token)) {
          errors.push('current rejection');
        }
      }
    };

    const oldLoad = load(oldResponse);
    const newLoad = load(newResponse);
    newResponse.resolve('new');
    await newLoad;
    oldResponse.resolve('old');
    await oldLoad;

    const rejectedLoad = load(oldRejection);
    const replacementLoad = load(newAfterRejection);
    newAfterRejection.resolve('newer');
    await replacementLoad;
    oldRejection.reject(new Error('stale'));
    await rejectedLoad;

    expect(applied).toEqual(['new', 'newer']);
    expect(errors).toEqual([]);
  });

  it('tombstones deleted sessions and prevents an old finally from clearing a replacement', async () => {
    const registry = new SessionGenerationRegistry();
    const oldCompletion = deferred<void>();
    const first = registry.begin('session-a');
    const completion = oldCompletion.promise.then(() => registry.finish(first));

    expect(registry.invalidate('session-a')).toEqual(first);
    const replacement = registry.begin('session-a');
    oldCompletion.resolve();

    await expect(completion).resolves.toBe(false);
    expect(registry.isCurrent(replacement)).toBe(true);
    expect(registry.finish(replacement)).toBe(true);
  });

  it('prunes only missing sessions', () => {
    const registry = new SessionGenerationRegistry();
    const removed = registry.begin('session-a');
    const retained = registry.begin('session-b');

    expect(registry.prune(new Set(['session-b']))).toEqual([removed]);
    expect(registry.isCurrent(retained)).toBe(true);
  });

  it('keeps an operation current after an independent lifecycle lock releases', async () => {
    const operations = new SessionGenerationRegistry();
    const lifecycle = new SessionGenerationRegistry();
    const request = deferred<{ active: boolean }>();
    const operation = operations.begin('session-a');
    const launch = lifecycle.begin('session-a');
    const applied: boolean[] = [];

    const completion = orchestrateSessionOperation({
      applyResult: (result) => {
        applied.push(result.active);
        return true;
      },
      registry: operations,
      start: () => request.promise,
      token: operation,
    });

    expect(lifecycle.finish(launch)).toBe(true);
    expect(operations.isCurrent(operation)).toBe(true);
    request.resolve({ active: true });

    await expect(completion).resolves.toEqual({
      result: { active: true },
      status: 'resolved',
    });
    expect(applied).toEqual([true]);
    expect(operations.finish(operation)).toBe(true);
  });

  it('waits for confirmation and reports an exact cancellation before starting', async () => {
    const registry = new SessionGenerationRegistry();
    const confirmation = deferred<boolean>();
    const operation = registry.begin('session-a');
    let cancelled = false;
    let started = false;

    const completion = orchestrateSessionOperation({
      applyResult: () => true,
      confirmation: () => confirmation.promise,
      onCancel: () => {
        cancelled = true;
      },
      registry,
      start: async () => {
        started = true;
        return 'unexpected';
      },
      token: operation,
    });

    expect(started).toBe(false);
    confirmation.resolve(false);

    await expect(completion).resolves.toEqual({ status: 'cancelled' });
    expect(cancelled).toBe(true);
    expect(started).toBe(false);
    expect(registry.finish(operation)).toBe(true);
  });
});
