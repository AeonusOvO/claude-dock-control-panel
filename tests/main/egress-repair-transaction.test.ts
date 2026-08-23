import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EgressRepairApplier,
  EgressRepairRevisionConflictError,
  EgressRepairRollbackConflictError,
  EgressRepairSerialMutex,
  EgressRepairUnknownTransactionError,
  type EgressRepairMutex,
} from '../../src/main/egress-diagnostics/repair-applier';
import {
  EgressRepairJournal,
  type EgressRepairJournalOptions,
} from '../../src/main/egress-diagnostics/repair-journal';
import {
  createEgressProcessPolicyHmacSigner,
  EgressProcessPolicyStore,
  type EgressProcessPolicyStoreOptions,
  type EgressProcessPolicyStorePort,
} from '../../src/main/egress-diagnostics/process-policy-store';
import {
  applyEgressProcessPolicyEdits,
  EGRESS_PROCESS_POLICY_MAX_BYTES,
} from '../../src/main/egress-diagnostics/process-policy-types';
import { EgressRepairPlanner } from '../../src/main/egress-diagnostics/repair-planner';

const parents: string[] = [];

const createHarness = (options?: {
  journal?: EgressRepairJournalOptions;
  policy?: EgressProcessPolicyStoreOptions;
}) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-transaction-'));
  parents.push(parent);
  const root = path.join(parent, 'egress-diagnostics');
  const store = new EgressProcessPolicyStore(
    root,
    createEgressProcessPolicyHmacSigner(Buffer.alloc(32, 0x91)),
    options?.policy,
  );
  const journal = new EgressRepairJournal(root, options?.journal);
  const mutex = new EgressRepairSerialMutex();
  const applier = new EgressRepairApplier({ journal, mutex, store });
  const planner = new EgressRepairPlanner(store);
  return { applier, journal, mutex, parent, planner, root, store };
};

const timezoneEdit = (timezone: string) => ({
  timezone: { operation: 'set' as const, value: timezone },
});

afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { force: true, recursive: true });
});

describe('EgressRepairApplier durable transactions', () => {
  it('writes prepared journal, then policy, then applied journal in order', async () => {
    const events: string[] = [];
    const recordRename = (source: string, destination: string): void => {
      events.push(path.basename(destination));
      renameSync(source, destination);
    };
    const { applier, journal, planner } = createHarness({
      journal: { atomicOperations: { renameFile: recordRename } },
      policy: { atomicOperations: { renameFile: recordRename } },
    });
    const preview = planner.plan(timezoneEdit('Asia/Tokyo'));

    const result = await applier.apply({
      edits: timezoneEdit('Asia/Tokyo'),
      expectedRevision: preview.expectedRevision,
    });

    expect(result.state).toBe('applied');
    expect(events).toEqual([
      'repair-journal.json',
      'process-policy.json',
      'repair-journal.json.bak',
      'repair-journal.json',
    ]);
    expect(journal.get(result.transactionId ?? '')?.state).toBe('applied');
  });

  it('does not overwrite an oversized future-like policy primary during apply', async () => {
    const { applier, planner, root, store } = createHarness();
    store.write(planner.plan(timezoneEdit('UTC')).after);
    store.write(planner.plan(timezoneEdit('Europe/Paris')).after);
    const storagePath = path.join(root, 'process-policy.json');
    const backupPath = `${storagePath}.bak`;
    const validBackup = readFileSync(backupPath, 'utf8');
    const oversizedFuture = `{"version":2,"futurePolicy":"${'x'.repeat(
      EGRESS_PROCESS_POLICY_MAX_BYTES,
    )}"}\n`;
    writeFileSync(storagePath, oversizedFuture, 'utf8');
    const preview = planner.plan(timezoneEdit('Asia/Tokyo'));

    await expect(
      applier.apply({
        edits: timezoneEdit('Asia/Tokyo'),
        expectedRevision: preview.expectedRevision,
      }),
    ).rejects.toMatchObject({ policyState: 'before', state: 'failed' });
    expect(readFileSync(storagePath, 'utf8')).toBe(oversizedFuture);
    expect(readFileSync(backupPath, 'utf8')).toBe(validBackup);
  });

  it('uses the injected process-wide mutex and serializes queued operations', async () => {
    const mutex = new EgressRepairSerialMutex();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = mutex.runExclusive(async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    const second = mutex.runExclusive(async () => {
      events.push('second:start');
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);

    const harness = createHarness();
    let exclusiveCalls = 0;
    const injected: EgressRepairMutex = {
      runExclusive: <T>(operation: () => Promise<T>): Promise<T> => {
        exclusiveCalls += 1;
        return harness.mutex.runExclusive(operation);
      },
    };
    const applier = new EgressRepairApplier({
      journal: harness.journal,
      mutex: injected,
      store: harness.store,
    });
    const plan = harness.planner.plan(timezoneEdit('Europe/Paris'));
    await applier.apply({
      edits: timezoneEdit('Europe/Paris'),
      expectedRevision: plan.expectedRevision,
    });
    expect(exclusiveCalls).toBe(1);
  });

  it('rejects a stale opaque revision before creating any journal transaction', async () => {
    const { applier, journal, planner, store } = createHarness();
    const stale = planner.plan(timezoneEdit('Asia/Tokyo'));
    store.write(applyEgressProcessPolicyEdits(stale.before, timezoneEdit('Europe/Paris')));

    await expect(
      applier.apply({
        edits: timezoneEdit('Asia/Tokyo'),
        expectedRevision: stale.expectedRevision,
      }),
    ).rejects.toBeInstanceOf(EgressRepairRevisionConflictError);
    expect(journal.list()).toEqual([]);
  });

  it('records failed/not-applied when the atomic policy write fails', async () => {
    const { applier, journal, planner } = createHarness({
      policy: {
        atomicOperations: {
          renameFile: () => {
            throw Object.assign(new Error('blocked'), { code: 'EIO' });
          },
        },
      },
    });
    const plan = planner.plan(timezoneEdit('Asia/Tokyo'));
    const operation = applier.apply({
      edits: timezoneEdit('Asia/Tokyo'),
      expectedRevision: plan.expectedRevision,
    });

    await expect(operation).rejects.toMatchObject({
      policyState: 'before',
      state: 'failed',
    });
    expect(journal.list()[0]).toMatchObject({ failure: 'not-applied', state: 'failed' });
  });

  it('leaves a truthful prepared state when policy committed but applied marker failed', async () => {
    let primaryJournalRenames = 0;
    const { applier, journal, planner, root, store } = createHarness({
      journal: {
        atomicOperations: {
          renameFile: (source, destination) => {
            if (path.basename(destination) === 'repair-journal.json') {
              primaryJournalRenames += 1;
              if (primaryJournalRenames >= 2) {
                throw Object.assign(new Error('locked'), { code: 'EACCES' });
              }
            }
            renameSync(source, destination);
          },
          sleep: () => undefined,
        },
      },
    });
    const plan = planner.plan(timezoneEdit('Asia/Tokyo'));
    const operation = applier.apply({
      edits: timezoneEdit('Asia/Tokyo'),
      expectedRevision: plan.expectedRevision,
    });

    await expect(operation).rejects.toMatchObject({ policyState: 'after', state: 'prepared' });
    expect(store.read().revision).toBe(plan.resultingRevision);
    expect(journal.list()[0]?.state).toBe('prepared');

    const recoveredJournal = new EgressRepairJournal(root);
    const recovered = new EgressRepairApplier({
      journal: recoveredJournal,
      mutex: new EgressRepairSerialMutex(),
      store,
    });
    expect(await recovered.reconcile()).toMatchObject([{ from: 'prepared', to: 'applied' }]);
    expect(recoveredJournal.list()[0]?.state).toBe('applied');
  });

  it.each([
    { expected: 'failed', mode: 'before' },
    { expected: 'applied', mode: 'after' },
    { expected: 'conflict', mode: 'other' },
  ] as const)(
    'reconciles prepared + $mode to $expected without overwriting policy',
    async ({ expected, mode }) => {
      const { applier, journal, planner, store } = createHarness();
      const plan = planner.plan(timezoneEdit('Asia/Tokyo'));
      const transaction = journal.prepare(plan);
      if (mode === 'after') {
        store.write(plan.after);
      } else if (mode === 'other') {
        store.write(applyEgressProcessPolicyEdits(plan.before, timezoneEdit('Europe/Paris')));
      }
      const beforeReconcile = store.read();

      await applier.reconcile();

      expect(journal.get(transaction.id)?.state).toBe(expected);
      expect(store.read()).toEqual(beforeReconcile);
    },
  );

  it('rolls back persistently, reports activation, and is idempotent without a second write', async () => {
    const harness = createHarness();
    const write = vi.fn((policy) => harness.store.write(policy));
    const store: EgressProcessPolicyStorePort = {
      read: () => harness.store.read(),
      revisionFor: (policy) => harness.store.revisionFor(policy),
      write,
    };
    const applier = new EgressRepairApplier({
      journal: harness.journal,
      mutex: harness.mutex,
      store,
    });
    const plan = new EgressRepairPlanner(store).plan(timezoneEdit('Asia/Tokyo'));
    const applied = await applier.apply({
      edits: timezoneEdit('Asia/Tokyo'),
      expectedRevision: plan.expectedRevision,
    });

    const first = await applier.rollback(applied.transactionId ?? '');
    const second = await applier.rollback(applied.transactionId ?? '');

    expect(first).toMatchObject({
      activationRequirements: ['future-process-starts'],
      alreadyRolledBack: false,
      state: 'rolled-back',
    });
    expect(second).toMatchObject({ alreadyRolledBack: true, state: 'rolled-back' });
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.read().revision).toBe(plan.expectedRevision);
    expect(harness.journal.get(applied.transactionId ?? '')?.state).toBe('rolled-back');
  });

  it('refuses rollback after a later edit and never overwrites the newer policy', async () => {
    const { applier, journal, planner, store } = createHarness();
    const plan = planner.plan(timezoneEdit('Asia/Tokyo'));
    const applied = await applier.apply({
      edits: timezoneEdit('Asia/Tokyo'),
      expectedRevision: plan.expectedRevision,
    });
    const newer = applyEgressProcessPolicyEdits(plan.after, timezoneEdit('Europe/Paris'));
    const newerSnapshot = store.write(newer);

    await expect(applier.rollback(applied.transactionId ?? '')).rejects.toBeInstanceOf(
      EgressRepairRollbackConflictError,
    );
    expect(store.read()).toEqual(newerSnapshot);
    expect(journal.get(applied.transactionId ?? '')?.state).toBe('conflict');
  });

  it('reconciles a crash after rollback policy restore but before rolled-back marker', async () => {
    const { applier, journal, planner, store } = createHarness();
    const plan = planner.plan(timezoneEdit('Asia/Tokyo'));
    const applied = await applier.apply({
      edits: timezoneEdit('Asia/Tokyo'),
      expectedRevision: plan.expectedRevision,
    });
    const transactionId = applied.transactionId;
    expect(transactionId).toBeDefined();
    journal.markRollbackPrepared(transactionId!);
    store.write(plan.before);

    expect(await applier.reconcile()).toMatchObject([
      { from: 'rollback-prepared', to: 'rolled-back' },
    ]);
    expect(journal.get(transactionId ?? '')?.state).toBe('rolled-back');
  });

  it('accepts rollback only for an existing main-minted transaction ID', async () => {
    const { applier } = createHarness();
    await expect(applier.rollback('C:\\outside\\repair.json')).rejects.toBeInstanceOf(
      EgressRepairUnknownTransactionError,
    );
    await expect(applier.rollback('z'.repeat(32))).rejects.toBeInstanceOf(
      EgressRepairUnknownTransactionError,
    );
  });

  it('contains no subprocess, shell, registry, network mutation, or global environment APIs', () => {
    const sourceRoot = path.join(process.cwd(), 'src', 'main', 'egress-diagnostics');
    const files = [
      'atomic-store.ts',
      'process-policy-types.ts',
      'process-policy-store.ts',
      'repair-planner.ts',
      'repair-journal.ts',
      'repair-applier.ts',
    ];
    const source = files
      .map((file) => readFileSync(path.join(sourceRoot, file), 'utf8'))
      .join('\n');
    for (const forbidden of [
      'node:child_process',
      'spawn(',
      'exec(',
      'PowerShell',
      'setx',
      'winreg',
      'netsh',
      'setProxy(',
      'setWebRTCIPHandlingPolicy(',
      'process.env',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
