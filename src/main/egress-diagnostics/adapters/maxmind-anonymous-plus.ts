import type { Buffer } from 'node:buffer';
import type {
  EgressDiagnosticIssue,
  EgressLiveSourceEvidence,
  EgressSourceTime,
  LiveExactEgressAddress,
} from '../../../shared/contracts/egress-diagnostics';
import { normalizeEgressAddress } from '../address';
import { deriveEvidenceAssessment, deriveSourceFreshness } from '../evidence-policy';
import { createEgressExplanation } from '../explanation';
import {
  inspectMaxMindDatabaseFile,
  readValidatedMaxMindDatabase,
  realMaxMindFileSystem,
  sameMaxMindFileIdentity,
  type MaxMindFileIdentity,
  type MaxMindFileSystem,
  type ValidatedMaxMindDatabase,
} from '../maxmind-file-policy';
import { dateOnlyEpoch, EgressParseError, isUnknownRecord } from '../parsing';

export interface MaxMindAnonymousPlusReader {
  anonymousPlus(address: string): unknown;
  close?(): Promise<void> | void;
}

export type MaxMindAnonymousPlusReaderFactory = (
  databaseBytes: Buffer,
) => Promise<MaxMindAnonymousPlusReader>;

export interface MaxMindAnonymousPlusFacts {
  readonly anonymizerConfidence?: number;
  readonly isAnonymous: boolean;
  readonly isAnonymousVpn: boolean;
  readonly isHostingProvider: boolean;
  readonly isPublicProxy: boolean;
  readonly isResidentialProxy: boolean;
  readonly isTorExitNode: boolean;
  readonly networkLastSeen?: string;
  readonly providerName?: string;
}

export interface MaxMindAnonymousPlusEvidence extends EgressLiveSourceEvidence {
  readonly facts?: MaxMindAnonymousPlusFacts;
  readonly provider: 'maxmind-anonymous-plus';
}

export interface MaxMindAnonymousPlusAdapterOptions {
  readonly databasePath: string;
  readonly databaseRoot: string;
  readonly fileSystem?: MaxMindFileSystem;
  readonly now?: () => number;
  readonly readerFactory: MaxMindAnonymousPlusReaderFactory;
}

export interface MaxMindAnonymousPlusCollectInput {
  readonly address: LiveExactEgressAddress;
  readonly leaseCurrent: boolean;
}

interface CachedReader {
  readonly identity: MaxMindFileIdentity;
  readonly reader: MaxMindAnonymousPlusReader;
}

class MaxMindLocalError extends Error {
  public readonly code: 'invalid-configuration' | 'lookup-failed' | 'malformed-response';

  public constructor(code: MaxMindLocalError['code']) {
    super(
      code === 'invalid-configuration'
        ? 'The main-owned MaxMind database path failed local file validation.'
        : code === 'malformed-response'
          ? 'The MaxMind Anonymous Plus record was malformed.'
          : 'The local MaxMind Anonymous Plus lookup failed.',
    );
    this.name = 'MaxMindLocalError';
    this.code = code;
  }
}

const optionalLocalBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new EgressParseError();
  return value;
};

const optionalLocalString = (
  record: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximumLength) throw new EgressParseError();
  return value;
};

const optionalLocalInteger = (
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new EgressParseError();
  }
  return value;
};

export const parseMaxMindAnonymousPlusRecord = (
  value: unknown,
): { facts: MaxMindAnonymousPlusFacts; sourceTimes: readonly EgressSourceTime[] } => {
  if (!isUnknownRecord(value)) throw new EgressParseError();
  const networkLastSeen = optionalLocalString(value, 'networkLastSeen', 10);
  const networkLastSeenEpoch = networkLastSeen ? dateOnlyEpoch(networkLastSeen) : undefined;
  if (networkLastSeen && networkLastSeenEpoch === undefined) throw new EgressParseError();
  return {
    facts: {
      anonymizerConfidence: optionalLocalInteger(value, 'anonymizerConfidence', 1, 99),
      isAnonymous: optionalLocalBoolean(value, 'isAnonymous'),
      isAnonymousVpn: optionalLocalBoolean(value, 'isAnonymousVpn'),
      isHostingProvider: optionalLocalBoolean(value, 'isHostingProvider'),
      isPublicProxy: optionalLocalBoolean(value, 'isPublicProxy'),
      isResidentialProxy: optionalLocalBoolean(value, 'isResidentialProxy'),
      isTorExitNode: optionalLocalBoolean(value, 'isTorExitNode'),
      networkLastSeen,
      providerName: optionalLocalString(value, 'providerName', 160),
    },
    sourceTimes:
      networkLastSeen && networkLastSeenEpoch !== undefined
        ? [{ epochMs: networkLastSeenEpoch, label: 'network_last_seen', value: networkLastSeen }]
        : [],
  };
};

const closeReader = async (reader: MaxMindAnonymousPlusReader | undefined): Promise<void> => {
  try {
    await reader?.close?.();
  } catch {
    // Closing a stale local reader must not expose library or path details.
  }
};

const issueFromError = (error: unknown): EgressDiagnosticIssue => {
  if (error instanceof MaxMindLocalError) return { code: error.code, message: error.message };
  if (error instanceof EgressParseError) {
    return {
      code: 'malformed-response',
      message: 'The MaxMind Anonymous Plus record was malformed.',
    };
  }
  return { code: 'lookup-failed', message: 'The local MaxMind Anonymous Plus lookup failed.' };
};

export class MaxMindAnonymousPlusAdapter {
  private cache: CachedReader | undefined;
  private readerRefresh: Promise<CachedReader> | undefined;
  private readonly databasePath: string;
  private readonly databaseRoot: string;
  private readonly fileSystem: MaxMindFileSystem;
  private readonly now: () => number;
  private readonly readerFactory: MaxMindAnonymousPlusReaderFactory;

  public constructor(options: MaxMindAnonymousPlusAdapterOptions) {
    this.databasePath = options.databasePath;
    this.databaseRoot = options.databaseRoot;
    this.fileSystem = options.fileSystem ?? realMaxMindFileSystem;
    this.now = options.now ?? Date.now;
    this.readerFactory = options.readerFactory;
  }

  public async collect(
    input: MaxMindAnonymousPlusCollectInput,
  ): Promise<MaxMindAnonymousPlusEvidence> {
    const collectedAt = this.now();
    const address = normalizeEgressAddress(input.address.address, input.address.family);
    try {
      const cached = await this.reader();
      let rawRecord: unknown;
      try {
        rawRecord = cached.reader.anonymousPlus(address.address);
      } catch {
        throw new MaxMindLocalError('lookup-failed');
      }
      const afterLookup = await this.inspect();
      if (!sameMaxMindFileIdentity(cached.identity, afterLookup)) {
        if (this.cache?.reader === cached.reader) {
          this.cache = undefined;
          await closeReader(cached.reader);
        }
        throw new MaxMindLocalError('invalid-configuration');
      }
      const parsed = parseMaxMindAnonymousPlusRecord(rawRecord);
      const databaseTime: EgressSourceTime = {
        epochMs: cached.identity.modifiedAtMs,
        label: 'database-file-mtime',
        value: new Date(cached.identity.modifiedAtMs).toISOString(),
      };
      const assessment = deriveEvidenceAssessment({
        collectionState: 'complete',
        comparisonKeys: [address.address],
        leaseCurrent: input.leaseCurrent,
        sourceFreshness: deriveSourceFreshness({
          now: collectedAt,
          sourceTimestamps: [cached.identity.modifiedAtMs],
        }),
        strictParse: true,
        transport: 'local:maxmind-mmdb',
      });
      return {
        address,
        assessment,
        explanation: createEgressExplanation({
          assessment,
          family: address.family,
          provider: 'maxmind-anonymous-plus',
          state: 'complete',
        }),
        facts: parsed.facts,
        family: address.family,
        kind: 'live-source',
        provider: 'maxmind-anonymous-plus',
        provenance: {
          collectedAt,
          provider: 'maxmind-anonymous-plus',
          sourceTimes: [...parsed.sourceTimes, databaseTime],
          transport: 'local:maxmind-mmdb',
        },
        state: 'complete',
      };
    } catch (error) {
      const issue = issueFromError(error);
      const assessment = deriveEvidenceAssessment({
        collectionState: 'unavailable',
        leaseCurrent: input.leaseCurrent,
        sourceFreshness: 'unknown',
        strictParse: false,
        transport: 'local:maxmind-mmdb',
      });
      return {
        assessment,
        explanation: createEgressExplanation({
          assessment,
          family: address.family,
          issueCode: issue.code,
          provider: 'maxmind-anonymous-plus',
          state: 'unavailable',
        }),
        family: address.family,
        issue,
        kind: 'live-source',
        provider: 'maxmind-anonymous-plus',
        provenance: {
          collectedAt,
          provider: 'maxmind-anonymous-plus',
          sourceTimes: [],
          transport: 'local:maxmind-mmdb',
        },
        state: 'unavailable',
      };
    }
  }

  public async close(): Promise<void> {
    try {
      await this.readerRefresh;
    } catch {
      // A failed refresh has no cached reader to retain.
    }
    const reader = this.cache?.reader;
    this.cache = undefined;
    await closeReader(reader);
  }

  private async inspect(): Promise<MaxMindFileIdentity> {
    try {
      return await inspectMaxMindDatabaseFile(
        this.fileSystem,
        this.databaseRoot,
        this.databasePath,
      );
    } catch {
      throw new MaxMindLocalError('invalid-configuration');
    }
  }

  private async reader(): Promise<CachedReader> {
    const identity = await this.inspect();
    if (this.cache && sameMaxMindFileIdentity(this.cache.identity, identity)) return this.cache;
    if (this.readerRefresh) {
      await this.readerRefresh;
      return this.reader();
    }
    const refresh = this.openReader(identity);
    this.readerRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.readerRefresh === refresh) this.readerRefresh = undefined;
    }
  }

  private async openReader(identity: MaxMindFileIdentity): Promise<CachedReader> {
    const staleReader = this.cache?.reader;
    this.cache = undefined;
    await closeReader(staleReader);
    let loaded: ValidatedMaxMindDatabase;
    try {
      loaded = await readValidatedMaxMindDatabase(
        this.fileSystem,
        this.databaseRoot,
        this.databasePath,
      );
    } catch {
      throw new MaxMindLocalError('invalid-configuration');
    }
    if (!sameMaxMindFileIdentity(identity, loaded.identity)) {
      throw new MaxMindLocalError('invalid-configuration');
    }
    let reader: MaxMindAnonymousPlusReader;
    try {
      reader = await this.readerFactory(loaded.bytes);
    } catch {
      throw new MaxMindLocalError('lookup-failed');
    }
    try {
      const afterOpen = await this.inspect();
      if (!sameMaxMindFileIdentity(identity, afterOpen)) {
        throw new MaxMindLocalError('invalid-configuration');
      }
      this.cache = { identity: afterOpen, reader };
      return this.cache;
    } catch (error) {
      await closeReader(reader);
      throw error;
    }
  }
}

export const createMaxMindAnonymousPlusAdapter = (
  options: MaxMindAnonymousPlusAdapterOptions,
): MaxMindAnonymousPlusAdapter => new MaxMindAnonymousPlusAdapter(options);
