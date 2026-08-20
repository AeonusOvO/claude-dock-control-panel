import { describe, expect, it } from 'vitest';
import type { PtyGeneration, TerminalStatus } from '../../src/shared/contracts';
import {
  cleanupFailedRuntimeLaunch,
  enteredTerminalFailure,
  isTerminalFailurePhase,
  TerminalTransitionCoordinator,
  type DirectTerminalTransitionDependencies,
  type FailedRuntimeLaunchCleanupDependencies,
  type FailedRuntimeLaunchOwner,
  type TerminalStatusBaseline,
} from '../../src/main/terminal/lifecycle';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const baseline = (
  phase: TerminalStatusBaseline['phase'],
  ptyGeneration: number,
): TerminalStatusBaseline => ({ phase, ptyGeneration });

const terminalStatus = (
  phase: TerminalStatus['phase'],
  ptyGeneration: PtyGeneration,
): TerminalStatus => ({
  cwd: 'C:\\projects\\alpha',
  id: 'session-a',
  phase,
  ptyGeneration,
  shell: 'Windows PowerShell',
  title: 'Alpha',
});

describe('direct terminal transitions', () => {
  it.each([
    ['start', 'running', 3],
    ['restart', 'running', 3],
    ['stop', 'stopped', 2],
  ] as const)(
    'orders %s after cancellation has fully unwound',
    async (operationName, resultPhase, resultGeneration) => {
      const order: string[] = [];
      const probeResolved = deferred();
      const leaseUnwound = deferred();
      const currentGeneration: PtyGeneration = 2;
      void probeResolved.promise.then(() => {
        order.push('cancelled-work-unwound');
        leaseUnwound.resolve();
      });
      const dependencies: DirectTerminalTransitionDependencies = {
        deactivateRuntimes: (_sessionId, expectedGeneration) => {
          order.push(`deactivate:${expectedGeneration}`);
        },
        discardOutput: (_sessionId, expectedGeneration) => {
          order.push(`discard:${expectedGeneration}`);
        },
        getPtyGeneration: () => {
          order.push(`generation:${currentGeneration}`);
          return currentGeneration;
        },
        invalidateAndWait: () => {
          order.push('invalidate');
          return leaseUnwound.promise;
        },
        resolveProbes: (_sessionId, expectedGeneration) => {
          order.push(`resolve-probes:${expectedGeneration}`);
          probeResolved.resolve();
        },
        withInvalidationSuppressed: (_sessionId, operation) => {
          order.push('suppression:on');
          try {
            return operation();
          } finally {
            order.push('suppression:off');
          }
        },
      };
      const expectedStatus = terminalStatus(resultPhase, resultGeneration);

      const transitioning = new TerminalTransitionCoordinator(dependencies).run(
        'session-a',
        currentGeneration,
        () => {
          order.push(`pty:${operationName}`);
          return expectedStatus;
        },
      );

      expect(order).toEqual(['generation:2', 'invalidate', 'resolve-probes:2']);
      await expect(transitioning).resolves.toBe(expectedStatus);
      expect(order).toEqual([
        'generation:2',
        'invalidate',
        'resolve-probes:2',
        'cancelled-work-unwound',
        'generation:2',
        'discard:2',
        'deactivate:2',
        'suppression:on',
        `pty:${operationName}`,
        'suppression:off',
      ]);
    },
  );

  it('rejects a stale generation at entry without invalidating or cleaning anything', async () => {
    const order: string[] = [];
    const dependencies: DirectTerminalTransitionDependencies = {
      deactivateRuntimes: () => {
        order.push('deactivate');
      },
      discardOutput: () => {
        order.push('discard');
      },
      getPtyGeneration: () => {
        order.push('generation:3');
        return 3;
      },
      invalidateAndWait: async () => {
        order.push('invalidate');
      },
      resolveProbes: () => {
        order.push('resolve-probes');
      },
      withInvalidationSuppressed: (_sessionId, operation) => {
        order.push('suppression');
        return operation();
      },
    };

    await expect(
      new TerminalTransitionCoordinator(dependencies).run('session-a', 2, () => {
        order.push('pty:start');
        return terminalStatus('running', 4);
      }),
    ).rejects.toThrow('终端已被其他操作替换');
    expect(order).toEqual(['generation:3']);
  });

  it('does not clean or mutate a replacement generation created during lease unwind', async () => {
    const order: string[] = [];
    const leaseUnwound = deferred();
    let currentGeneration: PtyGeneration = 2;
    const dependencies: DirectTerminalTransitionDependencies = {
      deactivateRuntimes: (_sessionId, expectedGeneration) => {
        order.push(`deactivate:${expectedGeneration}`);
      },
      discardOutput: (_sessionId, expectedGeneration) => {
        order.push(`discard:${expectedGeneration}`);
      },
      getPtyGeneration: () => {
        order.push(`generation:${currentGeneration}`);
        return currentGeneration;
      },
      invalidateAndWait: () => {
        order.push('invalidate');
        return leaseUnwound.promise;
      },
      resolveProbes: (_sessionId, expectedGeneration) => {
        order.push(`resolve-probes:${expectedGeneration}`);
      },
      withInvalidationSuppressed: (_sessionId, operation) => {
        order.push('suppression');
        return operation();
      },
    };

    const transitioning = new TerminalTransitionCoordinator(dependencies).run(
      'session-a',
      2,
      () => {
        order.push('pty:restart');
        return terminalStatus('running', 4);
      },
    );
    expect(order).toEqual(['generation:2', 'invalidate', 'resolve-probes:2']);

    currentGeneration = 3;
    leaseUnwound.resolve();

    await expect(transitioning).rejects.toThrow('终端已被其他操作替换');
    expect(order).toEqual(['generation:2', 'invalidate', 'resolve-probes:2', 'generation:3']);
  });
  it('lets a later Stop supersede an earlier pending Restart on the same generation', async () => {
    const leaseUnwound = deferred();
    const mutations: string[] = [];
    let currentGeneration: PtyGeneration = 2;
    const dependencies: DirectTerminalTransitionDependencies = {
      deactivateRuntimes: (_sessionId, expectedGeneration) => {
        mutations.push(`deactivate:${expectedGeneration}`);
      },
      discardOutput: (_sessionId, expectedGeneration) => {
        mutations.push(`discard:${expectedGeneration}`);
      },
      getPtyGeneration: () => currentGeneration,
      invalidateAndWait: () => leaseUnwound.promise,
      resolveProbes: () => undefined,
      withInvalidationSuppressed: (_sessionId, operation) => operation(),
    };
    const coordinator = new TerminalTransitionCoordinator(dependencies);

    const restart = coordinator
      .run('session-a', 2, () => {
        mutations.push('pty:restart');
        currentGeneration = 3;
        return terminalStatus('running', 3);
      })
      .catch((error: unknown) => error);
    const stop = coordinator.run('session-a', 2, () => {
      mutations.push('pty:stop');
      return terminalStatus('stopped', 2);
    });

    leaseUnwound.resolve();
    await expect(restart).resolves.toMatchObject({
      message: expect.stringContaining('更新操作取代'),
    });
    await expect(stop).resolves.toMatchObject({ phase: 'stopped', ptyGeneration: 2 });
    expect(mutations).toEqual(['discard:2', 'deactivate:2', 'pty:stop']);
    expect(currentGeneration).toBe(2);
  });

  it('lets a later Restart supersede an earlier pending Stop', async () => {
    const leaseUnwound = deferred();
    const mutations: string[] = [];
    let currentGeneration: PtyGeneration = 2;
    const dependencies: DirectTerminalTransitionDependencies = {
      deactivateRuntimes: (_sessionId, expectedGeneration) => {
        mutations.push(`deactivate:${expectedGeneration}`);
      },
      discardOutput: (_sessionId, expectedGeneration) => {
        mutations.push(`discard:${expectedGeneration}`);
      },
      getPtyGeneration: () => currentGeneration,
      invalidateAndWait: () => leaseUnwound.promise,
      resolveProbes: () => undefined,
      withInvalidationSuppressed: (_sessionId, operation) => operation(),
    };
    const coordinator = new TerminalTransitionCoordinator(dependencies);

    const stop = coordinator
      .run('session-a', 2, () => {
        mutations.push('pty:stop');
        return terminalStatus('stopped', 2);
      })
      .catch((error: unknown) => error);
    const restart = coordinator.run('session-a', 2, () => {
      mutations.push('pty:restart');
      currentGeneration = 3;
      return terminalStatus('running', 3);
    });

    leaseUnwound.resolve();
    await expect(stop).resolves.toMatchObject({ message: expect.stringContaining('更新操作取代') });
    await expect(restart).resolves.toMatchObject({ phase: 'running', ptyGeneration: 3 });
    expect(mutations).toEqual(['discard:2', 'deactivate:2', 'pty:restart']);
    expect(currentGeneration).toBe(3);
  });

  it('does not let a stale request supersede a valid pending intent', async () => {
    const leaseUnwound = deferred();
    let currentGeneration: PtyGeneration = 2;
    const mutations: string[] = [];
    const dependencies: DirectTerminalTransitionDependencies = {
      deactivateRuntimes: () => {
        mutations.push('deactivate');
      },
      discardOutput: () => {
        mutations.push('discard');
      },
      getPtyGeneration: () => currentGeneration,
      invalidateAndWait: () => leaseUnwound.promise,
      resolveProbes: () => undefined,
      withInvalidationSuppressed: (_sessionId, operation) => operation(),
    };
    const coordinator = new TerminalTransitionCoordinator(dependencies);
    const validStop = coordinator.run('session-a', 2, () => {
      mutations.push('pty:stop');
      return terminalStatus('stopped', currentGeneration);
    });

    await expect(
      coordinator.run('session-a', 1, () => {
        mutations.push('pty:stale-restart');
        currentGeneration = 3;
        return terminalStatus('running', 3);
      }),
    ).rejects.toThrow('终端已被其他操作替换');

    leaseUnwound.resolve();
    await expect(validStop).resolves.toMatchObject({ phase: 'stopped', ptyGeneration: 2 });
    expect(mutations).toEqual(['discard', 'deactivate', 'pty:stop']);
    expect(currentGeneration).toBe(2);
  });

  it('keeps terminal intents independent across sessions', async () => {
    const releaseA = deferred();
    const releaseB = deferred();
    const mutations: string[] = [];
    const dependencies: DirectTerminalTransitionDependencies = {
      deactivateRuntimes: (sessionId) => {
        mutations.push(`deactivate:${sessionId}`);
      },
      discardOutput: (sessionId) => {
        mutations.push(`discard:${sessionId}`);
      },
      getPtyGeneration: () => 2,
      invalidateAndWait: (sessionId) =>
        sessionId === 'session-a' ? releaseA.promise : releaseB.promise,
      resolveProbes: () => undefined,
      withInvalidationSuppressed: (_sessionId, operation) => operation(),
    };
    const coordinator = new TerminalTransitionCoordinator(dependencies);
    const transitionA = coordinator.run('session-a', 2, () => {
      mutations.push('pty:session-a');
      return terminalStatus('stopped', 2);
    });
    const transitionB = coordinator.run('session-b', 2, () => {
      mutations.push('pty:session-b');
      return { ...terminalStatus('stopped', 2), id: 'session-b' };
    });

    releaseB.resolve();
    await expect(transitionB).resolves.toMatchObject({ id: 'session-b', phase: 'stopped' });
    expect(mutations).toEqual(['discard:session-b', 'deactivate:session-b', 'pty:session-b']);

    releaseA.resolve();
    await expect(transitionA).resolves.toMatchObject({ id: 'session-a', phase: 'stopped' });
    expect(mutations).toEqual([
      'discard:session-b',
      'deactivate:session-b',
      'pty:session-b',
      'discard:session-a',
      'deactivate:session-a',
      'pty:session-a',
    ]);
  });
});

const failedLaunchHarness = (
  initialWorkspaceGeneration: PtyGeneration | undefined,
  initialRuntimeGeneration: PtyGeneration | undefined,
) => {
  const order: string[] = [];
  let prepared = initialRuntimeGeneration === undefined;
  let runtimeGeneration = initialRuntimeGeneration;
  let workspaceGeneration = initialWorkspaceGeneration;
  const dependencies: FailedRuntimeLaunchCleanupDependencies = {
    hasSession: () => {
      order.push('has-session');
      return workspaceGeneration !== undefined;
    },
    stopIfGeneration: (_sessionId, expectedGeneration) => {
      order.push(`stop:${expectedGeneration}`);
      if (workspaceGeneration === expectedGeneration) {
        workspaceGeneration = undefined;
      }
    },
  };
  const runtime: FailedRuntimeLaunchOwner = {
    cleanupPreparedLaunch: () => {
      order.push('cleanup-prepared');
      if (runtimeGeneration === undefined && prepared) {
        prepared = false;
        return true;
      }
      return false;
    },
    setInactive: (_sessionId, expectedGeneration) => {
      order.push(`inactive:${expectedGeneration}`);
      if (runtimeGeneration === expectedGeneration) {
        runtimeGeneration = undefined;
        return true;
      }
      return false;
    },
  };
  return {
    dependencies,
    getPrepared: () => prepared,
    getRuntimeGeneration: () => runtimeGeneration,
    getWorkspaceGeneration: () => workspaceGeneration,
    order,
    runtime,
  };
};

describe('failed runtime launch cleanup', () => {
  it('cannot let stale G2 cleanup stop or deactivate newer G3 ownership', () => {
    const harness = failedLaunchHarness(3, 3);

    cleanupFailedRuntimeLaunch(harness.dependencies, harness.runtime, 'session-a', 2);

    expect(harness.order).toEqual(['has-session', 'stop:2', 'inactive:2', 'cleanup-prepared']);
    expect(harness.getWorkspaceGeneration()).toBe(3);
    expect(harness.getRuntimeGeneration()).toBe(3);
  });

  it('stops and deactivates the exact bound generation', () => {
    const harness = failedLaunchHarness(2, 2);

    cleanupFailedRuntimeLaunch(harness.dependencies, harness.runtime, 'session-a', 2);

    expect(harness.order).toEqual(['has-session', 'stop:2', 'inactive:2']);
    expect(harness.getWorkspaceGeneration()).toBeUndefined();
    expect(harness.getRuntimeGeneration()).toBeUndefined();
  });

  it('stops the predecessor PTY and clears an unbound replacement launch', () => {
    const harness = failedLaunchHarness(2, undefined);

    cleanupFailedRuntimeLaunch(harness.dependencies, harness.runtime, 'session-a', 2);

    expect(harness.order).toEqual(['has-session', 'stop:2', 'inactive:2', 'cleanup-prepared']);
    expect(harness.getPrepared()).toBe(false);
    expect(harness.getWorkspaceGeneration()).toBeUndefined();
  });

  it('uses prepared-launch cleanup before a PTY generation has been bound', () => {
    const harness = failedLaunchHarness(2, undefined);

    cleanupFailedRuntimeLaunch(harness.dependencies, harness.runtime, 'session-a');

    expect(harness.order).toEqual(['cleanup-prepared']);
    expect(harness.getPrepared()).toBe(false);
    expect(harness.getWorkspaceGeneration()).toBe(2);
  });
});

describe('terminal lifecycle reconciliation', () => {
  it('recognizes only stopped and error as terminal failure phases', () => {
    expect(isTerminalFailurePhase('starting')).toBe(false);
    expect(isTerminalFailurePhase('running')).toBe(false);
    expect(isTerminalFailurePhase('stopped')).toBe(true);
    expect(isTerminalFailurePhase('error')).toBe(true);
  });

  it('does not turn an initial or repeated stopped snapshot into another lifecycle event', () => {
    expect(enteredTerminalFailure(undefined, baseline('stopped', 0))).toBe(false);
    expect(enteredTerminalFailure(baseline('stopped', 4), baseline('stopped', 4))).toBe(false);
    expect(enteredTerminalFailure(baseline('error', 4), baseline('stopped', 4))).toBe(false);
  });

  it('reconciles a running generation exactly once when it stops or errors', () => {
    expect(enteredTerminalFailure(baseline('running', 8), baseline('stopped', 8))).toBe(true);
    expect(enteredTerminalFailure(baseline('starting', 9), baseline('error', 9))).toBe(true);
  });

  it('treats a failed replacement generation as a new transition', () => {
    expect(enteredTerminalFailure(baseline('stopped', 2), baseline('error', 3))).toBe(true);
    expect(enteredTerminalFailure(baseline('running', 2), baseline('running', 3))).toBe(false);
  });
});
