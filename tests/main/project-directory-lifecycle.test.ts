import { describe, expect, it, vi } from 'vitest';
import {
  ProjectDirectoryLifecycleCoordinator,
  runOwnedProjectDirectoryClosure,
} from '../../src/main/coordination/project-directory-lifecycle';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe('ProjectDirectoryLifecycleCoordinator', () => {
  it('lets a newer reopen supersede a pending folder closure before destructive cleanup', async () => {
    const coordinator = new ProjectDirectoryLifecycleCoordinator();
    const cleanup = deferred();
    const closeRuntimeSession = vi.fn();
    const closeWorkspaceSession = vi.fn();
    const commit = vi.fn();
    const sessions = new Map([['session-1', 'D:\\Project Alpha']]);
    const closing = runOwnedProjectDirectoryClosure({
      captureSessionIds: () => ['session-1'],
      closeRuntimeSession,
      closeWorkspaceSession,
      commit,
      coordinator,
      cwd: 'D:\\Project Alpha',
      invalidateAndWait: () => cleanup.promise,
      isSessionInDirectory: (sessionId, cwd) =>
        sessions.get(sessionId)?.toLocaleLowerCase() === cwd.toLocaleLowerCase(),
      kind: 'forget',
      readState: () => [...sessions.keys()],
    });
    const rejection = expect(closing).rejects.toThrow(/取代/);

    coordinator.runOpenSync('d:\\project alpha', () => {
      sessions.set('session-2', 'D:\\Project Alpha');
    });
    cleanup.resolve();

    await rejection;
    expect(closeRuntimeSession).not.toHaveBeenCalled();
    expect(closeWorkspaceSession).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect([...sessions.keys()]).toEqual(['session-1', 'session-2']);
  });

  it('lets a later closure invalidate every older asynchronous open without conflating concurrent opens', async () => {
    const coordinator = new ProjectDirectoryLifecycleCoordinator();
    const firstGate = deferred();
    const secondGate = deferred();
    const firstOpen = coordinator.runOpen('D:\\Project Alpha', async (ownership) => {
      await firstGate.promise;
      ownership.assertCurrent();
      return 'first';
    });
    const secondOpen = coordinator.runOpen('d:\\project alpha', async (ownership) => {
      await secondGate.promise;
      ownership.assertCurrent();
      return 'second';
    });
    const firstRejection = expect(firstOpen).rejects.toThrow(/取代/);
    const secondRejection = expect(secondOpen).rejects.toThrow(/取代/);

    await coordinator.runClosure('D:\\Project Alpha', 'close', async (ownership) => {
      ownership.assertCurrent();
    });
    firstGate.resolve();
    secondGate.resolve();

    await Promise.all([firstRejection, secondRejection]);
  });

  it('allows independent concurrent opens when no closure supersedes them', async () => {
    const coordinator = new ProjectDirectoryLifecycleCoordinator();
    const firstGate = deferred();
    const secondGate = deferred();
    const firstOpen = coordinator.runOpen('D:\\Project Alpha', async (ownership) => {
      await firstGate.promise;
      ownership.assertCurrent();
      return 'first';
    });
    const secondOpen = coordinator.runOpen('d:\\project alpha', async (ownership) => {
      await secondGate.promise;
      ownership.assertCurrent();
      return 'second';
    });

    secondGate.resolve();
    firstGate.resolve();

    await expect(firstOpen).resolves.toBe('first');
    await expect(secondOpen).resolves.toBe('second');
  });

  it('cleans only the exact captured sessions after their operations unwind', async () => {
    const coordinator = new ProjectDirectoryLifecycleCoordinator();
    const cleanup = deferred();
    const sessions = new Map([
      ['session-1', 'D:\\Project Alpha'],
      ['session-2', 'D:\\Project Alpha'],
    ]);
    const closedRuntimeSessions: string[] = [];
    const captured: string[][] = [];
    const closing = runOwnedProjectDirectoryClosure({
      captureSessionIds: () => {
        const sessionIds = [...sessions.keys()];
        captured.push(sessionIds);
        return sessionIds;
      },
      closeRuntimeSession: (sessionId) => {
        closedRuntimeSessions.push(sessionId);
      },
      closeWorkspaceSession: (sessionId) => {
        sessions.delete(sessionId);
      },
      coordinator,
      cwd: 'D:\\Project Alpha',
      invalidateAndWait: () => cleanup.promise,
      isSessionInDirectory: (sessionId, cwd) =>
        sessions.get(sessionId)?.toLocaleLowerCase() === cwd.toLocaleLowerCase(),
      kind: 'close',
      readState: () => [...sessions.keys()],
    });

    // This simulates an unowned source adding a session while cleanup is pending. The closure must not
    // re-enumerate and destroy it; production open paths also supersede the closure through the coordinator.
    sessions.set('session-3', 'D:\\Project Alpha');
    cleanup.resolve();

    await expect(closing).resolves.toEqual(['session-3']);
    expect(captured).toEqual([['session-1', 'session-2']]);
    expect(closedRuntimeSessions).toEqual(['session-1', 'session-2']);
  });
});
