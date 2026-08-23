import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEgressProcessPolicyHmacSigner,
  EgressProcessPolicyStore,
} from '../../src/main/egress-diagnostics/process-policy-store';
import {
  EGRESS_REPAIR_JOURNAL_MAX_BYTES,
  EGRESS_REPAIR_JOURNAL_MAX_TRANSACTIONS,
  EgressRepairJournal,
  EgressRepairJournalError,
  EgressRepairJournalUnsupportedVersionError,
} from '../../src/main/egress-diagnostics/repair-journal';
import { EgressRepairPlanner } from '../../src/main/egress-diagnostics/repair-planner';

const parents: string[] = [];
const createHarness = (options: ConstructorParameters<typeof EgressRepairJournal>[1] = {}) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-journal-'));
  parents.push(parent);
  const root = path.join(parent, 'egress-diagnostics');
  const store = new EgressProcessPolicyStore(
    root,
    createEgressProcessPolicyHmacSigner(Buffer.alloc(32, 0x71)),
  );
  const planner = new EgressRepairPlanner(store);
  const journal = new EgressRepairJournal(root, options);
  return { journal, parent, planner, root, store };
};

afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { force: true, recursive: true });
});

describe('EgressRepairJournal', () => {
  it('reads an empty journal without creating a root or hydrating a file', () => {
    const { journal, root } = createHarness();
    expect(journal.list()).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('persists bounded schema-v1 prepared and applied transactions', () => {
    const { journal, planner, root } = createHarness({
      createTransactionId: () => 'a'.repeat(32),
      now: () => 100,
    });
    const plan = planner.plan({ timezone: { operation: 'set', value: 'Asia/Tokyo' } });

    const prepared = journal.prepare(plan);
    expect(prepared).toMatchObject({ failure: null, preparedAt: 100, state: 'prepared' });
    const applied = journal.markApplied(prepared.id);
    expect(applied).toMatchObject({ failure: null, state: 'applied', updatedAt: 101 });

    const persisted = JSON.parse(
      readFileSync(path.join(root, 'repair-journal.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted.version).toBe(1);
    expect(persisted.transactions).toHaveLength(1);
  });

  it('refuses and preserves a future journal version', () => {
    const { journal, planner, root } = createHarness();
    mkdirSync(root, { recursive: true });
    const journalPath = path.join(root, 'repair-journal.json');
    const future = '{"version":2,"transactions":[],"future":"preserve"}\n';
    writeFileSync(journalPath, future, 'utf8');

    expect(() => journal.list()).toThrow(EgressRepairJournalUnsupportedVersionError);
    expect(() =>
      journal.prepare(planner.plan({ timezone: { operation: 'set', value: 'UTC' } })),
    ).toThrow(EgressRepairJournalUnsupportedVersionError);
    expect(readFileSync(journalPath, 'utf8')).toBe(future);
  });

  it('preserves an oversized future-like primary when a valid backup permits safe reads', () => {
    const { journal, planner, root } = createHarness({
      createTransactionId: () => 'f'.repeat(32),
      now: () => 150,
    });
    const transaction = journal.prepare(
      planner.plan({ timezone: { operation: 'set', value: 'Asia/Tokyo' } }),
    );
    journal.markApplied(transaction.id);
    const journalPath = path.join(root, 'repair-journal.json');
    const backupPath = `${journalPath}.bak`;
    const validBackup = readFileSync(backupPath, 'utf8');
    const oversizedFuture = `{"version":2,"transactions":[],"future":"${'x'.repeat(
      EGRESS_REPAIR_JOURNAL_MAX_BYTES,
    )}"}\n`;
    writeFileSync(journalPath, oversizedFuture, 'utf8');

    expect(journal.list()[0]?.state).toBe('prepared');
    expect(() => journal.markApplied(transaction.id)).toThrow(EgressRepairJournalError);
    expect(readFileSync(journalPath, 'utf8')).toBe(oversizedFuture);
    expect(readFileSync(backupPath, 'utf8')).toBe(validBackup);
  });

  it('uses a valid backup without copying corrupt primary bytes over it', () => {
    const { journal, planner, root } = createHarness({
      createTransactionId: () => 'b'.repeat(32),
      now: () => 200,
    });
    const transaction = journal.prepare(
      planner.plan({ requestLanguages: { operation: 'set', value: ['en-US'] } }),
    );
    journal.markApplied(transaction.id);
    const journalPath = path.join(root, 'repair-journal.json');
    const backupPath = `${journalPath}.bak`;
    const validBackup = readFileSync(backupPath, 'utf8');

    writeFileSync(journalPath, '{corrupt', 'utf8');
    expect(journal.list()[0]?.state).toBe('prepared');
    journal.markApplied(transaction.id);

    expect(readFileSync(backupPath, 'utf8')).toBe(validBackup);
    expect(readFileSync(backupPath, 'utf8')).not.toContain('{corrupt');
    expect(journal.list()[0]?.state).toBe('applied');
  });

  it('bounds malformed reads and never overwrites unrecoverable content', () => {
    const { journal, planner, root } = createHarness();
    mkdirSync(root, { recursive: true });
    const journalPath = path.join(root, 'repair-journal.json');
    const plan = planner.plan({ timezone: { operation: 'set', value: 'UTC' } });

    writeFileSync(journalPath, '{bad', 'utf8');
    expect(() => journal.list()).toThrow(EgressRepairJournalError);
    expect(() => journal.prepare(plan)).toThrow(EgressRepairJournalError);
    expect(readFileSync(journalPath, 'utf8')).toBe('{bad');

    writeFileSync(journalPath, 'x'.repeat(EGRESS_REPAIR_JOURNAL_MAX_BYTES + 1), 'utf8');
    expect(() => journal.list()).toThrow(EgressRepairJournalError);
  });

  it('retains the bounded newest transaction set and mints only opaque random-shaped IDs', () => {
    let id = 0;
    const { journal, planner } = createHarness({
      atomicOperations: { flushFile: () => undefined },
      createTransactionId: () => (++id).toString(36).padStart(32, 'a'),
      now: () => 300,
    });
    const plan = planner.plan({ webRtc: { operation: 'set', value: 'public-interface-only' } });
    let firstId = '';
    for (let index = 0; index <= EGRESS_REPAIR_JOURNAL_MAX_TRANSACTIONS; index += 1) {
      const transaction = journal.prepare(plan);
      if (index === 0) firstId = transaction.id;
      journal.markApplied(transaction.id);
    }

    const retained = journal.list();
    expect(retained).toHaveLength(EGRESS_REPAIR_JOURNAL_MAX_TRANSACTIONS);
    expect(retained.some((transaction) => transaction.id === firstId)).toBe(false);
    expect(retained.every((transaction) => /^[A-Za-z0-9_-]{32}$/.test(transaction.id))).toBe(true);
  });

  it('never journals process.env, proxy/auth material, paths, endpoints, or public IP evidence', () => {
    const { journal, planner, root } = createHarness({
      createTransactionId: () => 'c'.repeat(32),
    });
    journal.prepare(
      planner.plan({
        applicationLanguages: { operation: 'set', value: ['de-DE'] },
        timezone: { operation: 'set', value: 'Europe/Berlin' },
      }),
    );
    const raw = readFileSync(path.join(root, 'repair-journal.json'), 'utf8');

    for (const forbidden of [
      'process.env',
      'HTTP_PROXY',
      'password',
      'credential',
      'authorization',
      'publicIp',
      'endpoint',
      'username',
      root,
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
