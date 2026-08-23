import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  type EgressAtomicFileOperations,
  readEgressBoundedUtf8File,
  replaceEgressFileAtomically,
} from './atomic-store';
import type {
  EgressProcessPolicyRevision,
  EgressProcessPolicySnapshot,
} from './process-policy-store';
import {
  cloneEgressProcessPolicy,
  EGRESS_REPAIR_ACTIVATIONS,
  type EgressProcessPolicy,
  type EgressRepairActivation,
  normalizeEgressProcessPolicy,
} from './process-policy-types';
import type { EgressRepairPlan } from './repair-planner';

export const EGRESS_REPAIR_JOURNAL_VERSION = 1 as const;
export const EGRESS_REPAIR_JOURNAL_MAX_BYTES = 512 * 1024;
export const EGRESS_REPAIR_JOURNAL_MAX_TRANSACTIONS = 64;

export type EgressRepairTransactionId = string & {
  readonly __egressRepairTransactionId: unique symbol;
};

export type EgressRepairTransactionState =
  'prepared' | 'applied' | 'rollback-prepared' | 'rolled-back' | 'failed' | 'conflict';

export type EgressRepairTransactionFailure = 'not-applied' | 'conflict' | null;

export interface EgressRepairTransaction {
  readonly activationRequirements: readonly EgressRepairActivation[];
  readonly after: EgressProcessPolicy;
  readonly afterRevision: EgressProcessPolicyRevision;
  readonly before: EgressProcessPolicy;
  readonly beforeRevision: EgressProcessPolicyRevision;
  readonly failure: EgressRepairTransactionFailure;
  readonly id: EgressRepairTransactionId;
  readonly preparedAt: number;
  readonly state: EgressRepairTransactionState;
  readonly updatedAt: number;
}

export interface EgressRepairReconciliation {
  readonly from: 'prepared' | 'rollback-prepared';
  readonly to: EgressRepairTransactionState;
  readonly transactionId: EgressRepairTransactionId;
}

export interface EgressRepairJournalPort {
  get(transactionId: string): EgressRepairTransaction | undefined;
  list(): readonly EgressRepairTransaction[];
  markApplied(transactionId: EgressRepairTransactionId): EgressRepairTransaction;
  markConflict(transactionId: EgressRepairTransactionId): EgressRepairTransaction;
  markRollbackPrepared(transactionId: EgressRepairTransactionId): EgressRepairTransaction;
  markRolledBack(transactionId: EgressRepairTransactionId): EgressRepairTransaction;
  prepare(plan: EgressRepairPlan): EgressRepairTransaction;
  reconcile(snapshot: EgressProcessPolicySnapshot): readonly EgressRepairReconciliation[];
  reconcileTransaction(
    transactionId: EgressRepairTransactionId,
    snapshot: EgressProcessPolicySnapshot,
  ): EgressRepairTransaction;
}

export interface EgressRepairJournalOptions {
  readonly atomicOperations?: Partial<EgressAtomicFileOperations>;
  readonly createTransactionId?: () => string;
  readonly now?: () => number;
}

export class EgressRepairJournalError extends Error {
  public constructor(message = 'ClaudeDock 无法安全读取或保存修复日志。') {
    super(message);
    this.name = 'EgressRepairJournalError';
  }
}

export class EgressRepairJournalUnsupportedVersionError extends EgressRepairJournalError {
  public constructor() {
    super('修复日志由更新版本的 ClaudeDock 创建，当前版本不会覆盖它。');
    this.name = 'EgressRepairJournalUnsupportedVersionError';
  }
}

interface RepairJournalDocument {
  readonly transactions: EgressRepairTransaction[];
  readonly version: typeof EGRESS_REPAIR_JOURNAL_VERSION;
}

interface MissingCandidate {
  readonly kind: 'missing';
}

interface InvalidCandidate {
  readonly kind: 'invalid';
}

interface FutureCandidate {
  readonly kind: 'future';
}

interface UnclassifiableCandidate {
  readonly kind: 'unclassifiable';
}

interface ValidCandidate {
  readonly document: RepairJournalDocument;
  readonly kind: 'valid';
  readonly raw: string;
}

type JournalCandidate =
  MissingCandidate | InvalidCandidate | FutureCandidate | UnclassifiableCandidate | ValidCandidate;

interface LoadedJournal {
  readonly backup: JournalCandidate;
  readonly document: RepairJournalDocument;
  readonly primary: JournalCandidate;
}

const TRANSACTION_ID = /^[A-Za-z0-9_-]{32}$/;
const REVISION = /^epr1_[A-Za-z0-9_-]{43}$/;
const JOURNAL_STATES: readonly EgressRepairTransactionState[] = [
  'prepared',
  'applied',
  'rollback-prepared',
  'rolled-back',
  'failed',
  'conflict',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};

const finiteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const normalizeActivations = (value: unknown): readonly EgressRepairActivation[] => {
  if (!Array.isArray(value) || value.length > EGRESS_REPAIR_ACTIVATIONS.length) {
    throw new EgressRepairJournalError();
  }
  const requested = new Set<EgressRepairActivation>();
  for (const activation of value) {
    if (
      typeof activation !== 'string' ||
      !EGRESS_REPAIR_ACTIVATIONS.includes(activation as EgressRepairActivation) ||
      requested.has(activation as EgressRepairActivation)
    ) {
      throw new EgressRepairJournalError();
    }
    requested.add(activation as EgressRepairActivation);
  }
  return Object.freeze(EGRESS_REPAIR_ACTIVATIONS.filter((item) => requested.has(item)));
};

const validFailure = (
  state: EgressRepairTransactionState,
  failure: unknown,
): failure is EgressRepairTransactionFailure =>
  (state === 'failed' && failure === 'not-applied') ||
  (state === 'conflict' && failure === 'conflict') ||
  (!['failed', 'conflict'].includes(state) && failure === null);

const normalizeTransaction = (value: unknown): EgressRepairTransaction => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'activationRequirements',
      'after',
      'afterRevision',
      'before',
      'beforeRevision',
      'failure',
      'id',
      'preparedAt',
      'state',
      'updatedAt',
    ]) ||
    typeof value.id !== 'string' ||
    !TRANSACTION_ID.test(value.id) ||
    typeof value.beforeRevision !== 'string' ||
    !REVISION.test(value.beforeRevision) ||
    typeof value.afterRevision !== 'string' ||
    !REVISION.test(value.afterRevision) ||
    typeof value.state !== 'string' ||
    !JOURNAL_STATES.includes(value.state as EgressRepairTransactionState) ||
    !finiteTimestamp(value.preparedAt) ||
    !finiteTimestamp(value.updatedAt)
  ) {
    throw new EgressRepairJournalError();
  }
  const state = value.state as EgressRepairTransactionState;
  if (!validFailure(state, value.failure)) throw new EgressRepairJournalError();
  return Object.freeze({
    activationRequirements: normalizeActivations(value.activationRequirements),
    after: normalizeEgressProcessPolicy(value.after),
    afterRevision: value.afterRevision as EgressProcessPolicyRevision,
    before: normalizeEgressProcessPolicy(value.before),
    beforeRevision: value.beforeRevision as EgressProcessPolicyRevision,
    failure: value.failure,
    id: value.id as EgressRepairTransactionId,
    preparedAt: value.preparedAt,
    state,
    updatedAt: value.updatedAt,
  });
};

const normalizeDocument = (value: unknown): RepairJournalDocument => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['transactions', 'version']) ||
    value.version !== EGRESS_REPAIR_JOURNAL_VERSION ||
    !Array.isArray(value.transactions) ||
    value.transactions.length > EGRESS_REPAIR_JOURNAL_MAX_TRANSACTIONS
  ) {
    throw new EgressRepairJournalError();
  }
  const transactions = value.transactions.map(normalizeTransaction);
  if (new Set(transactions.map((transaction) => transaction.id)).size !== transactions.length) {
    throw new EgressRepairJournalError();
  }
  return { transactions, version: EGRESS_REPAIR_JOURNAL_VERSION };
};

const inspectCandidate = (raw: string): JournalCandidate => {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.version === 'number' &&
      Number.isSafeInteger(value.version) &&
      value.version > EGRESS_REPAIR_JOURNAL_VERSION
    ) {
      return { kind: 'future' };
    }
    return { document: normalizeDocument(value), kind: 'valid', raw };
  } catch {
    return { kind: 'invalid' };
  }
};

const emptyDocument = (): RepairJournalDocument => ({
  transactions: [],
  version: EGRESS_REPAIR_JOURNAL_VERSION,
});

const cloneTransaction = (transaction: EgressRepairTransaction): EgressRepairTransaction =>
  normalizeTransaction(structuredClone(transaction));

const cloneDocument = (document: RepairJournalDocument): RepairJournalDocument => ({
  transactions: document.transactions.map(cloneTransaction),
  version: EGRESS_REPAIR_JOURNAL_VERSION,
});

const isActiveTransaction = (transaction: EgressRepairTransaction): boolean =>
  transaction.state === 'prepared' || transaction.state === 'rollback-prepared';

const assertAbsoluteRoot = (root: string): string => {
  if (!path.isAbsolute(root)) throw new EgressRepairJournalError('修复日志存储根目录无效。');
  return path.resolve(root);
};

export class EgressRepairJournal implements EgressRepairJournalPort {
  private readonly atomicOperations: Partial<EgressAtomicFileOperations>;
  private readonly backupPath: string;
  private readonly createTransactionId: () => string;
  private readonly now: () => number;
  private readonly root: string;
  private readonly storagePath: string;

  public constructor(root: string, options: EgressRepairJournalOptions = {}) {
    this.root = assertAbsoluteRoot(root);
    this.storagePath = path.join(this.root, 'repair-journal.json');
    this.backupPath = `${this.storagePath}.bak`;
    this.atomicOperations = options.atomicOperations ?? {};
    this.createTransactionId =
      options.createTransactionId ?? (() => randomBytes(24).toString('base64url'));
    this.now = options.now ?? Date.now;
  }

  public list(): readonly EgressRepairTransaction[] {
    return Object.freeze(this.load().document.transactions.map(cloneTransaction));
  }

  public get(transactionId: string): EgressRepairTransaction | undefined {
    if (!TRANSACTION_ID.test(transactionId)) return undefined;
    const transaction = this.load().document.transactions.find(
      (candidate) => candidate.id === transactionId,
    );
    return transaction ? cloneTransaction(transaction) : undefined;
  }

  public prepare(plan: EgressRepairPlan): EgressRepairTransaction {
    if (plan.changes.length === 0) {
      throw new EgressRepairJournalError('没有需要写入修复日志的策略变更。');
    }
    return this.mutate((document) => {
      this.retainCapacity(document);
      const id = this.mintTransactionId(document);
      const timestamp = this.nextTimestamp(document);
      const transaction = normalizeTransaction({
        activationRequirements: plan.activationRequirements,
        after: cloneEgressProcessPolicy(plan.after),
        afterRevision: plan.resultingRevision,
        before: cloneEgressProcessPolicy(plan.before),
        beforeRevision: plan.expectedRevision,
        failure: null,
        id,
        preparedAt: timestamp,
        state: 'prepared',
        updatedAt: timestamp,
      });
      document.transactions.push(transaction);
      return transaction;
    });
  }

  public markApplied(transactionId: EgressRepairTransactionId): EgressRepairTransaction {
    return this.transition(transactionId, ['prepared'], 'applied', null);
  }

  public markConflict(transactionId: EgressRepairTransactionId): EgressRepairTransaction {
    return this.transition(
      transactionId,
      ['prepared', 'applied', 'rollback-prepared'],
      'conflict',
      'conflict',
    );
  }

  public markRollbackPrepared(transactionId: EgressRepairTransactionId): EgressRepairTransaction {
    return this.transition(transactionId, ['applied'], 'rollback-prepared', null);
  }

  public markRolledBack(transactionId: EgressRepairTransactionId): EgressRepairTransaction {
    return this.transition(transactionId, ['rollback-prepared'], 'rolled-back', null);
  }

  public reconcile(snapshot: EgressProcessPolicySnapshot): readonly EgressRepairReconciliation[] {
    const loaded = this.load();
    if (!loaded.document.transactions.some(isActiveTransaction)) return Object.freeze([]);
    const reconciliations: EgressRepairReconciliation[] = [];
    const next = cloneDocument(loaded.document);
    for (let index = 0; index < next.transactions.length; index += 1) {
      const transaction = next.transactions[index];
      if (!transaction || !isActiveTransaction(transaction)) continue;
      const resolved = this.reconciledTransaction(transaction, snapshot);
      next.transactions[index] = resolved;
      reconciliations.push(
        Object.freeze({
          from: transaction.state as 'prepared' | 'rollback-prepared',
          to: resolved.state,
          transactionId: transaction.id,
        }),
      );
    }
    this.persist(next, loaded);
    return Object.freeze(reconciliations);
  }

  public reconcileTransaction(
    transactionId: EgressRepairTransactionId,
    snapshot: EgressProcessPolicySnapshot,
  ): EgressRepairTransaction {
    return this.mutate((document) => {
      const index = document.transactions.findIndex(
        (transaction) => transaction.id === transactionId,
      );
      const transaction = document.transactions[index];
      if (!transaction) throw new EgressRepairJournalError('修复事务不存在。');
      if (!isActiveTransaction(transaction)) return transaction;
      const resolved = this.reconciledTransaction(transaction, snapshot);
      document.transactions[index] = resolved;
      return resolved;
    });
  }

  private transition(
    transactionId: EgressRepairTransactionId,
    allowed: readonly EgressRepairTransactionState[],
    state: EgressRepairTransactionState,
    failure: EgressRepairTransactionFailure,
  ): EgressRepairTransaction {
    return this.mutate((document) => {
      const index = document.transactions.findIndex(
        (transaction) => transaction.id === transactionId,
      );
      const current = document.transactions[index];
      if (!current) throw new EgressRepairJournalError('修复事务不存在。');
      if (current.state === state) return current;
      if (!allowed.includes(current.state)) {
        throw new EgressRepairJournalError('修复事务状态不允许这次变更。');
      }
      const next = normalizeTransaction({
        ...current,
        failure,
        state,
        updatedAt: Math.max(this.now(), current.updatedAt + 1),
      });
      document.transactions[index] = next;
      return next;
    });
  }

  private reconciledTransaction(
    transaction: EgressRepairTransaction,
    snapshot: EgressProcessPolicySnapshot,
  ): EgressRepairTransaction {
    let state: EgressRepairTransactionState;
    let failure: EgressRepairTransactionFailure = null;
    if (transaction.state === 'prepared') {
      if (snapshot.revision === transaction.beforeRevision) {
        state = 'failed';
        failure = 'not-applied';
      } else if (snapshot.revision === transaction.afterRevision) {
        state = 'applied';
      } else {
        state = 'conflict';
        failure = 'conflict';
      }
    } else if (snapshot.revision === transaction.beforeRevision) {
      state = 'rolled-back';
    } else if (snapshot.revision === transaction.afterRevision) {
      state = 'applied';
    } else {
      state = 'conflict';
      failure = 'conflict';
    }
    return normalizeTransaction({
      ...transaction,
      failure,
      state,
      updatedAt: Math.max(this.now(), transaction.updatedAt + 1),
    });
  }

  private mutate(
    operation: (document: RepairJournalDocument) => EgressRepairTransaction,
  ): EgressRepairTransaction {
    const loaded = this.load();
    const next = cloneDocument(loaded.document);
    const result = operation(next);
    this.persist(next, loaded);
    return cloneTransaction(result);
  }

  private load(): LoadedJournal {
    const primary = this.readCandidate(this.storagePath);
    if (primary.kind === 'future') throw new EgressRepairJournalUnsupportedVersionError();
    if (primary.kind === 'valid') {
      return { backup: this.readCandidate(this.backupPath), document: primary.document, primary };
    }
    const backup = this.readCandidate(this.backupPath);
    if (backup.kind === 'future') throw new EgressRepairJournalUnsupportedVersionError();
    if (backup.kind === 'valid') return { backup, document: backup.document, primary };
    if (primary.kind === 'missing' && backup.kind === 'missing') {
      return { backup, document: emptyDocument(), primary };
    }
    throw new EgressRepairJournalError('修复日志损坏，ClaudeDock 不会覆盖现有内容。');
  }

  private persist(document: RepairJournalDocument, loaded: LoadedJournal): void {
    if (loaded.primary.kind === 'future' || loaded.backup.kind === 'future') {
      throw new EgressRepairJournalUnsupportedVersionError();
    }
    if (loaded.primary.kind === 'unclassifiable' || loaded.backup.kind === 'unclassifiable') {
      throw new EgressRepairJournalError(
        '修复日志的格式或版本无法安全确认，ClaudeDock 不会覆盖现有内容。',
      );
    }
    const serialized = `${JSON.stringify(normalizeDocument(document), null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > EGRESS_REPAIR_JOURNAL_MAX_BYTES) {
      throw new EgressRepairJournalError('修复日志超过大小上限。');
    }
    try {
      mkdirSync(this.root, { recursive: true });
      if (loaded.primary.kind === 'valid') {
        replaceEgressFileAtomically(this.backupPath, loaded.primary.raw, this.atomicOperations);
      }
      replaceEgressFileAtomically(this.storagePath, serialized, this.atomicOperations);
    } catch (error) {
      if (error instanceof EgressRepairJournalError) throw error;
      throw new EgressRepairJournalError('ClaudeDock 无法安全保存修复日志。');
    }
  }

  private readCandidate(filePath: string): JournalCandidate {
    try {
      const raw = readEgressBoundedUtf8File(filePath, EGRESS_REPAIR_JOURNAL_MAX_BYTES);
      return raw === undefined ? { kind: 'missing' } : inspectCandidate(raw);
    } catch {
      return { kind: 'unclassifiable' };
    }
  }

  private retainCapacity(document: RepairJournalDocument): void {
    while (document.transactions.length >= EGRESS_REPAIR_JOURNAL_MAX_TRANSACTIONS) {
      const removable = document.transactions.findIndex(
        (transaction) => !isActiveTransaction(transaction),
      );
      if (removable < 0) throw new EgressRepairJournalError('待处理修复事务过多，暂时不能新增。');
      document.transactions.splice(removable, 1);
    }
  }

  private mintTransactionId(document: RepairJournalDocument): EgressRepairTransactionId {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.createTransactionId();
      if (
        TRANSACTION_ID.test(candidate) &&
        !document.transactions.some((transaction) => transaction.id === candidate)
      ) {
        return candidate as EgressRepairTransactionId;
      }
    }
    throw new EgressRepairJournalError('无法生成修复事务标识。');
  }

  private nextTimestamp(document: RepairJournalDocument): number {
    const previous = document.transactions.at(-1)?.updatedAt ?? -1;
    return Math.max(this.now(), previous + 1, 0);
  }
}
