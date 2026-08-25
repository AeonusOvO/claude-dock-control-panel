export type SessionOperationAssertion = () => void;

const sessionOperationStampBrand: unique symbol = Symbol('session-operation-stamp');

/** Equality-only main-process lifecycle revision that survives completion of the live operation lease. */
export interface SessionOperationStamp {
  readonly revision: number;
  readonly sessionId: string;
  readonly [sessionOperationStampBrand]: true;
}

/** The shape handlers receive when the coordinator is injected as a dependency rather than used directly. */
export type WithSessionOperation = <T>(
  sessionId: string,
  operation: (assertCurrent: SessionOperationAssertion, signal: AbortSignal) => Promise<T>,
) => Promise<T>;

interface SessionOperationLease {
  cancelled: boolean;
  completed: Promise<void>;
  controller: AbortController;
  generation: number;
  resolveCompleted: () => void;
}

/**
 * Serializes terminal-mutating work per workspace session. Invalidating an operation makes every
 * later ownership check fail, but deliberately keeps the lease occupied until the cancelled callback
 * has unwound so a replacement operation cannot overlap its cleanup.
 */
export class SessionOperationCoordinator {
  private readonly leases = new Map<string, SessionOperationLease>();
  private nextGeneration = 0;
  private nextRevision = 0;
  private readonly revisionBySession = new Map<string, number>();

  public constructor(
    private readonly hasSession: (sessionId: string) => boolean,
    private readonly busyMessage = '这个开发会话的上一个启动或切换操作尚未完成，请稍候。',
    private readonly cancelledMessage = '这个启动操作已被新的终端或会话操作取消。',
  ) {}

  public captureStamp(sessionId: string): SessionOperationStamp {
    if (!this.hasSession(sessionId)) {
      throw new Error('开发会话已经不存在，不能创建新的操作授权。');
    }
    return Object.freeze({
      revision: this.revisionBySession.get(sessionId) ?? 0,
      sessionId,
      [sessionOperationStampBrand]: true as const,
    });
  }

  public assertStampCurrent(stamp: SessionOperationStamp): void {
    if (
      !this.hasSession(stamp.sessionId) ||
      (this.revisionBySession.get(stamp.sessionId) ?? 0) !== stamp.revision
    ) {
      throw new Error('开发会话在等待启动确认期间已执行其他操作，本次授权已失效。');
    }
  }

  public invalidate(sessionId: string): void {
    this.advanceRevision(sessionId);
    const lease = this.leases.get(sessionId);
    if (lease) {
      this.cancel(lease);
    }
  }

  public invalidateAndWait(sessionId: string): Promise<void> {
    this.advanceRevision(sessionId);
    const lease = this.leases.get(sessionId);
    if (!lease) {
      return Promise.resolve();
    }
    this.cancel(lease);
    return lease.completed;
  }

  /** Cancels only the lease represented by the exact signal handed to its operation callback. */
  public async invalidateAndWaitIfSignal(
    sessionId: string,
    expectedSignal: AbortSignal,
  ): Promise<boolean> {
    const lease = this.leases.get(sessionId);
    if (!lease || lease.controller.signal !== expectedSignal) {
      return false;
    }
    this.advanceRevision(sessionId);
    this.cancel(lease);
    await lease.completed;
    return true;
  }

  public removeSession(sessionId: string): void {
    // Keep the advanced revision as a durable tombstone. If the same opaque session ID is ever
    // recreated, no stamp captured by the removed incarnation may become current again.
    this.invalidate(sessionId);
  }

  public isBusy(sessionId: string): boolean {
    return this.leases.has(sessionId);
  }

  public async run<T>(
    sessionId: string,
    operation: (assertCurrent: SessionOperationAssertion, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.leases.has(sessionId)) {
      throw new Error(this.busyMessage);
    }
    return this.execute(sessionId, this.reserve(sessionId), operation);
  }

  /** Atomically admits a paused-launch continuation only if no later session operation was reserved. */
  public runIfStampCurrent<T>(
    stamp: SessionOperationStamp,
    operation: (assertCurrent: SessionOperationAssertion, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.leases.has(stamp.sessionId)) {
      return Promise.reject(new Error(this.busyMessage));
    }
    try {
      this.assertStampCurrent(stamp);
    } catch (error) {
      return Promise.reject(error);
    }
    const lease = this.reserve(stamp.sessionId);
    return this.execute(stamp.sessionId, lease, operation);
  }

  /**
   * Synchronously reserves the replacement intent, aborts the predecessor, and keeps the new lease
   * exclusive while predecessor cleanup unwinds. This is used by destructive main-owned operations
   * that must revalidate and close a session without a new launch slipping into the handoff gap.
   */
  public runLatest<T>(
    sessionId: string,
    operation: (assertCurrent: SessionOperationAssertion, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const predecessor = this.leases.get(sessionId);
    if (predecessor) {
      this.cancel(predecessor);
    }
    const lease = this.reserve(sessionId);
    return this.execute(sessionId, lease, async (assertCurrent, signal) => {
      await predecessor?.completed;
      assertCurrent();
      return operation(assertCurrent, signal);
    });
  }

  private assertion(sessionId: string, lease: SessionOperationLease): SessionOperationAssertion {
    return () => {
      const current = this.leases.get(sessionId);
      if (
        lease.cancelled ||
        current !== lease ||
        current.generation !== lease.generation ||
        !this.hasSession(sessionId)
      ) {
        const reason = lease.controller.signal.reason;
        throw reason instanceof Error ? reason : new Error(this.cancelledMessage);
      }
    };
  }

  private async execute<T>(
    sessionId: string,
    lease: SessionOperationLease,
    operation: (assertCurrent: SessionOperationAssertion, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const assertCurrent = this.assertion(sessionId, lease);
    try {
      return await operation(assertCurrent, lease.controller.signal);
    } finally {
      if (this.leases.get(sessionId) === lease) {
        this.leases.delete(sessionId);
      }
      lease.resolveCompleted();
    }
  }

  private reserve(sessionId: string): SessionOperationLease {
    this.advanceRevision(sessionId);
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const lease: SessionOperationLease = {
      cancelled: false,
      completed,
      controller: new AbortController(),
      generation: ++this.nextGeneration,
      resolveCompleted,
    };
    this.leases.set(sessionId, lease);
    return lease;
  }

  private advanceRevision(sessionId: string): void {
    this.revisionBySession.set(sessionId, ++this.nextRevision);
  }

  private cancel(lease: SessionOperationLease): void {
    lease.cancelled = true;
    if (!lease.controller.signal.aborted) {
      lease.controller.abort(new Error(this.cancelledMessage));
    }
  }
}
