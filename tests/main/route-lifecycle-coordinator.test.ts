import { describe, expect, it } from 'vitest';
import { RouteLifecycleCoordinator } from '../../src/main/coordination/route-lifecycle';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('RouteLifecycleCoordinator', () => {
  it('rechecks reservations after an asynchronous service inspection', async () => {
    const coordinator = new RouteLifecycleCoordinator();
    const inspected = deferred();
    const continueInspection = deferred<boolean>();
    let stops = 0;

    const staleStop = coordinator.stopWhenUnused({
      hasActiveUser: () => false,
      isServiceRunning: async () => {
        inspected.resolve();
        return continueInspection.promise;
      },
      routeKind: 'ccr',
      stop: async () => {
        stops += 1;
      },
    });

    await inspected.promise;
    const reservation = coordinator.reserve('session-new', 'ccr');
    continueInspection.resolve(true);

    await expect(staleStop).resolves.toBe(false);
    expect(stops).toBe(0);

    expect(coordinator.release(reservation)).toBe(true);
    await expect(
      coordinator.stopWhenUnused({
        hasActiveUser: () => false,
        isServiceRunning: async () => true,
        routeKind: 'ccr',
        stop: async () => {
          stops += 1;
        },
      }),
    ).resolves.toBe(true);
    expect(stops).toBe(1);
  });

  it('keeps route preparation behind a stop that already owns the lifecycle', async () => {
    const coordinator = new RouteLifecycleCoordinator();
    const stopEntered = deferred();
    const releaseStop = deferred();
    let prepareEntered = false;

    const stop = coordinator.stopWhenUnused({
      hasActiveUser: () => false,
      isServiceRunning: async () => true,
      routeKind: 'managed-chatgpt',
      stop: async () => {
        stopEntered.resolve();
        await releaseStop.promise;
      },
    });
    await stopEntered.promise;

    coordinator.reserve('session-new', 'managed-chatgpt');
    const prepare = coordinator.runExclusive(async () => {
      prepareEntered = true;
    });
    await Promise.resolve();
    expect(prepareEntered).toBe(false);

    releaseStop.resolve();
    await stop;
    await prepare;
    expect(prepareEntered).toBe(true);
  });

  it('does not let an old reservation release a newer generation', () => {
    const coordinator = new RouteLifecycleCoordinator();
    const first = coordinator.reserve('session-a', 'ccr');
    const second = coordinator.reserve('session-a', 'managed-chatgpt');

    expect(coordinator.release(first)).toBe(false);
    expect(coordinator.hasReservation('managed-chatgpt')).toBe(true);
    expect(coordinator.release(second)).toBe(true);
    expect(coordinator.hasReservation('managed-chatgpt')).toBe(false);
  });
});
