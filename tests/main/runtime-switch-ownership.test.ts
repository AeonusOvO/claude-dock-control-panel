import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectRuntimeSwitchCoordinator } from '../../src/main/coordination/main-process-operation';
import type { DevelopmentRuntime, PtyGeneration } from '../../src/shared/contracts';
import type {
  ProjectRuntimeSwitchDependencies,
  RuntimeSwitchSessionSnapshot,
} from '../../src/main/coordination/main-process-operation';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const runtimeKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase('en-US');

const session = (
  id: string,
  cwd: string,
  ptyGeneration: PtyGeneration = 1,
): RuntimeSwitchSessionSnapshot => ({ cwd, id, ptyGeneration });

const switchHarness = (
  initialSessions: RuntimeSwitchSessionSnapshot[],
  overrides: Partial<ProjectRuntimeSwitchDependencies> = {},
) => {
  const sessions = new Map(initialSessions.map((candidate) => [candidate.id, candidate]));
  const runtimes = new Map<string, DevelopmentRuntime>();
  for (const candidate of initialSessions) {
    runtimes.set(runtimeKey(candidate.cwd), 'claude');
  }
  const dependencies: ProjectRuntimeSwitchDependencies = {
    assertSwitchAllowed: () => undefined,
    cleanupBeforeCommit: async () => undefined,
    commitRuntime: (cwd, runtime) => runtimes.set(runtimeKey(cwd), runtime),
    getCurrentRuntime: (cwd) => runtimes.get(runtimeKey(cwd)) ?? 'claude',
    getSession: (sessionId) => sessions.get(sessionId),
    hasActiveRuntime: () => false,
    invalidateAndWait: async () => undefined,
    sessionsForDirectory: (cwd) =>
      [...sessions.values()].filter((candidate) => runtimeKey(candidate.cwd) === runtimeKey(cwd)),
    withProviderAccess: async (_cwd, _selected, operation) => operation(),
    ...overrides,
  };
  return new ProjectRuntimeSwitchCoordinator(dependencies);
};

describe('runtime switch ownership snapshots', () => {
  it('exposes the latest directory-owned switch until its exact attempt settles', async () => {
    const cwd = 'C:\\projects\\alpha';
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const coordinator = switchHarness([session('session-a', cwd)], {
      withProviderAccess: async (_cwd, _selected, operation) => {
        providerEntered.resolve();
        await releaseProvider.promise;
        return operation();
      },
    });

    const firstSwitch = coordinator.switchRuntime('session-a', cwd, 'codex');
    const firstOutcome = firstSwitch.catch((error: unknown) => error);
    const firstOperation = coordinator.activeSwitch(cwd);
    expect(firstOperation).toEqual({ attempt: 1, runtime: 'codex' });
    expect(coordinator.activeSwitch('C:\\projects\\beta')).toBeUndefined();
    await providerEntered.promise;

    const secondSwitch = coordinator.switchRuntime('session-a', cwd, 'claude');
    const secondOperation = coordinator.activeSwitch(cwd);
    expect(secondOperation).toEqual({ attempt: 2, runtime: 'claude' });
    expect(secondOperation?.attempt).toBeGreaterThan(firstOperation?.attempt ?? 0);

    releaseProvider.resolve();
    await expect(firstOutcome).resolves.toBeInstanceOf(Error);
    await expect(secondSwitch).resolves.toBe('claude');
    expect(coordinator.activeSwitch(cwd)).toBeUndefined();
  });
});
