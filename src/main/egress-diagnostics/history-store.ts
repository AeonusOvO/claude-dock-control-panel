import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type {
  EgressAgreement,
  EgressCollectionState,
  EgressConfidence,
  EgressFreshness,
  EgressHistoryEntry,
  EgressHistoryProviderSummary,
  EgressProviderId,
  PersistedRedactedEgressAddress,
} from '../../shared/contracts/egress-diagnostics';
import {
  type EgressAtomicFileOperations,
  isMissingFileError,
  readEgressBoundedUtf8File,
  replaceEgressFileAtomically,
} from './atomic-store';
import { normalizePersistedRedactedEgressAddress } from './address-redactor';

export const EGRESS_HISTORY_SCHEMA_VERSION = 1 as const;
export const EGRESS_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
export const EGRESS_HISTORY_MAX_ENTRIES = 500;
export const EGRESS_HISTORY_DEFAULT_RETENTION_DAYS = 90;

export interface EgressHistoryStoreOptions {
  readonly atomicOperations?: Partial<EgressAtomicFileOperations>;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly retentionDays?: number;
}

export class EgressHistoryStoreError extends Error {
  public constructor(message = 'ClaudeDock cannot safely read or save egress history.') {
    super(message);
    this.name = 'EgressHistoryStoreError';
  }
}

export class EgressHistoryUnsupportedVersionError extends EgressHistoryStoreError {
  public constructor() {
    super('The local egress history was created by a newer ClaudeDock version.');
    this.name = 'EgressHistoryUnsupportedVersionError';
  }
}

interface StoredHistoryDocument {
  readonly entries: readonly EgressHistoryEntry[];
  readonly version: typeof EGRESS_HISTORY_SCHEMA_VERSION;
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

interface ValidCandidate {
  readonly document: StoredHistoryDocument;
  readonly kind: 'valid';
  readonly raw: string;
}

type HistoryCandidate = MissingCandidate | InvalidCandidate | FutureCandidate | ValidCandidate;

type DurableSource = 'backup' | 'primary';
type WriteBlock = 'corrupt' | 'future';

interface ResolvedHistory {
  readonly committedRaw?: string;
  readonly entries: readonly EgressHistoryEntry[];
  readonly source?: DurableSource;
  readonly writeBlock?: WriteBlock;
}

interface HistoryCandidates {
  readonly backup: HistoryCandidate;
  readonly primary: HistoryCandidate;
}

interface StoragePaths {
  readonly backup: string;
  readonly primary: string;
}

const HISTORY_FILE_NAME = 'history.json';
const MAX_ADDRESSES_PER_ENTRY = 16;
const MAX_PROVIDERS_PER_ENTRY = 4;
const MAX_RETENTION_DAYS = 3_650;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MILLISECONDS_PER_DAY = 86_400_000;

const AGREEMENTS: readonly EgressAgreement[] = [
  'corroborated',
  'mixed',
  'single-source',
  'not-comparable',
];
const CONFIDENCES: readonly EgressConfidence[] = ['high', 'moderate', 'limited', 'unknown'];
const FRESHNESS_VALUES: readonly EgressFreshness[] = ['live', 'recent', 'dated', 'unknown'];
const PROVIDERS: readonly EgressProviderId[] = [
  'ipify',
  'ipinfo-max',
  'maxmind-anonymous-plus',
  'abuseipdb',
];
const TERMINAL_STATES: readonly Exclude<EgressCollectionState, 'collecting'>[] = [
  'complete',
  'partial',
  'unavailable',
  'cancelled',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
};

const normalizeAssessment = (value: unknown): EgressHistoryProviderSummary['assessment'] => {
  if (!isRecord(value) || !hasExactKeys(value, ['agreement', 'confidence', 'freshness'])) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  if (
    !AGREEMENTS.includes(value.agreement as EgressAgreement) ||
    !CONFIDENCES.includes(value.confidence as EgressConfidence) ||
    !FRESHNESS_VALUES.includes(value.freshness as EgressFreshness)
  ) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  return Object.freeze({
    agreement: value.agreement as EgressAgreement,
    confidence: value.confidence as EgressConfidence,
    freshness: value.freshness as EgressFreshness,
  });
};

const normalizeProvider = (value: unknown): EgressHistoryProviderSummary => {
  if (!isRecord(value) || !hasExactKeys(value, ['assessment', 'provider', 'state'])) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  if (
    !PROVIDERS.includes(value.provider as EgressProviderId) ||
    !TERMINAL_STATES.includes(value.state as Exclude<EgressCollectionState, 'collecting'>)
  ) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  return Object.freeze({
    assessment: normalizeAssessment(value.assessment),
    provider: value.provider as EgressProviderId,
    state: value.state as Exclude<EgressCollectionState, 'collecting'>,
  });
};

const normalizeAddresses = (value: unknown): readonly PersistedRedactedEgressAddress[] => {
  if (!Array.isArray(value) || value.length > MAX_ADDRESSES_PER_ENTRY) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  try {
    const addresses = value.map(normalizePersistedRedactedEgressAddress);
    const identities = new Set(addresses.map((item) => `${item.family}:${item.fingerprint}`));
    if (identities.size !== addresses.length) throw new EgressHistoryStoreError();
    return Object.freeze(addresses);
  } catch {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
};

const normalizeProviders = (value: unknown): readonly EgressHistoryProviderSummary[] => {
  if (!Array.isArray(value) || value.length > MAX_PROVIDERS_PER_ENTRY) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  const providers = value.map(normalizeProvider);
  const identities = new Set(providers.map((item) => item.provider));
  if (identities.size !== providers.length) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  return Object.freeze(providers);
};

/** Strict runtime boundary for the redacted-only history write API. */
export const normalizeEgressHistoryEntry = (value: unknown): EgressHistoryEntry => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['addresses', 'collectedAt', 'kind', 'providers', 'state']) ||
    value.kind !== 'history' ||
    !Number.isSafeInteger(value.collectedAt) ||
    Number(value.collectedAt) < 0 ||
    Number(value.collectedAt) > MAX_TIMESTAMP ||
    !TERMINAL_STATES.includes(value.state as Exclude<EgressCollectionState, 'collecting'>)
  ) {
    throw new EgressHistoryStoreError('The egress history entry is invalid.');
  }
  return Object.freeze({
    addresses: normalizeAddresses(value.addresses),
    collectedAt: Number(value.collectedAt),
    kind: 'history',
    providers: normalizeProviders(value.providers),
    state: value.state as Exclude<EgressCollectionState, 'collecting'>,
  });
};

const cloneEntry = (entry: EgressHistoryEntry): EgressHistoryEntry =>
  normalizeEgressHistoryEntry({
    addresses: entry.addresses.map((address) => ({ ...address })),
    collectedAt: entry.collectedAt,
    kind: 'history',
    providers: entry.providers.map((provider) => ({
      assessment: { ...provider.assessment },
      provider: provider.provider,
      state: provider.state,
    })),
    state: entry.state,
  });

const serializeEntries = (entries: readonly EgressHistoryEntry[]): string =>
  `${JSON.stringify({ entries, version: EGRESS_HISTORY_SCHEMA_VERSION }, null, 2)}\n`;

interface JsonCursor {
  index: number;
}

const MAX_JSON_NESTING_DEPTH = 16;
const JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);

const skipJsonWhitespace = (raw: string, cursor: JsonCursor): void => {
  while (JSON_WHITESPACE.has(raw[cursor.index] ?? '')) cursor.index += 1;
};

const readJsonString = (raw: string, cursor: JsonCursor): string => {
  const start = cursor.index;
  cursor.index += 1;
  let escaped = false;
  while (cursor.index < raw.length) {
    const character = raw[cursor.index]!;
    cursor.index += 1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const decoded: unknown = JSON.parse(raw.slice(start, cursor.index));
      if (typeof decoded !== 'string') throw new EgressHistoryStoreError();
      return decoded;
    }
  }
  throw new EgressHistoryStoreError('The egress history file is invalid.');
};

const scanJsonPrimitive = (raw: string, cursor: JsonCursor): void => {
  const start = cursor.index;
  while (cursor.index < raw.length) {
    const character = raw[cursor.index]!;
    if (
      JSON_WHITESPACE.has(character) ||
      character === ',' ||
      character === ']' ||
      character === '}'
    ) {
      break;
    }
    cursor.index += 1;
  }
  if (cursor.index === start) throw new EgressHistoryStoreError();
};

function scanJsonValue(raw: string, cursor: JsonCursor, depth: number): void {
  if (depth > MAX_JSON_NESTING_DEPTH) throw new EgressHistoryStoreError();
  skipJsonWhitespace(raw, cursor);
  const character = raw[cursor.index];
  if (character === '{') {
    scanJsonObject(raw, cursor, depth + 1);
  } else if (character === '[') {
    scanJsonArray(raw, cursor, depth + 1);
  } else if (character === '"') {
    readJsonString(raw, cursor);
  } else {
    scanJsonPrimitive(raw, cursor);
  }
}

function scanJsonObject(raw: string, cursor: JsonCursor, depth: number): void {
  cursor.index += 1;
  skipJsonWhitespace(raw, cursor);
  if (raw[cursor.index] === '}') {
    cursor.index += 1;
    return;
  }
  const keys = new Set<string>();
  for (;;) {
    if (raw[cursor.index] !== '"') throw new EgressHistoryStoreError();
    const key = readJsonString(raw, cursor);
    if (keys.has(key)) throw new EgressHistoryStoreError('The egress history file is invalid.');
    keys.add(key);
    skipJsonWhitespace(raw, cursor);
    if (raw[cursor.index] !== ':') throw new EgressHistoryStoreError();
    cursor.index += 1;
    scanJsonValue(raw, cursor, depth);
    skipJsonWhitespace(raw, cursor);
    const delimiter = raw[cursor.index];
    cursor.index += 1;
    if (delimiter === '}') return;
    if (delimiter !== ',') throw new EgressHistoryStoreError();
    skipJsonWhitespace(raw, cursor);
  }
}

function scanJsonArray(raw: string, cursor: JsonCursor, depth: number): void {
  cursor.index += 1;
  skipJsonWhitespace(raw, cursor);
  if (raw[cursor.index] === ']') {
    cursor.index += 1;
    return;
  }
  for (;;) {
    scanJsonValue(raw, cursor, depth);
    skipJsonWhitespace(raw, cursor);
    const delimiter = raw[cursor.index];
    cursor.index += 1;
    if (delimiter === ']') return;
    if (delimiter !== ',') throw new EgressHistoryStoreError();
    skipJsonWhitespace(raw, cursor);
  }
}

const assertNoDuplicateJsonObjectKeys = (raw: string): void => {
  const cursor = { index: 0 };
  scanJsonValue(raw, cursor, 0);
  skipJsonWhitespace(raw, cursor);
  if (cursor.index !== raw.length) throw new EgressHistoryStoreError();
};

/** Strictly parses one complete v1 document and rejects all extra or duplicate keys. */
export const parseEgressHistoryDocument = (raw: string): readonly EgressHistoryEntry[] => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > EGRESS_HISTORY_MAX_BYTES) {
    throw new EgressHistoryStoreError('The egress history file is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EgressHistoryStoreError('The egress history file is invalid.');
  }
  if (
    isRecord(value) &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version > EGRESS_HISTORY_SCHEMA_VERSION
  ) {
    throw new EgressHistoryUnsupportedVersionError();
  }
  try {
    assertNoDuplicateJsonObjectKeys(raw);
  } catch {
    throw new EgressHistoryStoreError('The egress history file is invalid.');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['entries', 'version']) ||
    value.version !== EGRESS_HISTORY_SCHEMA_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > EGRESS_HISTORY_MAX_ENTRIES
  ) {
    throw new EgressHistoryStoreError('The egress history file is invalid.');
  }
  return Object.freeze(value.entries.map(normalizeEgressHistoryEntry));
};

const inspectHistoryCandidate = (raw: string): HistoryCandidate => {
  try {
    const entries = parseEgressHistoryDocument(raw);
    return {
      document: { entries, version: EGRESS_HISTORY_SCHEMA_VERSION },
      kind: 'valid',
      raw,
    };
  } catch (error) {
    return error instanceof EgressHistoryUnsupportedVersionError
      ? { kind: 'future' }
      : { kind: 'invalid' };
  }
};

const pathIsContainedBy = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const compareHistoryEntries = (first: EgressHistoryEntry, second: EgressHistoryEntry): number => {
  if (first.collectedAt !== second.collectedAt) return first.collectedAt - second.collectedAt;
  const firstCanonical = JSON.stringify(first);
  const secondCanonical = JSON.stringify(second);
  if (firstCanonical === secondCanonical) return 0;
  return firstCanonical < secondCanonical ? -1 : 1;
};

/** Durable redacted history rooted beneath the supplied Electron userData directory. */
export class EgressHistoryStore {
  private readonly atomicOperations: Partial<EgressAtomicFileOperations>;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly storageDirectory: string;
  private snapshot: readonly EgressHistoryEntry[] | undefined;
  private readonly userDataPath: string;

  public constructor(userDataPath: string, options: EgressHistoryStoreOptions = {}) {
    if (!path.isAbsolute(userDataPath)) throw new EgressHistoryStoreError();
    const maxEntries = options.maxEntries ?? EGRESS_HISTORY_MAX_ENTRIES;
    const retentionDays = options.retentionDays ?? EGRESS_HISTORY_DEFAULT_RETENTION_DAYS;
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > EGRESS_HISTORY_MAX_ENTRIES ||
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > MAX_RETENTION_DAYS
    ) {
      throw new EgressHistoryStoreError('The egress history retention configuration is invalid.');
    }
    this.userDataPath = path.resolve(userDataPath);
    this.storageDirectory = path.join(this.userDataPath, 'egress-diagnostics');
    this.atomicOperations = options.atomicOperations ?? {};
    this.maxEntries = maxEntries;
    this.now = options.now ?? Date.now;
    this.retentionDays = retentionDays;
  }

  public append(entry: EgressHistoryEntry): EgressHistoryEntry {
    const normalized = normalizeEgressHistoryEntry(entry);
    const current = this.resolveHistory(this.readCandidates());
    this.assertWritable(current);
    const next = this.prune([...current.entries, normalized]);
    const serialized = serializeEntries(next);
    this.assertSerializedSize(serialized);
    this.persistCandidate(current, serialized);
    this.snapshot = next;
    return cloneEntry(normalized);
  }

  /** Returns a freshly pruned, ordered, redacted-only deep clone. */
  public export(): readonly EgressHistoryEntry[] {
    const source = this.snapshot ?? this.resolveHistory(this.readCandidates()).entries;
    this.snapshot = this.prune(source);
    return Object.freeze(this.snapshot.map(cloneEntry));
  }

  /** Explicitly clears both primary and backup while retaining transactional failure behavior. */
  public clear(): void {
    const candidates = this.readCandidates();
    if (candidates.primary.kind === 'future' || candidates.backup.kind === 'future') {
      throw new EgressHistoryUnsupportedVersionError();
    }
    if (candidates.primary.kind === 'missing' && candidates.backup.kind === 'missing') {
      this.snapshot = Object.freeze([]);
      return;
    }
    const empty = serializeEntries([]);
    const current = this.resolveHistory(candidates);
    try {
      const paths = this.prepareStoragePaths();
      if (current.source === 'backup' && current.committedRaw) {
        replaceEgressFileAtomically(paths.primary, current.committedRaw, this.atomicOperations);
      }
      replaceEgressFileAtomically(paths.backup, empty, this.atomicOperations);
      replaceEgressFileAtomically(paths.primary, empty, this.atomicOperations);
      this.restrictFiles(paths);
    } catch (error) {
      if (error instanceof EgressHistoryStoreError) throw error;
      throw new EgressHistoryStoreError('ClaudeDock could not safely clear egress history.');
    }
    this.snapshot = Object.freeze([]);
  }

  private assertSerializedSize(serialized: string): void {
    if (Buffer.byteLength(serialized, 'utf8') > EGRESS_HISTORY_MAX_BYTES) {
      throw new EgressHistoryStoreError('The egress history file exceeds its size limit.');
    }
  }

  private assertWritable(history: ResolvedHistory): void {
    if (history.writeBlock === 'future') throw new EgressHistoryUnsupportedVersionError();
    if (history.writeBlock === 'corrupt') {
      throw new EgressHistoryStoreError('Corrupt egress history will not be overwritten.');
    }
  }

  private existingStoragePaths(): StoragePaths | undefined {
    let directory;
    try {
      directory = lstatSync(this.storageDirectory);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new EgressHistoryStoreError();
    const userDataReal = realpathSync.native(this.userDataPath);
    const directoryReal = realpathSync.native(this.storageDirectory);
    if (!pathIsContainedBy(userDataReal, directoryReal)) throw new EgressHistoryStoreError();
    const primary = path.join(directoryReal, HISTORY_FILE_NAME);
    return { backup: `${primary}.bak`, primary };
  }

  private persistCandidate(current: ResolvedHistory, serialized: string): void {
    try {
      const paths = this.prepareStoragePaths();
      if (current.committedRaw) {
        replaceEgressFileAtomically(paths.backup, current.committedRaw, this.atomicOperations);
        const verified = readEgressBoundedUtf8File(paths.backup, EGRESS_HISTORY_MAX_BYTES);
        if (verified !== current.committedRaw) throw new EgressHistoryStoreError();
      }
      replaceEgressFileAtomically(paths.primary, serialized, this.atomicOperations);
      this.restrictFiles(paths);
    } catch (error) {
      if (error instanceof EgressHistoryStoreError) throw error;
      throw new EgressHistoryStoreError('ClaudeDock could not safely save egress history.');
    }
  }

  private prepareStoragePaths(): StoragePaths {
    try {
      const userData = lstatSync(this.userDataPath);
      if (!userData.isDirectory()) throw new EgressHistoryStoreError();
      const userDataReal = realpathSync.native(this.userDataPath);
      try {
        mkdirSync(this.storageDirectory, { mode: 0o700, recursive: false });
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
          throw error;
        }
      }
      const directory = lstatSync(this.storageDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new EgressHistoryStoreError();
      const directoryReal = realpathSync.native(this.storageDirectory);
      if (!pathIsContainedBy(userDataReal, directoryReal)) throw new EgressHistoryStoreError();
      try {
        chmodSync(directoryReal, 0o700);
      } catch {
        // POSIX modes are best effort on Windows and mode-less filesystems.
      }
      const primary = path.join(directoryReal, HISTORY_FILE_NAME);
      return { backup: `${primary}.bak`, primary };
    } catch (error) {
      if (error instanceof EgressHistoryStoreError) throw error;
      throw new EgressHistoryStoreError();
    }
  }

  private prune(entries: readonly EgressHistoryEntry[]): readonly EgressHistoryEntry[] {
    let now: number;
    try {
      now = this.now();
    } catch {
      throw new EgressHistoryStoreError('The egress history clock is invalid.');
    }
    if (!Number.isFinite(now) || now < 0 || now > MAX_TIMESTAMP) {
      throw new EgressHistoryStoreError('The egress history clock is invalid.');
    }
    const cutoff = now - this.retentionDays * MILLISECONDS_PER_DAY;
    return Object.freeze(
      entries
        .filter((entry) => entry.collectedAt >= cutoff)
        .map(cloneEntry)
        .sort(compareHistoryEntries)
        .slice(-this.maxEntries),
    );
  }

  private readCandidate(filePath: string): HistoryCandidate {
    try {
      const leaf = lstatSync(filePath);
      if (!leaf.isFile() || leaf.isSymbolicLink()) return { kind: 'invalid' };
      const raw = readEgressBoundedUtf8File(filePath, EGRESS_HISTORY_MAX_BYTES);
      return raw === undefined ? { kind: 'missing' } : inspectHistoryCandidate(raw);
    } catch (error) {
      return isMissingFileError(error) ? { kind: 'missing' } : { kind: 'invalid' };
    }
  }

  private readCandidates(): HistoryCandidates {
    let paths: StoragePaths | undefined;
    try {
      paths = this.existingStoragePaths();
    } catch {
      return { backup: { kind: 'invalid' }, primary: { kind: 'invalid' } };
    }
    if (!paths) return { backup: { kind: 'missing' }, primary: { kind: 'missing' } };
    return {
      backup: this.readCandidate(paths.backup),
      primary: this.readCandidate(paths.primary),
    };
  }

  private resolveHistory(candidates: HistoryCandidates): ResolvedHistory {
    const { backup, primary } = candidates;
    if (primary.kind === 'future') throw new EgressHistoryUnsupportedVersionError();
    if (primary.kind === 'valid') {
      return {
        committedRaw: primary.raw,
        entries: primary.document.entries,
        source: 'primary',
        ...(backup.kind === 'future' ? { writeBlock: 'future' as const } : {}),
      };
    }
    if (backup.kind === 'future') throw new EgressHistoryUnsupportedVersionError();
    if (backup.kind === 'valid') {
      return {
        committedRaw: backup.raw,
        entries: backup.document.entries,
        source: 'backup',
      };
    }
    const bothMissing = primary.kind === 'missing' && backup.kind === 'missing';
    return {
      entries: Object.freeze([]),
      ...(!bothMissing ? { writeBlock: 'corrupt' as const } : {}),
    };
  }

  private restrictFiles(paths: StoragePaths): void {
    for (const filePath of [paths.primary, paths.backup]) {
      try {
        chmodSync(filePath, 0o600);
      } catch {
        // Atomic temporary files are already 0600; this is best-effort hardening after rename.
      }
    }
  }
}
