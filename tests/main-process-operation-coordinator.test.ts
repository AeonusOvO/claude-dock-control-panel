import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DevelopmentRuntime, PtyGeneration } from '../src/shared/contracts';
import {
  OwnedConfigTransactionError,
  ProjectRuntimeSwitchCoordinator,
  runOwnedConfigTransaction as runPhasedConfigTransaction,
  SessionConfigTransactionCoordinator,
  type OwnedConfigTransactionOptions,
  type ProjectRuntimeSwitchDependencies,
  type RuntimeSwitchSessionSnapshot,
} from '../src/main/main-process-operation-coordinator';
import { SessionOperationCoordinator } from '../src/main/session-operation-coordinator';
import { cleanupFailedRuntimeLaunch } from '../src/main/terminal-lifecycle';

const deferred = <T = void>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

type TestConfigTransactionOptions<TSnapshot, TState> = Omit<
  OwnedConfigTransactionOptions<TSnapshot, void, TState>,
  'commit' | 'complete' | 'prepare'
> & {
  resume?: (savedState: TState) => Promise<TState>;
  save: () => Promise<TState>;
};

/** Adapts the older save/resume test fixtures onto the explicit synchronous-commit phases. */
const runTestConfigTransaction = <TSnapshot, TState>(
  options: TestConfigTransactionOptions<TSnapshot, TState>,
): Promise<TState> => {
  const { resume, save, ...transaction } = options;
  let saving!: Promise<TState>;
  return runPhasedConfigTransaction({
    ...transaction,
    commit: () => {
      saving = save();
    },
    complete: async () => {
      const savedState = await saving;
      return resume ? resume(savedState) : savedState;
    },
    prepare: () => undefined,
  });
};

const runtimeKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();

const switchHarness = (
  initialSessions: RuntimeSwitchSessionSnapshot[],
  overrides: Partial<ProjectRuntimeSwitchDependencies> = {},
) => {
  const sessions = new Map(initialSessions.map((session) => [session.id, session]));
  const runtimes = new Map<string, DevelopmentRuntime>();
  for (const session of initialSessions) {
    runtimes.set(runtimeKey(session.cwd), 'claude');
  }
  const commits: Array<{ cwd: string; runtime: DevelopmentRuntime }> = [];
  const dependencies: ProjectRuntimeSwitchDependencies = {
    cleanupBeforeCommit: async () => undefined,
    commitRuntime: (cwd, runtime) => {
      commits.push({ cwd, runtime });
      runtimes.set(runtimeKey(cwd), runtime);
    },
    getCurrentRuntime: (cwd) => runtimes.get(runtimeKey(cwd)) ?? 'claude',
    getSession: (sessionId) => sessions.get(sessionId),
    hasActiveRuntime: () => false,
    invalidateAndWait: async () => undefined,
    prepareProvider: async () => undefined,
    sessionsForDirectory: (cwd) =>
      [...sessions.values()].filter((session) => runtimeKey(session.cwd) === runtimeKey(cwd)),
    ...overrides,
  };
  return {
    commits,
    coordinator: new ProjectRuntimeSwitchCoordinator(dependencies),
    runtimes,
    sessions,
  };
};

const session = (id: string, cwd: string, ptyGeneration = 1): RuntimeSwitchSessionSnapshot => ({
  cwd,
  id,
  ptyGeneration,
});

describe('ProjectRuntimeSwitchCoordinator', () => {
  it('cancels a stale switch when a new same-directory session appears', async () => {
    const cwd = 'C:\\projects\\alpha';
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const harness = switchHarness([session('session-a', cwd)], {
      prepareProvider: async () => {
        providerEntered.resolve();
        await releaseProvider.promise;
      },
    });

    const switching = harness.coordinator.switchRuntime('session-a', cwd, 'codex');
    const outcome = switching.then(
      () => undefined,
      (error: unknown) => error,
    );
    await providerEntered.promise;

    harness.sessions.set('session-new', session('session-new', cwd));
    expect(() => harness.coordinator.assertDevelopmentOperationAllowed(cwd)).toThrow(
      '正在切换开发引擎',
    );
    releaseProvider.resolve();

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('项目会话在开发引擎切换期间发生变化');
    expect(harness.commits).toEqual([]);
    expect(harness.runtimes.get(runtimeKey(cwd))).toBe('claude');
  });

  it('supersedes and serializes concurrent switches for the same directory', async () => {
    const cwd = 'C:\\projects\\alpha';
    const firstProviderEntered = deferred();
    const secondProviderEntered = deferred();
    const releaseFirstProvider = deferred();
    const releaseSecondProvider = deferred();
    let providerCalls = 0;
    const harness = switchHarness([session('session-a', cwd)], {
      prepareProvider: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          firstProviderEntered.resolve();
          await releaseFirstProvider.promise;
          return;
        }
        secondProviderEntered.resolve();
        await releaseSecondProvider.promise;
      },
    });

    const firstSwitch = harness.coordinator.switchRuntime('session-a', cwd, 'codex');
    const firstOutcome = firstSwitch.then(
      () => undefined,
      (error: unknown) => error,
    );
    await firstProviderEntered.promise;

    const secondSwitch = harness.coordinator.switchRuntime('session-a', cwd, 'codex');
    let secondSettled = false;
    void secondSwitch.finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseFirstProvider.resolve();
    const firstError = await firstOutcome;
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toContain('更新选择取代');
    await secondProviderEntered.promise;
    expect(harness.commits).toEqual([]);

    releaseSecondProvider.resolve();
    await expect(secondSwitch).resolves.toBe('codex');
    expect(harness.commits).toEqual([{ cwd, runtime: 'codex' }]);
  });

  it('stops a predecessor PTY before a cancelled relaunch lets a runtime switch commit', async () => {
    const cwd = 'C:\\projects\\alpha';
    const preparedEntered = deferred();
    const cancellationObserved = deferred();
    const sessionOperations = new SessionOperationCoordinator(() => true);
    let committedRuntime: DevelopmentRuntime = 'claude';
    let prepared = false;
    let processRunning = true;
    let runtimeActive = true;
    let runtimeGeneration: PtyGeneration | undefined = 1;
    const sessions = [session('session-a', cwd, 1)];
    const switchCoordinator = new ProjectRuntimeSwitchCoordinator({
      cleanupBeforeCommit: async () => undefined,
      commitRuntime: (_cwd, runtime) => {
        committedRuntime = runtime;
      },
      getCurrentRuntime: () => committedRuntime,
      getSession: (sessionId) => sessions.find((candidate) => candidate.id === sessionId),
      hasActiveRuntime: () => runtimeActive,
      invalidateAndWait: (sessionId) => {
        const unwound = sessionOperations.invalidateAndWait(sessionId);
        cancellationObserved.resolve();
        return unwound;
      },
      prepareProvider: async () => undefined,
      sessionsForDirectory: () => sessions,
    });

    const relaunch = sessionOperations.run('session-a', async (assertCurrent) => {
      const predecessorPtyGeneration = runtimeGeneration;
      runtimeGeneration = undefined;
      prepared = true;
      preparedEntered.resolve();
      await cancellationObserved.promise;
      try {
        assertCurrent();
      } catch (error) {
        cleanupFailedRuntimeLaunch(
          {
            hasSession: () => true,
            stopIfGeneration: (_sessionId, expectedGeneration) => {
              if (expectedGeneration === 1) {
                processRunning = false;
              }
            },
          },
          {
            cleanupPreparedLaunch: () => {
              if (prepared && runtimeGeneration === undefined) {
                prepared = false;
                runtimeActive = false;
                return true;
              }
              return false;
            },
            setInactive: (_sessionId, expectedGeneration) => {
              if (runtimeGeneration === expectedGeneration) {
                runtimeGeneration = undefined;
                runtimeActive = false;
                return true;
              }
              return false;
            },
          },
          'session-a',
          predecessorPtyGeneration,
        );
        throw error;
      }
    });
    const relaunchOutcome = relaunch.catch((error: unknown) => error);
    await preparedEntered.promise;

    const switching = switchCoordinator.switchRuntime('session-a', cwd, 'codex');

    await expect(relaunchOutcome).resolves.toBeInstanceOf(Error);
    await expect(switching).resolves.toBe('codex');
    expect(processRunning).toBe(false);
    expect(prepared).toBe(false);
    expect(runtimeActive).toBe(false);
    expect(committedRuntime).toBe('codex');
  });

  it('allows unrelated directories to finish independently', async () => {
    const cwdA = 'C:\\projects\\alpha';
    const cwdB = 'C:\\projects\\beta';
    const providerAEntered = deferred();
    const releaseProviderA = deferred();
    const harness = switchHarness([session('session-a', cwdA), session('session-b', cwdB)], {
      prepareProvider: async (cwd) => {
        if (runtimeKey(cwd) === runtimeKey(cwdA)) {
          providerAEntered.resolve();
          await releaseProviderA.promise;
        }
      },
    });

    const switchA = harness.coordinator.switchRuntime('session-a', cwdA, 'codex');
    await providerAEntered.promise;
    const switchB = harness.coordinator.switchRuntime('session-b', cwdB, 'codex');

    await expect(switchB).resolves.toBe('codex');
    expect(harness.runtimes.get(runtimeKey(cwdB))).toBe('codex');
    expect(harness.runtimes.get(runtimeKey(cwdA))).toBe('claude');

    releaseProviderA.resolve();
    await expect(switchA).resolves.toBe('codex');
    expect(harness.runtimes.get(runtimeKey(cwdA))).toBe('codex');
  });
});

describe('owned config transactions', () => {
  it('blocks sibling launches until tentative config rollback recovery finishes', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const cwd = 'C:\\projects\\alpha';
    const resumeEntered = deferred();
    const failResume = deferred();
    const recoveryReadEntered = deferred();
    const releaseRecoveryRead = deferred();
    let config = 'original';

    const transaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => {
        recoveryReadEntered.resolve();
        await releaseRecoveryRead.promise;
        return config;
      },
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      resume: async () => {
        resumeEntered.resolve();
        await failResume.promise;
        throw new Error('resume failed');
      },
      save: async () => {
        config = 'tentative';
        return config;
      },
      sessionId: 'session-a',
    });
    const outcome = transaction.catch((error: unknown) => error);
    await resumeEntered.promise;

    expect(() => coordinator.assertDevelopmentOperationAllowed(cwd, 'session-a')).not.toThrow();
    expect(() => coordinator.assertDevelopmentOperationAllowed(cwd, 'session-b')).toThrow(
      '正在保存并验证接入配置',
    );
    expect(() =>
      coordinator.assertDevelopmentOperationAllowed('C:\\projects\\beta', 'session-b'),
    ).not.toThrow();

    failResume.resolve();
    await recoveryReadEntered.promise;
    expect(config).toBe('original');
    expect(() => coordinator.assertDevelopmentOperationAllowed(cwd, 'session-b')).toThrow(
      '正在保存并验证接入配置',
    );

    releaseRecoveryRead.resolve();
    await expect(outcome).resolves.toBeInstanceOf(OwnedConfigTransactionError);
    expect(() => coordinator.assertDevelopmentOperationAllowed(cwd, 'session-b')).not.toThrow();
  });

  it('waits for a pre-existing sibling launch to unwind before tentative save', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const operations = new SessionOperationCoordinator(() => true);
    const cwd = 'C:\\projects\\alpha';
    const siblingEntered = deferred();
    const releaseSibling = deferred();
    const invalidationEntered = deferred();
    const events: string[] = [];
    let config = 'original';

    const siblingOperation = operations.run('session-b', async (assertCurrent) => {
      events.push('sibling-start');
      siblingEntered.resolve();
      try {
        await releaseSibling.promise;
        assertCurrent();
      } finally {
        events.push('sibling-unwound');
      }
    });
    const siblingOutcome = siblingOperation.catch((error: unknown) => error);
    await siblingEntered.promise;

    const transaction = runTestConfigTransaction({
      acquireIsolation: () =>
        coordinator.acquireDevelopmentIsolation(
          'session-a',
          cwd,
          ['session-a', 'session-b'],
          (sessionId) => {
            events.push(`invalidate:${sessionId}`);
            invalidationEntered.resolve();
            return operations.invalidateAndWait(sessionId);
          },
        ),
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => {
        events.push('snapshot');
        return config;
      },
      cwd,
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      save: async () => {
        events.push('save');
        config = 'tentative';
        return config;
      },
      sessionId: 'session-a',
    });
    await invalidationEntered.promise;

    expect(config).toBe('original');
    expect(events).toEqual(['sibling-start', 'invalidate:session-b']);
    expect(() => coordinator.assertDevelopmentOperationAllowed(cwd, 'session-b')).toThrow(
      '正在保存并验证接入配置',
    );

    releaseSibling.resolve();
    await expect(siblingOutcome).resolves.toBeInstanceOf(Error);
    await expect(transaction).resolves.toBe('tentative');
    expect(events).toEqual([
      'sibling-start',
      'invalidate:session-b',
      'sibling-unwound',
      'snapshot',
      'snapshot',
      'save',
      'snapshot',
      'snapshot',
      'snapshot',
    ]);
    expect(config).toBe('tentative');
  });

  it('rejects a raced sibling transaction reservation after isolation begins', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const cwd = 'C:\\projects\\alpha';
    const invalidationEntered = deferred();
    const releaseInvalidation = deferred();
    let config = 'original';
    let siblingSaveStarted = false;

    const transaction = runTestConfigTransaction({
      acquireIsolation: () =>
        coordinator.acquireDevelopmentIsolation(
          'session-a',
          cwd,
          ['session-a', 'session-b'],
          async () => {
            invalidationEntered.resolve();
            await releaseInvalidation.promise;
          },
        ),
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      save: async () => {
        config = 'first';
        return config;
      },
      sessionId: 'session-a',
    });
    await invalidationEntered.promise;

    expect(() =>
      runTestConfigTransaction({
        assertOperationOwnership: () => undefined,
        coordinator,
        createSnapshot: () => config,
        cwd,
        readState: async () => config,
        restoreSnapshot: (snapshot) => {
          config = snapshot;
        },
        save: async () => {
          siblingSaveStarted = true;
          config = 'second';
          return config;
        },
        sessionId: 'session-b',
      }),
    ).toThrow('已进入隔离保存阶段');
    expect(siblingSaveStarted).toBe(false);
    expect(config).toBe('original');

    releaseInvalidation.resolve();
    await expect(transaction).resolves.toBe('first');
    expect(config).toBe('first');
  });

  it('does not deadlock an already queued sibling config transaction during isolation', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const operations = new SessionOperationCoordinator(() => true);
    const cwd = 'C:\\projects\\alpha';
    const firstResumeEntered = deferred();
    const releaseFirstResume = deferred();
    const invalidations: string[] = [];
    let config = 'original';
    let secondSaveStarted = false;
    const acquireIsolation = (owner: string): Promise<void> =>
      coordinator.acquireDevelopmentIsolation(
        owner,
        cwd,
        ['session-a', 'session-b'],
        (sessionId) => {
          invalidations.push(`${owner}->${sessionId}`);
          return operations.invalidateAndWait(sessionId);
        },
      );

    const firstTransaction = operations.run('session-a', (assertCurrent) =>
      runTestConfigTransaction({
        acquireIsolation: () => acquireIsolation('session-a'),
        assertOperationOwnership: assertCurrent,
        coordinator,
        createSnapshot: () => config,
        cwd,
        readState: async () => config,
        restoreSnapshot: (snapshot) => {
          config = snapshot;
        },
        resume: async () => {
          firstResumeEntered.resolve();
          await releaseFirstResume.promise;
          return config;
        },
        save: async () => {
          config = 'first';
          return config;
        },
        sessionId: 'session-a',
      }),
    );
    const secondTransaction = operations.run('session-b', (assertCurrent) =>
      runTestConfigTransaction({
        acquireIsolation: () => acquireIsolation('session-b'),
        assertOperationOwnership: assertCurrent,
        coordinator,
        createSnapshot: () => config,
        cwd,
        readState: async () => config,
        restoreSnapshot: (snapshot) => {
          config = snapshot;
        },
        save: async () => {
          secondSaveStarted = true;
          config = 'second';
          return config;
        },
        sessionId: 'session-b',
      }),
    );

    await firstResumeEntered.promise;
    expect(secondSaveStarted).toBe(false);
    expect(invalidations).not.toContain('session-a->session-b');

    releaseFirstResume.resolve();
    await expect(firstTransaction).resolves.toBe('first');
    await expect(secondTransaction).resolves.toBe('second');
    expect(secondSaveStarted).toBe(true);
    expect(config).toBe('second');
  });

  it('preserves a newer identical save from another session in the same folder', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const cwd = 'C:\\projects\\alpha';
    const firstSaveEntered = deferred();
    const failFirstSave = deferred();
    let config = 'original';
    let secondSaveStarted = false;

    const firstTransaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      save: async () => {
        config = 'same-value';
        firstSaveEntered.resolve();
        await failFirstSave.promise;
        throw new Error('first save failed late');
      },
      sessionId: 'session-a',
    });
    const firstOutcome = firstTransaction.then(
      () => undefined,
      (error: unknown) => error,
    );
    await firstSaveEntered.promise;

    const secondTransaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      save: async () => {
        secondSaveStarted = true;
        config = 'same-value';
        return config;
      },
      sessionId: 'session-b',
    });
    await Promise.resolve();
    expect(secondSaveStarted).toBe(false);

    failFirstSave.resolve();
    const firstError = await firstOutcome;
    expect(firstError).toBeInstanceOf(OwnedConfigTransactionError);
    expect((firstError as OwnedConfigTransactionError<string>).restored).toBe(true);
    await expect(secondTransaction).resolves.toBe('same-value');
    expect(secondSaveStarted).toBe(true);
    expect(config).toBe('same-value');
  });

  it('keeps the next same-folder save queued through rollback state recovery', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const cwd = 'C:\\projects\\alpha';
    const recoveryReadEntered = deferred();
    const releaseRecoveryRead = deferred();
    let config = 'original';
    let secondSaveStarted = false;

    const firstTransaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => {
        recoveryReadEntered.resolve();
        await releaseRecoveryRead.promise;
        return config;
      },
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      resume: async () => {
        throw new Error('resume failed');
      },
      save: async () => {
        config = 'first';
        return config;
      },
      sessionId: 'session-a',
    });
    const firstOutcome = firstTransaction.then(
      () => undefined,
      (error: unknown) => error,
    );
    await recoveryReadEntered.promise;
    expect(config).toBe('original');

    const secondTransaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      save: async () => {
        secondSaveStarted = true;
        config = 'second';
        return config;
      },
      sessionId: 'session-b',
    });
    await Promise.resolve();
    expect(secondSaveStarted).toBe(false);

    releaseRecoveryRead.resolve();
    expect(await firstOutcome).toBeInstanceOf(OwnedConfigTransactionError);
    await expect(secondTransaction).resolves.toBe('second');
    expect(config).toBe('second');
  });

  it('keeps the next same-folder save queued until the active resume commits', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const cwd = 'C:\\projects\\alpha';
    const resumeEntered = deferred();
    const releaseResume = deferred();
    let config = 'original';
    let secondSaveStarted = false;

    const firstTransaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      resume: async () => {
        resumeEntered.resolve();
        await releaseResume.promise;
        return config;
      },
      save: async () => {
        config = 'first';
        return config;
      },
      sessionId: 'session-a',
    });
    await resumeEntered.promise;

    const secondTransaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd,
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      save: async () => {
        secondSaveStarted = true;
        config = 'second';
        return config;
      },
      sessionId: 'session-b',
    });
    await Promise.resolve();
    expect(secondSaveStarted).toBe(false);

    releaseResume.resolve();
    await expect(firstTransaction).resolves.toBe('first');
    await expect(secondTransaction).resolves.toBe('second');
    expect(config).toBe('second');
  });

  it('allows config transactions for different folders to proceed independently', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const cwdA = 'C:\\projects\\alpha';
    const cwdB = 'C:\\projects\\beta';
    const firstSaveEntered = deferred();
    const releaseFirstSave = deferred();
    const configs = new Map<string, string>([
      [runtimeKey(cwdA), 'original-a'],
      [runtimeKey(cwdB), 'original-b'],
    ]);

    const transactionA = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => configs.get(runtimeKey(cwdA)) ?? '',
      cwd: cwdA,
      readState: async () => configs.get(runtimeKey(cwdA)) ?? '',
      restoreSnapshot: (snapshot) => {
        configs.set(runtimeKey(cwdA), snapshot);
      },
      save: async () => {
        configs.set(runtimeKey(cwdA), 'saved-a');
        firstSaveEntered.resolve();
        await releaseFirstSave.promise;
        return 'saved-a';
      },
      sessionId: 'session-a',
    });
    await firstSaveEntered.promise;

    await expect(
      runTestConfigTransaction({
        assertOperationOwnership: () => undefined,
        coordinator,
        createSnapshot: () => configs.get(runtimeKey(cwdB)) ?? '',
        cwd: cwdB,
        readState: async () => configs.get(runtimeKey(cwdB)) ?? '',
        restoreSnapshot: (snapshot) => {
          configs.set(runtimeKey(cwdB), snapshot);
        },
        save: async () => {
          configs.set(runtimeKey(cwdB), 'saved-b');
          return 'saved-b';
        },
        sessionId: 'session-b',
      }),
    ).resolves.toBe('saved-b');
    expect(configs.get(runtimeKey(cwdA))).toBe('saved-a');
    expect(configs.get(runtimeKey(cwdB))).toBe('saved-b');

    releaseFirstSave.resolve();
    await expect(transactionA).resolves.toBe('saved-a');
  });

  it('does not roll back across an uncoordinated newer project config save', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const resumeEntered = deferred();
    const failResume = deferred();
    let config = 'original';

    const transaction = runTestConfigTransaction({
      assertOperationOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd: 'C:\\projects\\alpha',
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      resume: async () => {
        resumeEntered.resolve();
        await failResume.promise;
        throw new Error('resume failed late');
      },
      save: async () => {
        config = 'managed-save';
        return config;
      },
      sessionId: 'session-a',
    });
    const outcome = transaction.then(
      () => undefined,
      (error: unknown) => error,
    );
    await resumeEntered.promise;

    config = 'external-success';
    failResume.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(OwnedConfigTransactionError);
    expect((error as OwnedConfigTransactionError<string>).restored).toBe(false);
    expect((error as OwnedConfigTransactionError<string>).state).toBe('external-success');
    expect(config).toBe('external-success');
  });

  it('restores and publishes authoritative state when save succeeds but resume fails', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const events: string[] = [];
    const published: string[] = [];
    let config = 'original';

    const transaction = runTestConfigTransaction({
      assertOperationOwnership: () => {
        events.push('assert');
      },
      coordinator,
      createSnapshot: () => {
        events.push('snapshot');
        return config;
      },
      cwd: 'C:\\projects\\alpha',
      publishRestoredState: (state) => {
        events.push('publish');
        published.push(state);
      },
      readState: async () => {
        events.push('read');
        return config;
      },
      restoreSnapshot: (snapshot) => {
        events.push('restore');
        config = snapshot;
      },
      resume: async () => {
        events.push('resume');
        throw new Error('resume failed');
      },
      save: async () => {
        events.push('save');
        config = 'saved';
        return config;
      },
      sessionId: 'session-a',
    });

    const error = await transaction.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(OwnedConfigTransactionError);
    expect((error as OwnedConfigTransactionError<string>).message).toBe('resume failed');
    expect((error as OwnedConfigTransactionError<string>).restored).toBe(true);
    expect((error as OwnedConfigTransactionError<string>).state).toBe('original');
    expect(config).toBe('original');
    expect(published).toEqual(['original']);
    expect(events[0]).toBe('assert');
    expect(events.indexOf('snapshot')).toBeLessThan(events.indexOf('save'));
    expect(events).toContain('restore');
    expect(events.slice(-2)).toEqual(['assert', 'publish']);
  });

  it('rolls back after operation ownership is lost while the exact target still exists', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    let config = 'original';
    let ownershipChecks = 0;

    const transaction = runTestConfigTransaction({
      assertOperationOwnership: () => {
        ownershipChecks += 1;
        if (ownershipChecks > 2) {
          throw new Error('operation cancelled');
        }
      },
      assertRollbackOwnership: () => undefined,
      coordinator,
      createSnapshot: () => config,
      cwd: 'C:\\projects\\alpha',
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      save: async () => {
        config = 'saved';
        return config;
      },
      sessionId: 'session-a',
    });

    const error = await transaction.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(OwnedConfigTransactionError);
    expect((error as OwnedConfigTransactionError<string>).message).toBe('operation cancelled');
    expect((error as OwnedConfigTransactionError<string>).restored).toBe(true);
    expect((error as OwnedConfigTransactionError<string>).state).toBe('original');
    expect(config).toBe('original');
  });

  it('finishes asynchronous preparation before the synchronous profile commit', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const prepareEntered = deferred();
    const releasePrepare = deferred();
    const events: string[] = [];
    let config = 'original';

    const transaction = runPhasedConfigTransaction({
      assertOperationOwnership: () => undefined,
      commit: (prepared) => {
        events.push(`commit:${prepared}`);
        expect(config).toBe('original');
        config = prepared;
      },
      complete: async (prepared) => {
        events.push(`complete:${prepared}`);
        expect(config).toBe('prepared');
        return config;
      },
      coordinator,
      createSnapshot: () => config,
      cwd: 'C:\\projects\\alpha',
      prepare: async () => {
        events.push('prepare:start');
        prepareEntered.resolve();
        await releasePrepare.promise;
        events.push('prepare:end');
        return 'prepared';
      },
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      sessionId: 'session-a',
    });
    await prepareEntered.promise;

    expect(config).toBe('original');
    expect(events).toEqual(['prepare:start']);

    releasePrepare.resolve();
    await expect(transaction).resolves.toBe('prepared');
    expect(events).toEqual([
      'prepare:start',
      'prepare:end',
      'commit:prepared',
      'complete:prepared',
    ]);
  });

  it('cancels a stale prepared save without rolling back an external profile update', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const prepareEntered = deferred();
    const releasePrepare = deferred();
    let commitCalled = false;
    let config = 'original';

    const transaction = runPhasedConfigTransaction({
      assertOperationOwnership: () => undefined,
      commit: () => {
        commitCalled = true;
        config = 'tentative';
      },
      complete: async () => config,
      coordinator,
      createSnapshot: () => config,
      cwd: 'C:\\projects\\alpha',
      prepare: async () => {
        prepareEntered.resolve();
        await releasePrepare.promise;
        return 'prepared';
      },
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      sessionId: 'session-a',
    });
    const outcome = transaction.catch((error: unknown) => error);
    await prepareEntered.promise;

    config = 'external-newer';
    releasePrepare.resolve();

    const error = await outcome;
    expect(error).toBeInstanceOf(OwnedConfigTransactionError);
    expect((error as OwnedConfigTransactionError<string>).message).toContain('异步准备期间');
    expect((error as OwnedConfigTransactionError<string>).restored).toBe(false);
    expect((error as OwnedConfigTransactionError<string>).state).toBe('external-newer');
    expect(commitCalled).toBe(false);
    expect(config).toBe('external-newer');
  });

  it('captures and restores the exact profile left by a throwing synchronous commit', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    let config = 'original';

    const transaction = runPhasedConfigTransaction({
      assertOperationOwnership: () => undefined,
      commit: () => {
        config = 'partial-write';
        throw new Error('commit failed');
      },
      complete: async () => config,
      coordinator,
      createSnapshot: () => config,
      cwd: 'C:\\projects\\alpha',
      prepare: () => 'prepared',
      readState: async () => config,
      restoreSnapshot: (snapshot) => {
        config = snapshot;
      },
      sessionId: 'session-a',
    });

    const error = await transaction.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OwnedConfigTransactionError);
    expect((error as OwnedConfigTransactionError<string>).message).toBe('commit failed');
    expect((error as OwnedConfigTransactionError<string>).restored).toBe(true);
    expect((error as OwnedConfigTransactionError<string>).state).toBe('original');
    expect(config).toBe('original');
  });
});
