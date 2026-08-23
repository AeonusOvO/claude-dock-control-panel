import { isDeepStrictEqual } from 'node:util';
import { registryError, toRegistryFailure } from './registry-errors';
import {
  mergeMcpRegistryRecords,
  normalizeMcpRegistryPages,
  reconcileMcpRegistryLatest,
} from './registry-normalize';
import type { McpRegistrySnapshotStoreLike } from './registry-snapshot';
import {
  MCP_REGISTRY_SNAPSHOT_VERSION,
  type McpRegistryPageSet,
  type McpRegistryRecord,
  type McpRegistrySnapshot,
  type McpRegistryState,
  type McpRegistrySyncKind,
} from './registry-types';

export interface McpRegistryClientLike {
  fetchAll(updatedSince?: string): Promise<McpRegistryPageSet>;
}

export interface McpRegistrySyncServiceOptions {
  now?: () => number;
}

const recordsEqual = (
  left: readonly McpRegistryRecord[],
  right: readonly McpRegistryRecord[],
): boolean =>
  left.length === right.length &&
  left.every((record, index) => isDeepStrictEqual(record, right[index]));

const fallbackMode = (state: McpRegistryState): 'curated-only' | 'live' | 'snapshot' => {
  if (state.mode === 'degraded') return state.fallback;
  return state.mode === 'curated-only' ? 'curated-only' : state.mode;
};

const meaningfulStateEqual = (left: McpRegistryState, right: McpRegistryState): boolean => {
  if (!recordsEqual(left.records, right.records) || left.mode !== right.mode) return false;
  if (left.mode !== 'degraded' || right.mode !== 'degraded') return true;
  return left.fallback === right.fallback && isDeepStrictEqual(left.failure, right.failure);
};

const updatedAtMilliseconds = (record: McpRegistryRecord): number =>
  record.official.updatedAt === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(record.official.updatedAt);

const FULL_SYNC_CATCH_UP_WATERMARK = new Date(0).toISOString();

const advanceWatermark = (floor: string, records: readonly McpRegistryRecord[]): string => {
  const maximum = records.reduce(
    (current, record) => Math.max(current, updatedAtMilliseconds(record)),
    Date.parse(floor),
  );
  return new Date(maximum).toISOString();
};

const fullMergeBase = (
  previous: readonly McpRegistryRecord[],
  full: readonly McpRegistryRecord[],
): McpRegistryRecord[] => {
  const fullIdentities = new Set(full.map(({ identity }) => identity));
  return previous.filter(
    (record) => fullIdentities.has(record.identity) || record.official.status === 'deleted',
  );
};

export class McpRegistrySyncService {
  private contentRevision = 0;
  private forceFullRebuild = false;
  private inFlight?: Promise<McpRegistryState>;
  private inFlightKind?: McpRegistrySyncKind;
  private readonly now: () => number;
  private queuedFull?: Promise<McpRegistryState>;
  private state: McpRegistryState;

  public constructor(
    private readonly client: McpRegistryClientLike,
    private readonly store: McpRegistrySnapshotStoreLike,
    options: McpRegistrySyncServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.state = this.loadInitialState();
    if (this.state.records.length > 0) this.contentRevision = 1;
  }

  public getContentRevision(): number {
    return this.contentRevision;
  }

  public getState(): McpRegistryState {
    return structuredClone(this.state);
  }

  public synchronizeFull(): Promise<McpRegistryState> {
    return this.synchronize('full');
  }

  public synchronizeIncremental(): Promise<McpRegistryState> {
    return this.synchronize('incremental');
  }

  public synchronize(kind: McpRegistrySyncKind = 'incremental'): Promise<McpRegistryState> {
    if (this.queuedFull) return this.queuedFull;
    if (!this.inFlight) return this.startSynchronization(kind);
    if (this.inFlightKind === 'full' || kind === 'incremental') return this.inFlight;

    const active = this.inFlight;
    const startFull = (): Promise<McpRegistryState> => this.startSynchronization('full');
    const queued = active.then(startFull, startFull).finally(() => {
      if (this.queuedFull === queued) this.queuedFull = undefined;
    });
    this.queuedFull = queued;
    return queued;
  }

  private loadInitialState(): McpRegistryState {
    try {
      const loaded = this.store.load();
      if (loaded.kind === 'snapshot') {
        const watermarkUntrusted =
          loaded.requiresFullSync === true ||
          this.watermarkIsAheadOfClock(loaded.snapshot.synchronizedThrough);
        if (watermarkUntrusted) {
          this.forceFullRebuild = true;
          return {
            failure: { code: 'snapshot-watermark-untrusted', stage: 'snapshot' },
            fallback: loaded.snapshot.records.length > 0 ? 'snapshot' : 'curated-only',
            mode: 'degraded',
            records: loaded.snapshot.records,
            synchronizedThrough: loaded.snapshot.synchronizedThrough,
          };
        }
        return {
          loadedFrom: loaded.source,
          mode: 'snapshot',
          records: loaded.snapshot.records,
          synchronizedThrough: loaded.snapshot.synchronizedThrough,
        };
      }
      if (loaded.kind === 'unsupported') {
        return {
          failure: { code: 'snapshot-version-unsupported', stage: 'snapshot' },
          fallback: 'curated-only',
          mode: 'degraded',
          records: [],
        };
      }
      if (loaded.rejected) {
        return {
          failure: {
            code: loaded.rejected === 'oversized' ? 'snapshot-oversized' : 'snapshot-invalid',
            stage: 'snapshot',
          },
          fallback: 'curated-only',
          mode: 'degraded',
          records: [],
        };
      }
      return { mode: 'curated-only', records: [] };
    } catch {
      return {
        failure: { code: 'snapshot-invalid', stage: 'snapshot' },
        fallback: 'curated-only',
        mode: 'degraded',
        records: [],
      };
    }
  }

  private startSynchronization(kind: McpRegistrySyncKind): Promise<McpRegistryState> {
    const effectiveKind = this.effectiveSyncKind(kind);
    const promise = this.synchronizeOnce(effectiveKind).finally(() => {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
        this.inFlightKind = undefined;
      }
    });
    this.inFlight = promise;
    this.inFlightKind = effectiveKind;
    return promise;
  }

  private effectiveSyncKind(kind: McpRegistrySyncKind): McpRegistrySyncKind {
    if (kind === 'full' || !this.state.synchronizedThrough || this.forceFullRebuild) return 'full';
    if (this.watermarkIsAheadOfClock(this.state.synchronizedThrough)) {
      this.forceFullRebuild = true;
      return 'full';
    }
    return 'incremental';
  }

  private async synchronizeOnce(effectiveKind: McpRegistrySyncKind): Promise<McpRegistryState> {
    const previous = this.state;
    try {
      let records: McpRegistryRecord[];
      let watermarkFloor: string;
      if (effectiveKind === 'full') {
        const fullPages = await this.client.fetchAll(undefined);
        const full = normalizeMcpRegistryPages(fullPages.pages);
        if (full.length === 0 && previous.records.length > 0) {
          throw registryError(
            'normalize',
            'empty-full-result',
            'Registry full synchronization unexpectedly returned no records.',
          );
        }

        const catchUpPages = await this.client.fetchAll(FULL_SYNC_CATCH_UP_WATERMARK);
        const catchUp = normalizeMcpRegistryPages(catchUpPages.pages);
        records = mergeMcpRegistryRecords(
          mergeMcpRegistryRecords(fullMergeBase(previous.records, full), full),
          catchUp,
        );
        watermarkFloor = FULL_SYNC_CATCH_UP_WATERMARK;
      } else {
        if (!previous.synchronizedThrough) {
          throw registryError(
            'normalize',
            'malformed-record',
            'Registry incremental synchronization requires a durable watermark.',
          );
        }
        watermarkFloor = previous.synchronizedThrough;
        const pages = await this.client.fetchAll(watermarkFloor);
        records = mergeMcpRegistryRecords(previous.records, normalizeMcpRegistryPages(pages.pages));
      }

      records = reconcileMcpRegistryLatest(records);
      const synchronizedThrough = advanceWatermark(watermarkFloor, records);
      const snapshot: McpRegistrySnapshot = {
        records,
        synchronizedThrough,
        version: MCP_REGISTRY_SNAPSHOT_VERSION,
      };
      this.store.save(snapshot);
      if (effectiveKind === 'full') {
        this.forceFullRebuild = false;
      }
      this.publishState({
        mode: 'live',
        records,
        synchronizedThrough,
        syncKind: effectiveKind,
      });
    } catch (error) {
      this.publishState({
        failure: toRegistryFailure(error, 'persist', 'persist-failed'),
        fallback: fallbackMode(previous),
        mode: 'degraded',
        records: previous.records,
        synchronizedThrough: previous.synchronizedThrough,
      });
    }
    return this.getState();
  }

  private publishState(next: McpRegistryState): void {
    if (!meaningfulStateEqual(this.state, next)) this.contentRevision += 1;
    this.state = next;
  }

  private watermarkIsAheadOfClock(watermark: string): boolean {
    try {
      const value = this.now();
      return !Number.isFinite(value) || Date.parse(watermark) > value;
    } catch {
      return true;
    }
  }
}
