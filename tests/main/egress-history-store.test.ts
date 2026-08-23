import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactEgressAddress } from '../../src/main/egress-diagnostics/address-redactor';
import {
  EGRESS_HISTORY_MAX_BYTES,
  EGRESS_HISTORY_MAX_ENTRIES,
  EgressHistoryStore,
  EgressHistoryStoreError,
  EgressHistoryUnsupportedVersionError,
  parseEgressHistoryDocument,
} from '../../src/main/egress-diagnostics/history-store';
import type { EgressHistoryEntry } from '../../src/shared/contracts/egress-diagnostics';

const DAY = 86_400_000;
const KEY = Buffer.alloc(32, 0x33);
const roots: string[] = [];

const createFixture = () => {
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-history-'));
  roots.push(userDataPath);
  const primary = path.join(userDataPath, 'egress-diagnostics', 'history.json');
  return { backup: `${primary}.bak`, primary, userDataPath };
};

const historyEntry = (
  collectedAt: number,
  address = `198.51.100.${(Math.floor(collectedAt / DAY) % 200) + 1}`,
): EgressHistoryEntry => ({
  addresses: [redactEgressAddress(address, 'ipv4', KEY)],
  collectedAt,
  kind: 'history',
  providers: [
    {
      assessment: { agreement: 'single-source', confidence: 'moderate', freshness: 'live' },
      provider: 'ipify',
      state: 'complete',
    },
  ],
  state: 'complete',
});

const storedEntries = (filePath: string): EgressHistoryEntry[] =>
  (JSON.parse(readFileSync(filePath, 'utf8')) as { entries: EgressHistoryEntry[] }).entries;

const fileSystemError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error('injected atomic failure'), { code });

const sameStoragePath = (left: string, right: string): boolean => {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === 'win32'
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('EgressHistoryStore', () => {
  it('appends, reloads, and prunes by bounded retention and entry count', () => {
    const { primary, userDataPath } = createFixture();
    const now = 100 * DAY;
    const store = new EgressHistoryStore(userDataPath, {
      maxEntries: 2,
      now: () => now,
      retentionDays: 10,
    });

    store.append(historyEntry(80 * DAY));
    store.append(historyEntry(95 * DAY));
    store.append(historyEntry(97 * DAY));
    store.append(historyEntry(99 * DAY));

    expect(store.export().map((entry) => entry.collectedAt)).toEqual([97 * DAY, 99 * DAY]);
    expect(storedEntries(primary).map((entry) => entry.collectedAt)).toEqual([97 * DAY, 99 * DAY]);
    expect(
      new EgressHistoryStore(userDataPath, {
        maxEntries: 2,
        now: () => now,
        retentionDays: 10,
      })
        .export()
        .map((entry) => entry.collectedAt),
    ).toEqual([97 * DAY, 99 * DAY]);
  });

  it('reapplies retention and configured count limits on every export without rewriting disk', () => {
    const { primary, userDataPath } = createFixture();
    let now = 100 * DAY;
    const seed = new EgressHistoryStore(userDataPath, {
      maxEntries: 10,
      now: () => now,
      retentionDays: 10,
    });
    seed.append(historyEntry(96 * DAY));
    seed.append(historyEntry(98 * DAY));
    seed.append(historyEntry(99 * DAY));
    const durableBefore = readFileSync(primary, 'utf8');
    const limited = new EgressHistoryStore(userDataPath, {
      maxEntries: 2,
      now: () => now,
      retentionDays: 10,
    });

    expect(limited.export().map((entry) => entry.collectedAt)).toEqual([98 * DAY, 99 * DAY]);
    now = 110 * DAY;
    expect(limited.export()).toEqual([]);
    expect(readFileSync(primary, 'utf8')).toBe(durableBefore);
  });

  it('orders by collection time so delayed appends never evict newer evidence', () => {
    const { primary, userDataPath } = createFixture();
    const store = new EgressHistoryStore(userDataPath, {
      maxEntries: 2,
      now: () => 100 * DAY,
      retentionDays: 30,
    });
    store.append(historyEntry(99 * DAY));
    store.append(historyEntry(100 * DAY));
    store.append(historyEntry(98 * DAY));

    expect(store.export().map((entry) => entry.collectedAt)).toEqual([99 * DAY, 100 * DAY]);
    expect(storedEntries(primary).map((entry) => entry.collectedAt)).toEqual([99 * DAY, 100 * DAY]);
  });

  it('uses a canonical content tie-break independent of append order', () => {
    const first = createFixture();
    const second = createFixture();
    const collectedAt = 70 * DAY;
    const candidates = [
      historyEntry(collectedAt, '198.51.100.10'),
      historyEntry(collectedAt, '198.51.100.20'),
      historyEntry(collectedAt, '198.51.100.30'),
    ];
    const forward = new EgressHistoryStore(first.userDataPath, {
      maxEntries: 2,
      now: () => collectedAt,
    });
    const reverse = new EgressHistoryStore(second.userDataPath, {
      maxEntries: 2,
      now: () => collectedAt,
    });
    candidates.forEach((entry) => forward.append(entry));
    [...candidates].reverse().forEach((entry) => reverse.append(entry));

    expect(forward.export()).toEqual(reverse.export());
    expect(readFileSync(first.primary, 'utf8')).toBe(readFileSync(second.primary, 'utf8'));
  });

  it('falls back from a corrupt primary to the strict predecessor backup without rewriting on read', () => {
    const { backup, primary, userDataPath } = createFixture();
    const store = new EgressHistoryStore(userDataPath, { now: () => 20 * DAY });
    const first = historyEntry(18 * DAY);
    const second = historyEntry(19 * DAY);
    const third = historyEntry(20 * DAY);
    store.append(first);
    store.append(second);
    expect(storedEntries(backup)).toEqual([first]);

    writeFileSync(primary, '{broken-primary', 'utf8');
    const corruptBytes = readFileSync(primary, 'utf8');
    const recovered = new EgressHistoryStore(userDataPath, { now: () => 20 * DAY });
    expect(recovered.export()).toEqual([first]);
    expect(readFileSync(primary, 'utf8')).toBe(corruptBytes);

    recovered.append(third);
    expect(storedEntries(primary)).toEqual([first, third]);
    expect(storedEntries(backup)).toEqual([first]);
  });

  it('returns empty when both files are corrupt and never rewrites them during read', () => {
    const { backup, primary, userDataPath } = createFixture();
    mkdirSync(path.dirname(primary), { recursive: true });
    writeFileSync(primary, '{bad-primary', 'utf8');
    writeFileSync(backup, '{bad-backup', 'utf8');
    const primaryBefore = readFileSync(primary, 'utf8');
    const backupBefore = readFileSync(backup, 'utf8');
    const store = new EgressHistoryStore(userDataPath);

    expect(store.export()).toEqual([]);
    expect(readFileSync(primary, 'utf8')).toBe(primaryBefore);
    expect(readFileSync(backup, 'utf8')).toBe(backupBefore);
    expect(() => store.append(historyEntry(Date.now()))).toThrow(EgressHistoryStoreError);
    expect(readFileSync(primary, 'utf8')).toBe(primaryBefore);
    expect(readFileSync(backup, 'utf8')).toBe(backupBefore);
  });

  it('rejects duplicate JSON keys, preserves isolated bytes, and never copies hidden data to backup', () => {
    const hiddenAddress = '198.51.100.244';
    const hiddenSecret = 'duplicate-key-secret-token';
    const duplicateRaw =
      `{"entries":[{"exactAddress":"${hiddenAddress}","token":"${hiddenSecret}"}],` +
      '"\\u0065ntries":[],"version":1}\r\n';

    const isolated = createFixture();
    mkdirSync(path.dirname(isolated.primary), { recursive: true });
    writeFileSync(isolated.primary, duplicateRaw, 'utf8');
    const isolatedStore = new EgressHistoryStore(isolated.userDataPath);
    expect(isolatedStore.export()).toEqual([]);
    expect(() => isolatedStore.append(historyEntry(Date.now()))).toThrow(EgressHistoryStoreError);
    expect(readFileSync(isolated.primary, 'utf8')).toBe(duplicateRaw);
    expect(existsSync(isolated.backup)).toBe(false);

    const recoverable = createFixture();
    const seed = new EgressHistoryStore(recoverable.userDataPath, { now: () => 12 * DAY });
    const predecessor = historyEntry(10 * DAY);
    seed.append(predecessor);
    seed.append(historyEntry(11 * DAY));
    writeFileSync(recoverable.primary, duplicateRaw, 'utf8');
    const recovered = new EgressHistoryStore(recoverable.userDataPath, { now: () => 12 * DAY });
    expect(recovered.export()).toEqual([predecessor]);
    recovered.append(historyEntry(12 * DAY));

    for (const filePath of [recoverable.primary, recoverable.backup]) {
      const bytes = readFileSync(filePath, 'utf8');
      expect(bytes).not.toContain(hiddenAddress);
      expect(bytes).not.toContain(hiddenSecret);
      expect(bytes).not.toBe(duplicateRaw);
    }
  });

  it('keeps predecessor P in primary and backup when backup succeeds but candidate primary fails', () => {
    const { backup, primary, userDataPath } = createFixture();
    const committed = historyEntry(10 * DAY);
    const uncommitted = historyEntry(11 * DAY);
    new EgressHistoryStore(userDataPath, { now: () => 11 * DAY }).append(committed);
    const committedBytes = readFileSync(primary, 'utf8');
    const failing = new EgressHistoryStore(userDataPath, {
      atomicOperations: {
        renameFile: (source, destination) => {
          if (sameStoragePath(destination, primary)) throw fileSystemError('EIO');
          renameSync(source, destination);
        },
      },
      now: () => 11 * DAY,
    });

    expect(() => failing.append(uncommitted)).toThrow(EgressHistoryStoreError);
    expect(readFileSync(primary, 'utf8')).toBe(committedBytes);
    expect(readFileSync(backup, 'utf8')).toBe(committedBytes);
    const restarted = new EgressHistoryStore(userDataPath, { now: () => 11 * DAY }).export();
    expect(restarted).toEqual([committed]);
    expect(JSON.stringify(restarted)).not.toContain(String(uncommitted.collectedAt));
  });

  it('does not touch primary when predecessor backup replacement fails', () => {
    const { backup, primary, userDataPath } = createFixture();
    const committed = historyEntry(30 * DAY);
    new EgressHistoryStore(userDataPath, { now: () => 31 * DAY }).append(committed);
    const primaryBefore = readFileSync(primary, 'utf8');
    const failing = new EgressHistoryStore(userDataPath, {
      atomicOperations: {
        renameFile: (source, destination) => {
          if (sameStoragePath(destination, backup)) throw fileSystemError('EIO');
          renameSync(source, destination);
        },
      },
      now: () => 31 * DAY,
    });

    expect(() => failing.append(historyEntry(31 * DAY))).toThrow(EgressHistoryStoreError);
    expect(readFileSync(primary, 'utf8')).toBe(primaryBefore);
    expect(existsSync(backup)).toBe(false);
    expect(new EgressHistoryStore(userDataPath, { now: () => 31 * DAY }).export()).toEqual([
      committed,
    ]);
  });

  it('blocks writes and preserves unknown future primary or backup bytes', () => {
    const first = createFixture();
    mkdirSync(path.dirname(first.primary), { recursive: true });
    const futurePrimary = '{"version":88,"entries":[],"future":"primary"}\r\n';
    writeFileSync(first.primary, futurePrimary, 'utf8');
    const primaryStore = new EgressHistoryStore(first.userDataPath);
    expect(() => primaryStore.export()).toThrow(EgressHistoryUnsupportedVersionError);
    expect(() => primaryStore.append(historyEntry(Date.now()))).toThrow(
      EgressHistoryUnsupportedVersionError,
    );
    expect(readFileSync(first.primary, 'utf8')).toBe(futurePrimary);

    const second = createFixture();
    const validStore = new EgressHistoryStore(second.userDataPath, { now: () => 41 * DAY });
    validStore.append(historyEntry(40 * DAY));
    const primaryBefore = readFileSync(second.primary, 'utf8');
    const futureBackup = '{"version":77,"entries":[],"future":"backup"}\n';
    writeFileSync(second.backup, futureBackup, 'utf8');
    const blocked = new EgressHistoryStore(second.userDataPath, { now: () => 41 * DAY });
    expect(blocked.export()).toEqual([historyEntry(40 * DAY)]);
    expect(() => blocked.append(historyEntry(41 * DAY))).toThrow(
      EgressHistoryUnsupportedVersionError,
    );
    expect(readFileSync(second.primary, 'utf8')).toBe(primaryBefore);
    expect(readFileSync(second.backup, 'utf8')).toBe(futureBackup);
  });

  it('classifies a deeply nested future primary before current-version depth checks', () => {
    const { backup, primary, userDataPath } = createFixture();
    const seed = new EgressHistoryStore(userDataPath, { now: () => 52 * DAY });
    seed.append(historyEntry(50 * DAY));
    seed.append(historyEntry(51 * DAY));
    const backupBefore = readFileSync(backup, 'utf8');
    let futurePayload: unknown = { leaf: true };
    for (let depth = 0; depth < 32; depth += 1) futurePayload = { nested: futurePayload };
    const futurePrimary = `${JSON.stringify({ entries: [], futurePayload, version: 2 })}\r\n`;
    writeFileSync(primary, futurePrimary, 'utf8');
    const blocked = new EgressHistoryStore(userDataPath, { now: () => 52 * DAY });

    expect(() => parseEgressHistoryDocument(futurePrimary)).toThrow(
      EgressHistoryUnsupportedVersionError,
    );
    expect(() => blocked.export()).toThrow(EgressHistoryUnsupportedVersionError);
    expect(() => blocked.append(historyEntry(52 * DAY))).toThrow(
      EgressHistoryUnsupportedVersionError,
    );
    expect(readFileSync(primary, 'utf8')).toBe(futurePrimary);
    expect(readFileSync(backup, 'utf8')).toBe(backupBefore);
  });

  it('strictly rejects extra or duplicate keys, oversized files, too many entries, and future versions', () => {
    const valid = historyEntry(1);
    const document = { entries: [valid], version: 1 };
    const canonical = JSON.stringify(document);
    expect(parseEgressHistoryDocument(canonical)).toEqual([valid]);
    expect(() =>
      parseEgressHistoryDocument('{"entries":[],"\\u0065ntries":[],"version":1}'),
    ).toThrow(EgressHistoryStoreError);
    expect(() =>
      parseEgressHistoryDocument(
        canonical.replace(
          '"assessment":{"agreement":"single-source"',
          '"assessment":{"agreement":"mixed","agreement":"single-source"',
        ),
      ),
    ).toThrow(EgressHistoryStoreError);
    expect(() =>
      parseEgressHistoryDocument(
        JSON.stringify({ ...document, endpointUrl: 'https://example.test' }),
      ),
    ).toThrow(EgressHistoryStoreError);
    expect(() =>
      parseEgressHistoryDocument(
        JSON.stringify({ entries: [{ ...valid, exactAddress: '198.51.100.42' }], version: 1 }),
      ),
    ).toThrow(EgressHistoryStoreError);
    expect(() =>
      parseEgressHistoryDocument(
        JSON.stringify({
          entries: [
            {
              ...valid,
              providers: [
                {
                  ...valid.providers[0],
                  assessment: { ...valid.providers[0]!.assessment, remoteText: 'untrusted' },
                },
              ],
            },
          ],
          version: 1,
        }),
      ),
    ).toThrow(EgressHistoryStoreError);
    expect(() => parseEgressHistoryDocument('x'.repeat(EGRESS_HISTORY_MAX_BYTES + 1))).toThrow(
      EgressHistoryStoreError,
    );
    expect(() =>
      parseEgressHistoryDocument(
        JSON.stringify({
          entries: Array.from({ length: EGRESS_HISTORY_MAX_ENTRIES + 1 }, () => valid),
          version: 1,
        }),
      ),
    ).toThrow(EgressHistoryStoreError);
    expect(() => parseEgressHistoryDocument('{"entries":[],"version":2}')).toThrow(
      EgressHistoryUnsupportedVersionError,
    );
  });

  it('serializes redacted summaries only and rejects exact-address or secret-bearing write shapes', () => {
    const { primary, userDataPath } = createFixture();
    const exact = '198.51.100.142';
    const token = 'ipinfo-token-must-not-persist';
    const store = new EgressHistoryStore(userDataPath, { now: () => 5 * DAY });
    store.append(historyEntry(5 * DAY, exact));
    const serialized = readFileSync(primary, 'utf8');

    expect(serialized).not.toContain(exact);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('candidate:');
    expect(serialized).not.toContain('proxy');

    const unsafe = {
      ...historyEntry(5 * DAY),
      address: exact,
      endpointUrl: 'https://provider.example',
      token,
    } as unknown as EgressHistoryEntry;
    expect(() => store.append(unsafe)).toThrow(EgressHistoryStoreError);
    expect(readFileSync(primary, 'utf8')).toBe(serialized);
  });

  it('exports fresh frozen clones and explicitly clears primary and backup', () => {
    const { backup, primary, userDataPath } = createFixture();
    const store = new EgressHistoryStore(userDataPath, { now: () => 51 * DAY });
    store.append(historyEntry(50 * DAY));
    store.append(historyEntry(51 * DAY));
    const first = store.export();
    const second = store.export();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0]?.addresses)).toBe(true);

    store.clear();
    expect(store.export()).toEqual([]);
    expect(storedEntries(primary)).toEqual([]);
    expect(storedEntries(backup)).toEqual([]);
    expect(new EgressHistoryStore(userDataPath).export()).toEqual([]);
  });

  it('atomically replaces a destination leaf symlink without following its target', () => {
    const { primary, userDataPath } = createFixture();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-outside-'));
    roots.push(outsideRoot);
    const target = path.join(outsideRoot, 'target.json');
    writeFileSync(target, 'outside-must-not-change', 'utf8');
    const store = new EgressHistoryStore(userDataPath, { now: () => 62 * DAY });
    store.append(historyEntry(60 * DAY));
    store.append(historyEntry(61 * DAY));
    rmSync(primary);
    try {
      symlinkSync(target, primary, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    new EgressHistoryStore(userDataPath, { now: () => 62 * DAY }).append(historyEntry(62 * DAY));

    expect(readFileSync(target, 'utf8')).toBe('outside-must-not-change');
    expect(lstatSync(primary).isSymbolicLink()).toBe(false);
    expect(storedEntries(primary).map((entry) => entry.collectedAt)).toEqual([60 * DAY, 62 * DAY]);
  });

  it('fails closed when the egress storage root is a symlink outside userData', () => {
    const { primary, userDataPath } = createFixture();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-root-link-'));
    roots.push(outsideRoot);
    try {
      symlinkSync(outsideRoot, path.dirname(primary), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    expect(() =>
      new EgressHistoryStore(userDataPath, { now: () => DAY }).append(historyEntry(DAY)),
    ).toThrow(EgressHistoryStoreError);
    expect(existsSync(path.join(outsideRoot, 'history.json'))).toBe(false);
  });
});
