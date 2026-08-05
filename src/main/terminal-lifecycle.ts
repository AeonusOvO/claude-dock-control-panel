import type { PtyGeneration, TerminalStatus } from '../shared/contracts';

export type TerminalStatusBaseline = Pick<TerminalStatus, 'phase' | 'ptyGeneration'>;

export interface DirectTerminalTransitionDependencies {
  deactivateRuntimes: (sessionId: string, expectedGeneration: PtyGeneration) => void;
  discardOutput: (sessionId: string, expectedGeneration: PtyGeneration) => void;
  getPtyGeneration: (sessionId: string) => PtyGeneration;
  invalidateAndWait: (sessionId: string) => Promise<void>;
  resolveProbes: (sessionId: string, expectedGeneration: PtyGeneration) => void;
  withInvalidationSuppressed: (
    sessionId: string,
    operation: () => TerminalStatus,
  ) => TerminalStatus;
}

export interface FailedRuntimeLaunchCleanupDependencies {
  hasSession: (sessionId: string) => boolean;
  stopIfGeneration: (sessionId: string, expectedGeneration: PtyGeneration) => unknown;
}

export interface FailedRuntimeLaunchOwner {
  cleanupPreparedLaunch: (sessionId: string) => unknown;
  setInactive: (sessionId: string, expectedGeneration: PtyGeneration) => unknown;
}

const TERMINAL_REPLACED_MESSAGE = '终端已被其他操作替换，这次控制请求已取消。';

const assertExpectedGeneration = (
  dependencies: DirectTerminalTransitionDependencies,
  sessionId: string,
  expectedGeneration: PtyGeneration,
): void => {
  if (dependencies.getPtyGeneration(sessionId) !== expectedGeneration) {
    throw new Error(TERMINAL_REPLACED_MESSAGE);
  }
};

/**
 * Transfers direct start/restart/stop ownership from cancellable launch work to one synchronous PTY
 * mutation. Probe resolution happens immediately after invalidation because the cancelled lease may
 * itself be waiting for that generation's renderer reply before it can unwind.
 */
export const runDirectTerminalTransition = async (
  dependencies: DirectTerminalTransitionDependencies,
  sessionId: string,
  expectedGeneration: PtyGeneration,
  operation: () => TerminalStatus,
): Promise<TerminalStatus> => {
  // A stale renderer request must be observational: it cannot cancel or clean up the current owner.
  assertExpectedGeneration(dependencies, sessionId, expectedGeneration);

  const leaseUnwound = dependencies.invalidateAndWait(sessionId);
  dependencies.resolveProbes(sessionId, expectedGeneration);
  await leaseUnwound;

  // The cancelled owner may have replaced the PTY while unwinding. Nothing below may cross generations.
  assertExpectedGeneration(dependencies, sessionId, expectedGeneration);
  dependencies.discardOutput(sessionId, expectedGeneration);
  dependencies.deactivateRuntimes(sessionId, expectedGeneration);
  return dependencies.withInvalidationSuppressed(sessionId, operation);
};

/** Cleans only the runtime/PTY generation owned by a failed launch attempt. */
export const cleanupFailedRuntimeLaunch = (
  dependencies: FailedRuntimeLaunchCleanupDependencies,
  runtime: FailedRuntimeLaunchOwner,
  sessionId: string,
  ownedGeneration?: PtyGeneration,
): void => {
  if (ownedGeneration === undefined) {
    runtime.cleanupPreparedLaunch(sessionId);
    return;
  }
  if (dependencies.hasSession(sessionId)) {
    dependencies.stopIfGeneration(sessionId, ownedGeneration);
  }
  runtime.setInactive(sessionId, ownedGeneration);
};

export const isTerminalFailurePhase = (phase: TerminalStatus['phase']): boolean =>
  phase === 'stopped' || phase === 'error';

/**
 * Repeated workspace snapshots are observations, not lifecycle events. A runtime is reconciled only
 * when its exact PTY generation newly enters a terminal failure phase.
 */
export const enteredTerminalFailure = (
  previous: TerminalStatusBaseline | undefined,
  current: TerminalStatusBaseline,
): boolean =>
  isTerminalFailurePhase(current.phase) &&
  Boolean(
    previous &&
    (previous.ptyGeneration !== current.ptyGeneration || !isTerminalFailurePhase(previous.phase)),
  );
