import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeMcpRegistryPages } from '../../src/main/mcp/registry-normalize';
import { McpRegistrySnapshotStore } from '../../src/main/mcp/registry-snapshot';
import {
  MCP_REGISTRY_SNAPSHOT_VERSION,
  type McpRegistryRecord,
  type McpRegistrySnapshot,
} from '../../src/main/mcp/registry-types';

const roots: string[] = [];
const createRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-registry-snapshot-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const wrapper = (version = '1.0.0', status: 'active' | 'deleted' = 'active') => ({
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      isLatest: status === 'active',
      publishedAt: '2026-08-01T00:00:00.000Z',
      status,
      statusChangedAt: '2026-08-19T00:00:00.000Z',
      ...(status === 'deleted' ? { statusMessage: 'Removed by publisher' } : {}),
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
  },
  server: {
    description: 'Snapshot fixture',
    name: 'io.example/snapshot',
    packages: [
      {
        environmentVariables: [
          {
            isRequired: true,
            isSecret: true,
            name: 'API_TOKEN',
            placeholder: 'Enter a token at install time',
          },
        ],
        identifier: '@example/snapshot',
        registryType: 'npm',
        runtimeArguments: [{ type: 'positional', valueHint: 'workspace' }],
        transport: { type: 'stdio' },
        version,
      },
    ],
    remotes: [
      {
        headers: [{ isRequired: true, isSecret: true, name: 'Authorization' }],
        type: 'sse',
        url: 'https://remote.example/sse',
      },
    ],
    version,
  },
});

const record = (version = '1.0.0', status: 'active' | 'deleted' = 'active'): McpRegistryRecord =>
  normalizeMcpRegistryPages([[wrapper(version, status)]])[0]!;

const snapshot = (
  watermark: string,
  records: McpRegistryRecord[] = [record()],
): McpRegistrySnapshot => ({
  records,
  synchronizedThrough: watermark,
  version: MCP_REGISTRY_SNAPSHOT_VERSION,
});

describe('McpRegistrySnapshotStore', () => {
  it('persists to the userData mcp path and reloads a strict versioned snapshot', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    const candidate = snapshot('2026-08-20T01:00:00.000Z');

    store.save(candidate);
    const loaded = store.load();

    expect(store.storagePath).toBe(path.join(root, 'mcp', 'registry-snapshot.json'));
    expect(store.backupPath).toBe(`${store.storagePath}.bak`);
    expect(loaded).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        synchronizedThrough: '2026-08-20T01:00:00.000Z',
        version: MCP_REGISTRY_SNAPSHOT_VERSION,
      },
      source: 'primary',
    });
    if (loaded.kind === 'snapshot') {
      expect(loaded.snapshot.records[0]).toMatchObject({
        name: 'io.example/snapshot',
        official: { status: 'active' },
        version: '1.0.0',
      });
      expect(loaded.snapshot.records[0]?.remotes?.[0]?.type).toBe('sse');
      expect(loaded.snapshot.records[0]?.packages?.[0]?.runtimeArguments).toHaveLength(1);
    }
  });

  it('loads a legacy local-clock watermark only as data requiring a safe full rebuild', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    store.save(snapshot('2026-08-20T01:00:00.000Z'));
    const legacy = JSON.parse(readFileSync(store.storagePath, 'utf8')) as Record<string, unknown>;
    legacy.version = 1;
    writeFileSync(store.storagePath, JSON.stringify(legacy), 'utf8');

    const loaded = store.load();

    expect(loaded).toMatchObject({
      kind: 'snapshot',
      requiresFullSync: true,
      snapshot: { version: MCP_REGISTRY_SNAPSHOT_VERSION },
      source: 'primary',
    });
  });

  it('preserves the prior valid primary as backup and recovers from primary corruption', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    store.save(snapshot('2026-08-20T01:00:00.000Z', [record('1.0.0')]));
    store.save(snapshot('2026-08-20T02:00:00.000Z', [record('2.0.0')]));
    writeFileSync(store.storagePath, '{"version":1,"records":[', 'utf8');

    const loaded = new McpRegistrySnapshotStore(root).load();

    expect(loaded).toMatchObject({
      kind: 'snapshot',
      snapshot: { synchronizedThrough: '2026-08-20T01:00:00.000Z' },
      source: 'backup',
    });
    if (loaded.kind === 'snapshot') expect(loaded.snapshot.records[0]?.version).toBe('1.0.0');
  });

  it('keeps the committed predecessor recoverable when primary replacement fails after backup', () => {
    const root = createRoot();
    const initialStore = new McpRegistrySnapshotStore(root);
    initialStore.save(snapshot('2026-08-20T01:00:00.000Z', [record('1.0.0')]));
    const committedPrimary = readFileSync(initialStore.storagePath);
    const temporaryIds = ['backup-write', 'primary-write'];
    const failingStore = new McpRegistrySnapshotStore(root, {
      temporaryId: () => temporaryIds.shift() ?? 'unexpected',
    });
    const blockedPrimaryTemporary = `${failingStore.storagePath}.${process.pid}.primary-write.tmp`;
    writeFileSync(blockedPrimaryTemporary, 'occupied', 'utf8');

    expect(() =>
      failingStore.save(snapshot('2026-08-20T02:00:00.000Z', [record('2.0.0')])),
    ).toThrowError(expect.objectContaining({ code: 'persist-failed' }));

    expect(readFileSync(failingStore.storagePath)).toEqual(committedPrimary);
    expect(readFileSync(failingStore.backupPath)).toEqual(committedPrimary);
    const restarted = new McpRegistrySnapshotStore(root).load();
    expect(restarted).toMatchObject({
      kind: 'snapshot',
      snapshot: { synchronizedThrough: '2026-08-20T01:00:00.000Z' },
      source: 'primary',
    });
    if (restarted.kind === 'snapshot') {
      expect(restarted.snapshot.records[0]?.version).toBe('1.0.0');
    }
  });

  it('does not overwrite an unknown future snapshot version', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    mkdirSync(path.dirname(store.storagePath), { recursive: true });
    const future = `{"version":${MCP_REGISTRY_SNAPSHOT_VERSION + 1},"synchronizedThrough":"future","records":[]}\n`;
    writeFileSync(store.storagePath, future, 'utf8');

    expect(store.load()).toEqual({
      kind: 'unsupported',
      source: 'primary',
      version: MCP_REGISTRY_SNAPSHOT_VERSION + 1,
    });
    expect(() => store.save(snapshot('2026-08-20T03:00:00.000Z'))).toThrowError(
      expect.objectContaining({ code: 'snapshot-version-unsupported' }),
    );
    expect(readFileSync(store.storagePath, 'utf8')).toBe(future);
  });

  it('loads a valid predecessor backup without overwriting an unknown future primary', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    store.save(snapshot('2026-08-20T01:00:00.000Z', [record('1.0.0')]));
    store.save(snapshot('2026-08-20T02:00:00.000Z', [record('2.0.0')]));
    const futurePrimary = `{"version":${MCP_REGISTRY_SNAPSHOT_VERSION + 1},"synchronizedThrough":"future","records":[]}\n`;
    writeFileSync(store.storagePath, futurePrimary, 'utf8');

    const loaded = store.load();

    expect(loaded).toMatchObject({
      kind: 'snapshot',
      snapshot: { synchronizedThrough: '2026-08-20T01:00:00.000Z' },
      source: 'backup',
    });
    expect(() => store.save(snapshot('2026-08-20T03:00:00.000Z'))).toThrowError(
      expect.objectContaining({ code: 'snapshot-version-unsupported' }),
    );
    expect(readFileSync(store.storagePath, 'utf8')).toBe(futurePrimary);
  });

  it('does not overwrite an unknown future backup version', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    store.save(snapshot('2026-08-20T03:00:00.000Z', [record('1.0.0')]));
    const committedPrimary = readFileSync(store.storagePath);
    const futureBackup = `{"version":${MCP_REGISTRY_SNAPSHOT_VERSION + 1},"synchronizedThrough":"future","records":[]}\n`;
    writeFileSync(store.backupPath, futureBackup, 'utf8');

    expect(store.load()).toMatchObject({ kind: 'snapshot', source: 'primary' });
    expect(() => store.save(snapshot('2026-08-20T04:00:00.000Z', [record('2.0.0')]))).toThrowError(
      expect.objectContaining({ code: 'snapshot-version-unsupported' }),
    );
    expect(readFileSync(store.storagePath)).toEqual(committedPrimary);
    expect(readFileSync(store.backupPath, 'utf8')).toBe(futureBackup);
  });

  it('bounds bytes read from the opened descriptor when a snapshot grows after stat', () => {
    const root = createRoot();
    const initialStore = new McpRegistrySnapshotStore(root);
    initialStore.save(snapshot('2026-08-20T03:30:00.000Z'));
    const committedBytes = readFileSync(initialStore.storagePath);
    const boundedStore = new McpRegistrySnapshotStore(root, {
      afterReadStat: (candidatePath) => appendFileSync(candidatePath, 'x'),
      maxBytes: committedBytes.length,
    });

    expect(boundedStore.load()).toEqual({ kind: 'empty', rejected: 'oversized' });
  });

  it('rejects oversized, malformed, and structurally non-strict snapshots', () => {
    const oversizedRoot = createRoot();
    const oversizedStore = new McpRegistrySnapshotStore(oversizedRoot, { maxBytes: 128 });
    mkdirSync(path.dirname(oversizedStore.storagePath), { recursive: true });
    writeFileSync(oversizedStore.storagePath, 'x'.repeat(129), 'utf8');
    expect(oversizedStore.load()).toEqual({ kind: 'empty', rejected: 'oversized' });

    const malformedRoot = createRoot();
    const malformedStore = new McpRegistrySnapshotStore(malformedRoot);
    mkdirSync(path.dirname(malformedStore.storagePath), { recursive: true });
    writeFileSync(malformedStore.storagePath, '{broken', 'utf8');
    expect(malformedStore.load()).toEqual({ kind: 'empty', rejected: 'invalid' });

    const strictRoot = createRoot();
    const strictStore = new McpRegistrySnapshotStore(strictRoot);
    strictStore.save(snapshot('2026-08-20T04:00:00.000Z'));
    const parsed = JSON.parse(readFileSync(strictStore.storagePath, 'utf8')) as Record<
      string,
      unknown
    >;
    parsed.healthResults = [];
    writeFileSync(strictStore.storagePath, JSON.stringify(parsed), 'utf8');
    expect(strictStore.load()).toEqual({ kind: 'empty', rejected: 'invalid' });
  });

  it('rejects malformed UTF-8 instead of normalizing replacement characters', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    store.save(snapshot('2026-08-20T04:30:00.000Z'));
    const bytes = readFileSync(store.storagePath);
    const marker = Buffer.from('Snapshot fixture', 'utf8');
    const markerIndex = bytes.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const malformed = Buffer.concat([
      bytes.subarray(0, markerIndex),
      Buffer.from([0xc3, 0x28]),
      bytes.subarray(markerIndex + 1),
    ]);
    writeFileSync(store.storagePath, malformed);

    expect(store.load()).toEqual({ kind: 'empty', rejected: 'invalid' });
  });

  it('persists catalog metadata only, without generated IDs or operational/user state', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root);
    const candidateRecord = record();
    Object.assign(candidateRecord as unknown as Record<string, unknown>, {
      executablePlan: ['do-not-persist'],
      healthResults: ['do-not-persist'],
      rawError: 'do-not-persist',
      userValues: { API_TOKEN: 'do-not-persist' },
    });

    store.save(snapshot('2026-08-20T05:00:00.000Z', [candidateRecord]));
    const raw = readFileSync(store.storagePath, 'utf8');

    expect(raw).not.toContain('do-not-persist');
    expect(raw).not.toContain('executablePlan');
    expect(raw).not.toContain('healthResults');
    expect(raw).not.toContain('rawError');
    expect(raw).not.toContain('userValues');
    expect(raw).not.toMatch(/"id":"(?:package|remote|header|variable):/);
    expect(raw).toContain('"isSecret":true');
    expect(raw).toContain('"placeholder":"Enter a token at install time"');
  });

  it('fsyncs the containing directory after each committed rename', () => {
    const root = createRoot();
    const synchronizedDirectories: string[] = [];
    const store = new McpRegistrySnapshotStore(root, {
      fsyncDirectory: (directoryPath) => synchronizedDirectories.push(directoryPath),
    });
    const directory = path.join(root, 'mcp');

    store.save(snapshot('2026-08-20T05:30:00.000Z', [record('1.0.0')]));
    expect(synchronizedDirectories).toEqual([directory]);
    synchronizedDirectories.length = 0;

    store.save(snapshot('2026-08-20T05:45:00.000Z', [record('2.0.0')]));
    expect(synchronizedDirectories).toEqual([directory, directory]);
  });

  it('treats rename as the truthful commit boundary when directory fsync fails', () => {
    const root = createRoot();
    const initialStore = new McpRegistrySnapshotStore(root);
    initialStore.save(snapshot('2026-08-20T05:50:00.000Z', [record('1.0.0')]));
    const predecessor = readFileSync(initialStore.storagePath);
    const store = new McpRegistrySnapshotStore(root, {
      fsyncDirectory: () => {
        throw new Error('injected directory fsync failure');
      },
    });

    expect(() => store.save(snapshot('2026-08-20T05:55:00.000Z', [record('2.0.0')]))).not.toThrow();

    const restarted = new McpRegistrySnapshotStore(root).load();
    expect(restarted).toMatchObject({
      kind: 'snapshot',
      snapshot: { synchronizedThrough: '2026-08-20T05:55:00.000Z' },
      source: 'primary',
    });
    if (restarted.kind === 'snapshot') {
      expect(restarted.snapshot.records[0]?.version).toBe('2.0.0');
    }
    expect(readFileSync(store.backupPath)).toEqual(predecessor);
  });

  it('uses exclusive unique temporary files and leaves the primary untouched on write failure', () => {
    const root = createRoot();
    const store = new McpRegistrySnapshotStore(root, { temporaryId: () => 'fixed' });
    mkdirSync(path.dirname(store.storagePath), { recursive: true });
    const blockedTemporary = `${store.storagePath}.${process.pid}.fixed.tmp`;
    writeFileSync(blockedTemporary, 'occupied', 'utf8');

    expect(() => store.save(snapshot('2026-08-20T06:00:00.000Z'))).toThrowError(
      expect.objectContaining({ code: 'persist-failed' }),
    );
    expect(() => readFileSync(store.storagePath)).toThrow();
  });
});
