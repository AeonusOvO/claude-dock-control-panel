import { describe, expect, it, vi } from 'vitest';
import { registryError } from '../../src/main/mcp/registry-errors';
import { normalizeMcpRegistryPages } from '../../src/main/mcp/registry-normalize';
import type { McpRegistrySnapshotStoreLike } from '../../src/main/mcp/registry-snapshot';
import {
  McpRegistrySyncService,
  type McpRegistryClientLike,
} from '../../src/main/mcp/registry-service';
import {
  MCP_REGISTRY_SNAPSHOT_VERSION,
  type McpRegistryPageSet,
  type McpRegistryRecord,
  type McpRegistrySnapshot,
  type McpRegistrySnapshotLoadResult,
} from '../../src/main/mcp/registry-types';

const wrapper = (
  name: string,
  version: string,
  status: 'active' | 'deleted' | 'deprecated' = 'active',
  description = `${name} ${version}`,
  officialOverrides: Partial<{
    isLatest: boolean;
    publishedAt: string;
    statusChangedAt: string;
    updatedAt: string;
  }> = {},
) => ({
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      isLatest: status === 'active',
      publishedAt: '2026-08-01T00:00:00.000Z',
      status,
      statusChangedAt: '2026-08-19T00:00:00.000Z',
      ...(status === 'active' ? {} : { statusMessage: `${status} lifecycle record` }),
      updatedAt: '2026-08-20T00:00:00.000Z',
      ...officialOverrides,
    },
  },
  server: {
    description,
    name,
    packages: [
      {
        identifier: `@example/${name.split('/')[1]}`,
        registryType: 'npm',
        transport: { type: 'stdio' },
        version,
      },
    ],
    remotes: [{ type: 'streamable-http', url: `https://remote.invalid/${version}` }],
    version,
  },
});

const normalized = (...wrappers: unknown[]): McpRegistryRecord[] =>
  normalizeMcpRegistryPages([wrappers]);

const pageSet = (...pages: unknown[][]): McpRegistryPageSet => ({
  pages,
  recordCount: pages.reduce((count, page) => count + page.length, 0),
  totalBytes: 0,
});

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

class MemorySnapshotStore implements McpRegistrySnapshotStoreLike {
  public attempted?: McpRegistrySnapshot;
  public failSave = false;
  public onSave?: (snapshot: McpRegistrySnapshot) => void;
  public readonly saved: McpRegistrySnapshot[] = [];

  public constructor(private readonly loaded: McpRegistrySnapshotLoadResult = { kind: 'empty' }) {}

  public load(): McpRegistrySnapshotLoadResult {
    return structuredClone(this.loaded);
  }

  public save(snapshot: McpRegistrySnapshot): void {
    this.attempted = structuredClone(snapshot);
    this.onSave?.(snapshot);
    if (this.failSave) {
      throw registryError('persist', 'persist-failed', 'Injected persistence failure.');
    }
    this.saved.push(structuredClone(snapshot));
  }
}

const durableSnapshot = (
  records: McpRegistryRecord[],
  synchronizedThrough = '2026-08-19T00:00:00.000Z',
): McpRegistrySnapshot => ({
  records,
  synchronizedThrough,
  version: MCP_REGISTRY_SNAPSHOT_VERSION,
});

describe('McpRegistrySyncService', () => {
  it('uses Registry revisions for a full watermark, catches up, then publishes memory', async () => {
    const clock = vi.fn(() => Date.parse('2099-08-20T10:11:12.013Z'));
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValueOnce(pageSet([wrapper('io.example/one', '1.0.0')]))
      .mockResolvedValueOnce(pageSet([]));
    const store = new MemorySnapshotStore();
    const service = new McpRegistrySyncService({ fetchAll }, store, { now: clock });
    store.onSave = (candidate) => {
      expect(service.getState().mode).toBe('curated-only');
      expect(candidate.synchronizedThrough).toBe('2026-08-20T00:00:00.000Z');
    };

    const state = await service.synchronizeFull();

    expect(fetchAll.mock.calls.map(([watermark]) => watermark)).toEqual([
      undefined,
      '1970-01-01T00:00:00.000Z',
    ]);
    expect(clock).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(1);
    expect(state).toMatchObject({
      mode: 'live',
      synchronizedThrough: '2026-08-20T00:00:00.000Z',
      syncKind: 'full',
    });
    expect(state.records).toHaveLength(1);
  });

  it('uses the durable watermark for incremental sync and merges lifecycle tombstones', async () => {
    const previousRecords = normalized(
      wrapper('io.example/one', '1.0.0'),
      wrapper('io.example/two', '2.0.0'),
    );
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords),
      source: 'primary',
    });
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValue(
        pageSet([
          wrapper('io.example/one', '1.0.0', 'deleted'),
          wrapper('io.example/three', '3.0.0', 'deprecated'),
        ]),
      );
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    });

    const state = await service.synchronizeIncremental();

    expect(fetchAll).toHaveBeenCalledWith('2026-08-19T00:00:00.000Z');
    expect(state).toMatchObject({
      mode: 'live',
      synchronizedThrough: '2026-08-20T00:00:00.000Z',
      syncKind: 'incremental',
    });
    expect(state.records).toHaveLength(3);
    expect(state.records.find(({ name }) => name === 'io.example/one')?.official.status).toBe(
      'deleted',
    );
    expect(state.records.find(({ name }) => name === 'io.example/two')?.official.status).toBe(
      'active',
    );
    expect(state.records.find(({ name }) => name === 'io.example/three')?.official.status).toBe(
      'deprecated',
    );
    expect(store.saved[0]?.synchronizedThrough).toBe('2026-08-20T00:00:00.000Z');
  });

  it('queues and coalesces full rebuilds behind an active incremental sync', async () => {
    const previousRecords = normalized(wrapper('io.example/previous', '1.0.0'));
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords),
      source: 'primary',
    });
    let resolveIncremental!: (value: McpRegistryPageSet) => void;
    let resolveFull!: (value: McpRegistryPageSet) => void;
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveIncremental = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFull = resolve;
          }),
      )
      .mockResolvedValueOnce(pageSet([]));
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-20T12:30:00.000Z'),
    });

    const incremental = service.synchronizeIncremental();
    const full = service.synchronizeFull();
    expect(service.synchronizeFull()).toBe(full);
    expect(service.synchronizeIncremental()).toBe(full);
    expect(fetchAll).toHaveBeenCalledTimes(1);

    resolveIncremental(pageSet([wrapper('io.example/incremental', '2.0.0')]));
    await incremental;
    expect(fetchAll).toHaveBeenCalledTimes(2);
    expect(fetchAll.mock.calls[0]?.[0]).toBe('2026-08-19T00:00:00.000Z');
    expect(fetchAll.mock.calls[1]?.[0]).toBeUndefined();

    resolveFull(pageSet([wrapper('io.example/full', '3.0.0')]));
    const state = await full;

    expect(state).toMatchObject({ mode: 'live', syncKind: 'full' });
    expect(state.records.map(({ name }) => name)).toEqual(['io.example/full']);
    expect(store.saved).toHaveLength(2);
  });

  it('coalesces incremental callers and duplicate full callers behind an active full publication', async () => {
    const response = deferred<McpRegistryPageSet>();
    const fetchAll = vi.fn<McpRegistryClientLike['fetchAll']>().mockReturnValue(response.promise);
    const store = new MemorySnapshotStore();
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-20T12:45:00.000Z'),
    });

    const full = service.synchronizeFull();
    const duplicateFull = service.synchronizeFull();
    const incremental = service.synchronizeIncremental();

    expect(duplicateFull).toBe(full);
    expect(incremental).toBe(full);
    expect(fetchAll).toHaveBeenCalledOnce();
    response.resolve(pageSet([wrapper('io.example/full-first', '1.0.0')]));

    await expect(Promise.all([full, duplicateFull, incremental])).resolves.toHaveLength(3);
    expect(fetchAll).toHaveBeenCalledTimes(2);
    expect(fetchAll.mock.calls[1]?.[0]).toBe('1970-01-01T00:00:00.000Z');
    expect(store.saved).toHaveLength(1);
    expect(service.getState()).toMatchObject({ mode: 'live', syncKind: 'full' });
  });

  it('treats no-watermark incremental work as full when an explicit full caller overlaps', async () => {
    const response = deferred<McpRegistryPageSet>();
    const fetchAll = vi.fn<McpRegistryClientLike['fetchAll']>().mockReturnValue(response.promise);
    const store = new MemorySnapshotStore();
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-20T12:50:00.000Z'),
    });

    const ordinary = service.synchronizeIncremental();
    const explicitFull = service.synchronizeFull();

    expect(explicitFull).toBe(ordinary);
    expect(fetchAll).toHaveBeenCalledWith(undefined);
    response.resolve(pageSet([wrapper('io.example/no-watermark-overlap', '1.0.0')]));

    await expect(explicitFull).resolves.toMatchObject({ mode: 'live', syncKind: 'full' });
    expect(fetchAll).toHaveBeenCalledTimes(2);
    expect(fetchAll.mock.calls[1]?.[0]).toBe('1970-01-01T00:00:00.000Z');
    expect(store.saved).toHaveLength(1);
  });

  it('runs a queued full rebuild after weaker incremental work degrades', async () => {
    const previousRecords = normalized(wrapper('io.example/previous', '1.0.0'));
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords),
      source: 'primary',
    });
    const incrementalResponse = deferred<McpRegistryPageSet>();
    const fullResponse = deferred<McpRegistryPageSet>();
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockReturnValueOnce(incrementalResponse.promise)
      .mockReturnValueOnce(fullResponse.promise)
      .mockResolvedValueOnce(pageSet([]));
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-20T12:55:00.000Z'),
    });

    const incremental = service.synchronizeIncremental();
    const full = service.synchronizeFull();
    incrementalResponse.reject(registryError('fetch', 'request-failed', 'offline'));

    await expect(incremental).resolves.toMatchObject({ mode: 'degraded' });
    await vi.waitFor(() => expect(fetchAll).toHaveBeenCalledTimes(2));
    expect(fetchAll.mock.calls[1]?.[0]).toBeUndefined();
    fullResponse.resolve(pageSet([wrapper('io.example/recovered-full', '2.0.0')]));

    await expect(full).resolves.toMatchObject({ mode: 'live', syncKind: 'full' });
    expect(store.saved).toHaveLength(1);
    expect(service.getState().records.map(({ name }) => name)).toEqual([
      'io.example/recovered-full',
    ]);
  });

  it('falls back to a full sync when no durable watermark exists', async () => {
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValue(pageSet([wrapper('io.example/one', '1.0.0')]));
    const service = new McpRegistrySyncService({ fetchAll }, new MemorySnapshotStore(), {
      now: () => Date.parse('2026-08-20T13:00:00.000Z'),
    });

    const state = await service.synchronizeIncremental();

    expect(fetchAll).toHaveBeenCalledWith(undefined);
    expect(state).toMatchObject({ mode: 'live', syncKind: 'full' });
  });

  it('advances the content revision only when normalized Registry records change', async () => {
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValueOnce(pageSet([wrapper('io.example/stable', '1.0.0')]))
      .mockResolvedValueOnce(pageSet([]))
      .mockResolvedValueOnce(pageSet([]))
      .mockResolvedValueOnce(pageSet([wrapper('io.example/stable', '2.0.0')]));
    const service = new McpRegistrySyncService({ fetchAll }, new MemorySnapshotStore(), {
      now: () => Date.parse('2026-08-20T13:15:00.000Z'),
    });

    expect(service.getContentRevision()).toBe(0);
    await service.synchronizeFull();
    const populatedRevision = service.getContentRevision();
    expect(populatedRevision).toBe(1);

    await service.synchronizeIncremental();
    expect(service.getContentRevision()).toBe(populatedRevision);

    await service.synchronizeIncremental();
    expect(service.getContentRevision()).toBe(populatedRevision + 1);
  });

  it('rejects an implausible empty full rebuild when a nonempty snapshot exists', async () => {
    const previousRecords = normalized(wrapper('io.example/one', '1.0.0'));
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords),
      source: 'primary',
    });
    const service = new McpRegistrySyncService(
      {
        fetchAll: vi.fn<McpRegistryClientLike['fetchAll']>().mockResolvedValue(pageSet([])),
      },
      store,
      { now: () => Date.parse('2026-08-20T13:30:00.000Z') },
    );

    const state = await service.synchronizeFull();

    expect(state).toMatchObject({
      failure: { code: 'empty-full-result', stage: 'normalize' },
      fallback: 'snapshot',
      mode: 'degraded',
      synchronizedThrough: '2026-08-19T00:00:00.000Z',
    });
    expect(state.records).toEqual(previousRecords);
    expect(store.saved).toHaveLength(0);
  });

  it('keeps the last-known-good records and watermark on fetch or normalization failure', async () => {
    const previousRecords = normalized(wrapper('io.example/one', '1.0.0'));
    const loadResult: McpRegistrySnapshotLoadResult = {
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords),
      source: 'backup',
    };
    const fetchStore = new MemorySnapshotStore(loadResult);
    const fetchFailure = new McpRegistrySyncService(
      {
        fetchAll: vi
          .fn<McpRegistryClientLike['fetchAll']>()
          .mockRejectedValue(registryError('fetch', 'request-failed', 'offline')),
      },
      fetchStore,
      { now: () => Date.parse('2026-08-20T14:00:00.000Z') },
    );

    const afterFetchFailure = await fetchFailure.synchronizeIncremental();

    expect(afterFetchFailure).toMatchObject({
      failure: { code: 'request-failed', stage: 'fetch' },
      fallback: 'snapshot',
      mode: 'degraded',
      synchronizedThrough: '2026-08-19T00:00:00.000Z',
    });
    expect(afterFetchFailure.records).toEqual(previousRecords);
    expect(fetchStore.saved).toHaveLength(0);

    const normalizeStore = new MemorySnapshotStore(loadResult);
    const conflictingLeft = wrapper('io.example/one', '1.0.0');
    const conflictingRight = wrapper('io.example/one', '1.0.0', 'active', 'conflicting duplicate');
    const normalizeFailure = new McpRegistrySyncService(
      {
        fetchAll: vi
          .fn<McpRegistryClientLike['fetchAll']>()
          .mockResolvedValue(pageSet([conflictingLeft, conflictingRight])),
      },
      normalizeStore,
      { now: () => Date.parse('2026-08-20T15:00:00.000Z') },
    );

    const afterNormalizeFailure = await normalizeFailure.synchronizeIncremental();

    expect(afterNormalizeFailure).toMatchObject({
      failure: { code: 'canonical-collision', stage: 'normalize' },
      fallback: 'snapshot',
      mode: 'degraded',
      synchronizedThrough: '2026-08-19T00:00:00.000Z',
    });
    expect(afterNormalizeFailure.records).toEqual(previousRecords);
    expect(normalizeStore.saved).toHaveLength(0);
  });

  it('persists before publication and preserves memory/watermark when persistence fails', async () => {
    const previousRecords = normalized(wrapper('io.example/one', '1.0.0'));
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords),
      source: 'primary',
    });
    store.failSave = true;
    const service = new McpRegistrySyncService(
      {
        fetchAll: vi
          .fn<McpRegistryClientLike['fetchAll']>()
          .mockResolvedValue(pageSet([wrapper('io.example/two', '2.0.0')])),
      },
      store,
      { now: () => Date.parse('2026-08-20T16:00:00.000Z') },
    );
    store.onSave = () => {
      expect(service.getState()).toMatchObject({
        mode: 'snapshot',
        synchronizedThrough: '2026-08-19T00:00:00.000Z',
      });
    };

    const state = await service.synchronizeIncremental();

    expect(store.attempted?.synchronizedThrough).toBe('2026-08-20T00:00:00.000Z');
    expect(state).toMatchObject({
      failure: { code: 'persist-failed', stage: 'persist' },
      fallback: 'snapshot',
      mode: 'degraded',
      synchronizedThrough: '2026-08-19T00:00:00.000Z',
    });
    expect(state.records).toEqual(previousRecords);
    expect(store.saved).toHaveLength(0);
  });

  it('promotes the newest surviving sibling and never resurrects a tombstoned identity', async () => {
    const older = wrapper('io.example/versions', '1.0.0', 'active', 'older', {
      isLatest: false,
      publishedAt: '2026-08-01T00:00:00.000Z',
      statusChangedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    });
    const latest = wrapper('io.example/versions', '2.0.0', 'active', 'latest', {
      isLatest: true,
      publishedAt: '2026-08-02T00:00:00.000Z',
      statusChangedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    });
    const previousRecords = normalized(older, latest);
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords, '2026-08-10T00:00:00.000Z'),
      source: 'primary',
    });
    const tombstone = wrapper('io.example/versions', '2.0.0', 'deleted', 'latest', {
      isLatest: false,
      publishedAt: '2026-08-02T00:00:00.000Z',
      statusChangedAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
    const staleResurrection = wrapper('io.example/versions', '2.0.0', 'active', 'latest', {
      isLatest: true,
      publishedAt: '2026-08-02T00:00:00.000Z',
      statusChangedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    });
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValueOnce(pageSet([tombstone]))
      .mockResolvedValueOnce(pageSet([staleResurrection]));
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-30T00:00:00.000Z'),
    });

    const tombstoned = await service.synchronizeIncremental();
    const promoted = tombstoned.records.find(({ version }) => version === '1.0.0');
    const deleted = tombstoned.records.find(({ version }) => version === '2.0.0');
    expect(promoted?.official).toMatchObject({ isLatest: true, status: 'active' });
    expect(deleted?.official).toMatchObject({ isLatest: false, status: 'deleted' });
    expect(tombstoned.synchronizedThrough).toBe('2026-08-20T00:00:00.000Z');
    const revision = service.getContentRevision();

    const afterStaleUpdate = await service.synchronizeIncremental();
    expect(
      afterStaleUpdate.records.find(({ version }) => version === '2.0.0')?.official.status,
    ).toBe('deleted');
    expect(afterStaleUpdate.synchronizedThrough).toBe('2026-08-20T00:00:00.000Z');
    expect(service.getContentRevision()).toBe(revision);
  });

  it('catches deterministic mutations after a paginated full traversal before publication', async () => {
    const older = wrapper('io.example/mutating', '1.0.0', 'active', 'older', {
      isLatest: false,
      publishedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    });
    const latest = wrapper('io.example/mutating', '2.0.0', 'active', 'latest', {
      isLatest: true,
      publishedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    });
    const deletedLatest = wrapper('io.example/mutating', '2.0.0', 'deleted', 'latest', {
      isLatest: false,
      publishedAt: '2026-08-02T00:00:00.000Z',
      statusChangedAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const addedDuringTraversal = wrapper(
      'io.example/added-during-full',
      '1.0.0',
      'active',
      'added',
      {
        updatedAt: '2026-08-22T01:00:00.000Z',
      },
    );
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValueOnce(pageSet([older], [latest]))
      .mockResolvedValueOnce(pageSet([deletedLatest, addedDuringTraversal]));
    const store = new MemorySnapshotStore();
    const service = new McpRegistrySyncService({ fetchAll }, store);
    store.onSave = () => expect(fetchAll).toHaveBeenCalledTimes(2);

    const state = await service.synchronizeFull();

    expect(fetchAll.mock.calls.map(([watermark]) => watermark)).toEqual([
      undefined,
      '1970-01-01T00:00:00.000Z',
    ]);
    expect(state.records.find(({ version }) => version === '1.0.0')?.official.isLatest).toBe(true);
    expect(state.records.find(({ version }) => version === '2.0.0')?.official.status).toBe(
      'deleted',
    );
    expect(state.records.some(({ name }) => name === 'io.example/added-during-full')).toBe(true);
    expect(state.synchronizedThrough).toBe('2026-08-22T01:00:00.000Z');
    expect(store.saved).toHaveLength(1);
  });

  it('rejects a future snapshot watermark and safely resets it through a full catch-up', async () => {
    const previousRecords = normalized(wrapper('io.example/future', '1.0.0'));
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords, '2099-01-01T00:00:00.000Z'),
      source: 'primary',
    });
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValueOnce(pageSet([wrapper('io.example/future', '1.0.0')]))
      .mockResolvedValueOnce(pageSet([]));
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-20T00:00:00.000Z'),
    });

    expect(service.getState()).toMatchObject({
      failure: { code: 'snapshot-watermark-untrusted', stage: 'snapshot' },
      fallback: 'snapshot',
      mode: 'degraded',
    });
    const state = await service.synchronizeIncremental();

    expect(fetchAll.mock.calls.map(([watermark]) => watermark)).toEqual([
      undefined,
      '1970-01-01T00:00:00.000Z',
    ]);
    expect(state).toMatchObject({
      mode: 'live',
      synchronizedThrough: '2026-08-20T00:00:00.000Z',
      syncKind: 'full',
    });
  });

  it('advances revision for snapshot, live, and degraded state transitions only once', async () => {
    const previousRecords = normalized(wrapper('io.example/stateful', '1.0.0'));
    const store = new MemorySnapshotStore({
      kind: 'snapshot',
      snapshot: durableSnapshot(previousRecords),
      source: 'primary',
    });
    const failure = registryError('fetch', 'request-failed', 'offline');
    const fetchAll = vi
      .fn<McpRegistryClientLike['fetchAll']>()
      .mockResolvedValueOnce(pageSet([]))
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(pageSet([]));
    const service = new McpRegistrySyncService({ fetchAll }, store, {
      now: () => Date.parse('2026-08-30T00:00:00.000Z'),
    });

    expect(service.getContentRevision()).toBe(1);
    await service.synchronizeIncremental();
    expect(service.getState().mode).toBe('live');
    expect(service.getContentRevision()).toBe(2);

    await service.synchronizeIncremental();
    expect(service.getState().mode).toBe('degraded');
    expect(service.getContentRevision()).toBe(3);

    await service.synchronizeIncremental();
    expect(service.getContentRevision()).toBe(3);

    await service.synchronizeIncremental();
    expect(service.getState().mode).toBe('live');
    expect(service.getContentRevision()).toBe(4);
  });

  it('exposes curated-only and typed degraded states for absent or unusable snapshots', () => {
    const client: McpRegistryClientLike = {
      fetchAll: vi.fn().mockResolvedValue(pageSet([])),
    };
    expect(new McpRegistrySyncService(client, new MemorySnapshotStore()).getState()).toEqual({
      mode: 'curated-only',
      records: [],
    });
    expect(
      new McpRegistrySyncService(
        client,
        new MemorySnapshotStore({ kind: 'unsupported', source: 'primary', version: 2 }),
      ).getState(),
    ).toEqual({
      failure: { code: 'snapshot-version-unsupported', stage: 'snapshot' },
      fallback: 'curated-only',
      mode: 'degraded',
      records: [],
    });
  });
});
