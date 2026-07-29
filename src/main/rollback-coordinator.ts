type RollbackStep = () => Promise<void> | void;

export class RollbackCoordinator {
  private committed = false;
  private rolledBack = false;
  private readonly steps: RollbackStep[] = [];

  public add(step: RollbackStep): void {
    if (this.committed || this.rolledBack) {
      throw new Error('事务已经结束，不能再添加回滚步骤。');
    }
    this.steps.push(step);
  }

  public commit(): void {
    this.committed = true;
    this.steps.length = 0;
  }

  public async rollback(): Promise<void> {
    if (this.committed || this.rolledBack) {
      return;
    }
    this.rolledBack = true;
    for (const step of [...this.steps].reverse()) {
      try {
        await step();
      } catch {
        // Rollback is best-effort and idempotent; the original failure remains authoritative.
      }
    }
    this.steps.length = 0;
  }
}
