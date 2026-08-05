export type SessionOperationAssertion = () => void;

interface SessionOperationLease {
  cancelled: boolean;
  completed: Promise<void>;
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

  public constructor(
    private readonly hasSession: (sessionId: string) => boolean,
    private readonly busyMessage = '这个开发会话的上一个启动或切换操作尚未完成，请稍候。',
    private readonly cancelledMessage = '这个启动操作已被新的终端或会话操作取消。',
  ) {}

  public invalidate(sessionId: string): void {
    const lease = this.leases.get(sessionId);
    if (lease) {
      lease.cancelled = true;
    }
  }

  public invalidateAndWait(sessionId: string): Promise<void> {
    const lease = this.leases.get(sessionId);
    if (!lease) {
      return Promise.resolve();
    }
    lease.cancelled = true;
    return lease.completed;
  }

  public isBusy(sessionId: string): boolean {
    return this.leases.has(sessionId);
  }

  public async run<T>(
    sessionId: string,
    operation: (assertCurrent: SessionOperationAssertion) => Promise<T>,
  ): Promise<T> {
    if (this.leases.has(sessionId)) {
      throw new Error(this.busyMessage);
    }
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const lease: SessionOperationLease = {
      cancelled: false,
      completed,
      generation: ++this.nextGeneration,
      resolveCompleted,
    };
    this.leases.set(sessionId, lease);
    const assertCurrent = (): void => {
      const current = this.leases.get(sessionId);
      if (
        lease.cancelled ||
        current !== lease ||
        current.generation !== lease.generation ||
        !this.hasSession(sessionId)
      ) {
        throw new Error(this.cancelledMessage);
      }
    };

    try {
      return await operation(assertCurrent);
    } finally {
      if (this.leases.get(sessionId) === lease) {
        this.leases.delete(sessionId);
      }
      lease.resolveCompleted();
    }
  }
}
