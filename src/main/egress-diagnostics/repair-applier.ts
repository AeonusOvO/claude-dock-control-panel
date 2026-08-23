import {
  type EgressRepairJournalPort,
  type EgressRepairReconciliation,
  type EgressRepairTransaction,
  type EgressRepairTransactionId,
  type EgressRepairTransactionState,
} from './repair-journal';
import {
  type EgressProcessPolicyRevision,
  type EgressProcessPolicySnapshot,
  type EgressProcessPolicyStorePort,
} from './process-policy-store';
import {
  type EgressProcessPolicyEdits,
  type EgressRepairActivation,
  normalizeEgressProcessPolicyEdits,
} from './process-policy-types';
import {
  type EgressRepairPlan,
  EgressRepairPlanner,
  planEgressProcessPolicyRepair,
} from './repair-planner';

export interface EgressRepairMutex {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/** Queue implementation intended to be instantiated once and injected process-wide. */
export class EgressRepairSerialMutex implements EgressRepairMutex {
  private tail: Promise<void> = Promise.resolve();

  public runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.tail.catch(() => undefined).then(operation);
    this.tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

export interface EgressRepairApplyRequest {
  readonly edits: EgressProcessPolicyEdits;
  readonly expectedRevision: EgressProcessPolicyRevision;
}

export interface EgressRepairApplyResult {
  readonly plan: EgressRepairPlan;
  readonly revision: EgressProcessPolicyRevision;
  readonly state: 'unchanged' | 'applied';
  readonly transactionId?: EgressRepairTransactionId;
}

export interface EgressRepairRollbackResult {
  readonly activationRequirements: readonly EgressRepairActivation[];
  readonly alreadyRolledBack: boolean;
  readonly revision: EgressProcessPolicyRevision;
  readonly state: 'rolled-back';
  readonly transactionId: EgressRepairTransactionId;
}

export type EgressRepairPolicyState = 'before' | 'after' | 'other' | 'unknown';

export interface EgressRepairApplierOptions {
  readonly journal: EgressRepairJournalPort;
  readonly mutex: EgressRepairMutex;
  readonly store: EgressProcessPolicyStorePort;
}

export class EgressRepairRevisionConflictError extends Error {
  public constructor() {
    super('进程策略已发生变化，请重新执行预览后再应用。');
    this.name = 'EgressRepairRevisionConflictError';
  }
}

export class EgressRepairUnknownTransactionError extends Error {
  public constructor() {
    super('修复事务标识无效或已不在保留范围内。');
    this.name = 'EgressRepairUnknownTransactionError';
  }
}

export class EgressRepairRollbackConflictError extends Error {
  public constructor() {
    super('修复事务之后已有更新，ClaudeDock 不会覆盖较新的进程策略。');
    this.name = 'EgressRepairRollbackConflictError';
  }
}

export class EgressRepairNotAppliedError extends Error {
  public constructor() {
    super('这次修复没有应用，因此没有可持久回滚的策略变更。');
    this.name = 'EgressRepairNotAppliedError';
  }
}

export class EgressRepairTransactionError extends Error {
  public constructor(
    public readonly transactionId: EgressRepairTransactionId,
    public readonly state: EgressRepairTransactionState,
    public readonly policyState: EgressRepairPolicyState,
  ) {
    super('修复事务未能完整完成；ClaudeDock 已保留可核对的持久状态。');
    this.name = 'EgressRepairTransactionError';
  }
}

const REVISION = /^epr1_[A-Za-z0-9_-]{43}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeApplyRequest = (value: unknown): EgressRepairApplyRequest => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'edits') ||
    !Object.hasOwn(value, 'expectedRevision') ||
    typeof value.expectedRevision !== 'string' ||
    !REVISION.test(value.expectedRevision)
  ) {
    throw new EgressRepairRevisionConflictError();
  }
  return Object.freeze({
    edits: normalizeEgressProcessPolicyEdits(value.edits),
    expectedRevision: value.expectedRevision as EgressProcessPolicyRevision,
  });
};

export class EgressRepairApplier {
  private readonly planner: EgressRepairPlanner;

  public constructor(private readonly options: EgressRepairApplierOptions) {
    this.planner = new EgressRepairPlanner(options.store);
  }

  public apply(request: EgressRepairApplyRequest): Promise<EgressRepairApplyResult> {
    const normalized = normalizeApplyRequest(request);
    return this.options.mutex.runExclusive(async () => {
      const current = this.options.store.read();
      if (current.revision !== normalized.expectedRevision) {
        throw new EgressRepairRevisionConflictError();
      }
      const plan = planEgressProcessPolicyRepair(current, normalized.edits, (policy) =>
        this.options.store.revisionFor(policy),
      );
      if (plan.changes.length === 0) {
        return Object.freeze({ plan, revision: current.revision, state: 'unchanged' as const });
      }

      const prepared = this.options.journal.prepare(plan);
      this.assertPreparedMatchesPlan(prepared, plan);
      let written: EgressProcessPolicySnapshot;
      try {
        written = this.options.store.write(plan.after);
      } catch {
        throw this.reconciledFailure(prepared);
      }
      if (written.revision !== plan.resultingRevision) {
        this.markConflictBestEffort(prepared.id);
        throw new EgressRepairTransactionError(prepared.id, 'conflict', 'other');
      }
      try {
        const applied = this.options.journal.markApplied(prepared.id);
        return Object.freeze({
          plan,
          revision: written.revision,
          state: 'applied' as const,
          transactionId: applied.id,
        });
      } catch {
        throw new EgressRepairTransactionError(
          prepared.id,
          this.durableState(prepared.id, 'prepared'),
          'after',
        );
      }
    });
  }

  public dryRun(edits: EgressProcessPolicyEdits): EgressRepairPlan {
    return this.planner.plan(edits);
  }

  public reconcile(): Promise<readonly EgressRepairReconciliation[]> {
    return this.options.mutex.runExclusive(async () => {
      for (const transaction of this.options.journal.list()) {
        if (
          (transaction.state === 'prepared' || transaction.state === 'rollback-prepared') &&
          !this.transactionIntegrityValid(transaction)
        ) {
          this.options.journal.markConflict(transaction.id);
        }
      }
      return this.options.journal.reconcile(this.options.store.read());
    });
  }

  public rollback(transactionId: string): Promise<EgressRepairRollbackResult> {
    return this.options.mutex.runExclusive(async () => {
      let transaction = this.requireTransaction(transactionId);
      if (!this.transactionIntegrityValid(transaction)) {
        this.markConflictBestEffort(transaction.id);
        throw new EgressRepairRollbackConflictError();
      }
      if (transaction.state === 'rolled-back') {
        return this.rollbackResult(transaction, true);
      }
      if (transaction.state === 'prepared' || transaction.state === 'rollback-prepared') {
        transaction = this.options.journal.reconcileTransaction(
          transaction.id,
          this.options.store.read(),
        );
      }
      if (transaction.state === 'rolled-back') return this.rollbackResult(transaction, true);
      if (transaction.state === 'failed') throw new EgressRepairNotAppliedError();
      if (transaction.state !== 'applied') throw new EgressRepairRollbackConflictError();

      const current = this.options.store.read();
      if (current.revision !== transaction.afterRevision) {
        this.markConflictBestEffort(transaction.id);
        throw new EgressRepairRollbackConflictError();
      }
      this.options.journal.markRollbackPrepared(transaction.id);
      let restored: EgressProcessPolicySnapshot;
      try {
        restored = this.options.store.write(transaction.before);
      } catch {
        throw this.reconciledFailure(transaction);
      }
      if (restored.revision !== transaction.beforeRevision) {
        this.markConflictBestEffort(transaction.id);
        throw new EgressRepairTransactionError(transaction.id, 'conflict', 'other');
      }
      try {
        const rolledBack = this.options.journal.markRolledBack(transaction.id);
        return Object.freeze({
          activationRequirements: rolledBack.activationRequirements,
          alreadyRolledBack: false,
          revision: restored.revision,
          state: 'rolled-back' as const,
          transactionId: rolledBack.id,
        });
      } catch {
        throw new EgressRepairTransactionError(
          transaction.id,
          this.durableState(transaction.id, 'rollback-prepared'),
          'before',
        );
      }
    });
  }

  private assertPreparedMatchesPlan(
    transaction: EgressRepairTransaction,
    plan: EgressRepairPlan,
  ): void {
    if (
      transaction.state !== 'prepared' ||
      transaction.beforeRevision !== plan.expectedRevision ||
      transaction.afterRevision !== plan.resultingRevision ||
      !this.transactionIntegrityValid(transaction)
    ) {
      this.markConflictBestEffort(transaction.id);
      throw new EgressRepairTransactionError(transaction.id, 'conflict', 'before');
    }
  }

  private transactionIntegrityValid(transaction: EgressRepairTransaction): boolean {
    try {
      return (
        this.options.store.revisionFor(transaction.before) === transaction.beforeRevision &&
        this.options.store.revisionFor(transaction.after) === transaction.afterRevision
      );
    } catch {
      return false;
    }
  }

  private reconciledFailure(transaction: EgressRepairTransaction): EgressRepairTransactionError {
    try {
      const snapshot = this.options.store.read();
      const reconciled = this.options.journal.reconcileTransaction(transaction.id, snapshot);
      return new EgressRepairTransactionError(
        transaction.id,
        reconciled.state,
        this.policyState(transaction, snapshot.revision),
      );
    } catch {
      return new EgressRepairTransactionError(
        transaction.id,
        this.durableState(transaction.id, transaction.state),
        'unknown',
      );
    }
  }

  private policyState(
    transaction: EgressRepairTransaction,
    revision: EgressProcessPolicyRevision,
  ): EgressRepairPolicyState {
    if (revision === transaction.beforeRevision) return 'before';
    if (revision === transaction.afterRevision) return 'after';
    return 'other';
  }

  private durableState(
    transactionId: EgressRepairTransactionId,
    fallback: EgressRepairTransactionState,
  ): EgressRepairTransactionState {
    try {
      return this.options.journal.get(transactionId)?.state ?? fallback;
    } catch {
      return fallback;
    }
  }

  private markConflictBestEffort(transactionId: EgressRepairTransactionId): void {
    try {
      this.options.journal.markConflict(transactionId);
    } catch {
      // The existing durable state remains authoritative when the conflict marker cannot be saved.
    }
  }

  private requireTransaction(transactionId: string): EgressRepairTransaction {
    const transaction = this.options.journal.get(transactionId);
    if (!transaction) throw new EgressRepairUnknownTransactionError();
    return transaction;
  }

  private rollbackResult(
    transaction: EgressRepairTransaction,
    alreadyRolledBack: boolean,
  ): EgressRepairRollbackResult {
    return Object.freeze({
      activationRequirements: transaction.activationRequirements,
      alreadyRolledBack,
      revision: transaction.beforeRevision,
      state: 'rolled-back' as const,
      transactionId: transaction.id,
    });
  }
}
