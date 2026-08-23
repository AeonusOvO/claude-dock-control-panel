import type { PtyGeneration, TerminalStatus } from '../../shared/contracts';
import type { TerminalEnvironmentOverrides } from './session';

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
  abortPreparedLaunch?: (launchToken: object, expectedGeneration?: PtyGeneration) => boolean;
  cleanupFailedLaunchGeneration?: (sessionId: string, expectedGeneration: PtyGeneration) => boolean;
  cleanupPreparedLaunch: (sessionId: string) => boolean;
  setInactive: (sessionId: string, expectedGeneration: PtyGeneration) => boolean;
}

/** A runtime that can claim the PTY a restart creates and write its launch command into it. */
export interface TerminalRuntimeOwner extends FailedRuntimeLaunchOwner {
  bindPty: (sessionId: string, ptyGeneration: PtyGeneration, launchToken?: object) => void;
  writeTerminal: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => boolean;
}

/** Scope one synchronous restart so its exact launch intent can own the resulting PTY edge. */
export type WithExpectedPtyReplacement = (
  predecessor: PtyGeneration,
  restart: () => TerminalStatus,
) => TerminalStatus;

/**
 * Replaces a session's PowerShell and hands the new generation to `runtime`. Declared here so every
 * IPC domain that launches a runtime injects the same signature instead of restating it.
 */
export type RestartRuntimeTerminal = (
  runtime: TerminalRuntimeOwner,
  sessionId: string,
  environment: TerminalEnvironmentOverrides | undefined,
  command: string,
  failureMessage: string,
  assertCurrent: () => void,
  ownGeneration: (ptyGeneration: PtyGeneration) => void,
  launchToken?: object,
  withExpectedPtyReplacement?: WithExpectedPtyReplacement,
) => TerminalStatus;

/**
 * Replaces a session's PowerShell and resumes an existing conversation in it, returning the PTY
 * generation the caller now owns. Declared here so every IPC domain that resumes a conversation
 * injects the same signature instead of restating it.
 */
export type ResumeConversationInTerminal = (
  sessionId: string,
  cwd: string,
  conversationId: string,
  failureMessage: string,
  assertCurrent: () => void,
  launchAuthorization?: object,
  assertPreparationCurrent?: () => void,
  signal?: AbortSignal,
  withExpectedPtyReplacement?: WithExpectedPtyReplacement,
) => Promise<PtyGeneration>;

const TERMINAL_REPLACED_MESSAGE = '终端已被其他操作替换，这次控制请求已取消。';
const TERMINAL_TRANSITION_SUPERSEDED_MESSAGE = '这次终端控制已被同一会话的更新操作取代。';

const assertExpectedGeneration = (
  dependencies: DirectTerminalTransitionDependencies,
  sessionId: string,
  expectedGeneration: PtyGeneration,
): void => {
  if (dependencies.getPtyGeneration(sessionId) !== expectedGeneration) {
    throw new Error(TERMINAL_REPLACED_MESSAGE);
  }
};

interface TerminalTransitionIntent {
  completed: Promise<void>;
  expectedGeneration: PtyGeneration;
  predecessor: Promise<void>;
  resolveCompleted: () => void;
  sessionId: string;
  superseded: boolean;
}

/**
 * Transfers direct start/restart/stop ownership from cancellable launch work to the latest accepted
 * synchronous PTY mutation. Probe resolution happens immediately after invalidation because the
 * cancelled lease may itself be waiting for that generation's renderer reply before it can unwind.
 */
export class TerminalTransitionCoordinator {
  private readonly current = new Map<string, TerminalTransitionIntent>();

  public constructor(private readonly dependencies: DirectTerminalTransitionDependencies) {}

  public async run(
    sessionId: string,
    expectedGeneration: PtyGeneration,
    operation: () => TerminalStatus,
  ): Promise<TerminalStatus> {
    // A stale renderer request must be observational: it cannot supersede or clean up a valid intent.
    assertExpectedGeneration(this.dependencies, sessionId, expectedGeneration);
    const intent = this.reserve(sessionId, expectedGeneration);
    return this.execute(intent, operation);
  }

  private assertCurrent(intent: TerminalTransitionIntent): void {
    if (intent.superseded || this.current.get(intent.sessionId) !== intent) {
      throw new Error(TERMINAL_TRANSITION_SUPERSEDED_MESSAGE);
    }
  }

  private async execute(
    intent: TerminalTransitionIntent,
    operation: () => TerminalStatus,
  ): Promise<TerminalStatus> {
    try {
      const leaseUnwound = this.dependencies.invalidateAndWait(intent.sessionId);
      this.dependencies.resolveProbes(intent.sessionId, intent.expectedGeneration);
      await Promise.all([intent.predecessor, leaseUnwound]);

      this.assertCurrent(intent);
      // The cancelled owner may have replaced the PTY while unwinding. Nothing below may cross generations.
      assertExpectedGeneration(this.dependencies, intent.sessionId, intent.expectedGeneration);
      this.dependencies.discardOutput(intent.sessionId, intent.expectedGeneration);
      this.dependencies.deactivateRuntimes(intent.sessionId, intent.expectedGeneration);
      return this.dependencies.withInvalidationSuppressed(intent.sessionId, operation);
    } finally {
      if (this.current.get(intent.sessionId) === intent) {
        this.current.delete(intent.sessionId);
      }
      intent.resolveCompleted();
    }
  }

  private reserve(sessionId: string, expectedGeneration: PtyGeneration): TerminalTransitionIntent {
    const previous = this.current.get(sessionId);
    if (previous) {
      previous.superseded = true;
    }
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const intent: TerminalTransitionIntent = {
      completed,
      expectedGeneration,
      predecessor: previous?.completed ?? Promise.resolve(),
      resolveCompleted,
      sessionId,
      superseded: false,
    };
    this.current.set(sessionId, intent);
    return intent;
  }
}

/** Cleans only the runtime/PTY generation owned by a failed launch attempt. */
export const cleanupFailedRuntimeLaunch = (
  dependencies: FailedRuntimeLaunchCleanupDependencies,
  runtime: FailedRuntimeLaunchOwner,
  sessionId: string,
  ownedGeneration?: PtyGeneration,
  launchToken?: object,
): void => {
  if (launchToken && runtime.abortPreparedLaunch) {
    try {
      if (ownedGeneration !== undefined && dependencies.hasSession(sessionId)) {
        dependencies.stopIfGeneration(sessionId, ownedGeneration);
      }
    } finally {
      runtime.abortPreparedLaunch(launchToken, ownedGeneration);
    }
    return;
  }
  if (ownedGeneration === undefined) {
    runtime.cleanupPreparedLaunch(sessionId);
    return;
  }
  if (dependencies.hasSession(sessionId)) {
    dependencies.stopIfGeneration(sessionId, ownedGeneration);
  }
  if (runtime.cleanupFailedLaunchGeneration?.(sessionId, ownedGeneration)) {
    return;
  }
  if (!runtime.setInactive(sessionId, ownedGeneration)) {
    runtime.cleanupPreparedLaunch(sessionId);
  }
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
