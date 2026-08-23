import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { McpRegistryError, registryError } from './registry-errors';
import { canonicalRegistryContent } from './registry-id';
import { normalizeMcpRegistryPages, reconcileMcpRegistryLatest } from './registry-normalize';
import { isRegistryRecord } from './registry-parse';
import {
  MCP_REGISTRY_SNAPSHOT_VERSION,
  type McpRegistryArgument,
  type McpRegistryInputFields,
  type McpRegistryKeyValueDescriptor,
  type McpRegistryLocalTransport,
  type McpRegistryPackageAlternative,
  type McpRegistryRecord,
  type McpRegistryRemoteAlternative,
  type McpRegistrySnapshot,
  type McpRegistrySnapshotLoadResult,
  type McpRegistryVariableDescriptor,
} from './registry-types';

export const DEFAULT_MCP_REGISTRY_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const LEGACY_MCP_REGISTRY_SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_RECORDS = 10_000;
const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';
const SNAPSHOT_KEYS = new Set(['records', 'synchronizedThrough', 'version']);
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

type RawObject = { [key: string]: unknown };

interface PersistedSnapshot {
  records: RawObject[];
  synchronizedThrough: string;
  version: typeof MCP_REGISTRY_SNAPSHOT_VERSION;
}

interface SnapshotCandidateBase {
  bytes?: Buffer;
  source: 'backup' | 'primary';
}

type SnapshotCandidate =
  | (SnapshotCandidateBase & { kind: 'invalid' | 'missing' | 'oversized' })
  | (SnapshotCandidateBase & {
      kind: 'snapshot';
      requiresFullSync?: true;
      snapshot: McpRegistrySnapshot;
    })
  | (SnapshotCandidateBase & { kind: 'unsupported'; version: number });

export interface McpRegistrySnapshotStoreLike {
  load(): McpRegistrySnapshotLoadResult;
  save(snapshot: McpRegistrySnapshot): void;
}

export interface McpRegistrySnapshotStoreOptions {
  afterReadStat?: (candidatePath: string) => void;
  fsyncDirectory?: (directoryPath: string) => void;
  maxBytes?: number;
  temporaryId?: () => string;
}

const defaultFsyncDirectory = (directoryPath: string): void => {
  if (process.platform === 'win32') {
    // Node cannot open a Windows directory for FlushFileBuffers. File contents are
    // flushed before the same-volume rename; POSIX additionally flushes the entry.
    return;
  }
  const handle = openSync(directoryPath, 'r');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
};

const compactObject = (value: Record<string, unknown>): RawObject => {
  const output = Object.create(null) as RawObject;
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output;
};

const variablesToRaw = (
  variables: McpRegistryVariableDescriptor[] | undefined,
): RawObject | undefined => {
  if (variables === undefined) return undefined;
  const output = Object.create(null) as RawObject;
  for (const variable of variables) {
    const { id: omittedId, name, ...fields } = variable;
    void omittedId;
    output[name] = inputToRaw(fields);
  }
  return output;
};

const inputToRaw = (input: McpRegistryInputFields): RawObject =>
  compactObject({
    choices: input.choices,
    default: input.default,
    description: input.description,
    format: input.format,
    isRequired: input.isRequired,
    isSecret: input.isSecret,
    placeholder: input.placeholder,
    value: input.value,
    variables: variablesToRaw(input.variables),
  });

const keyValueToRaw = (descriptor: McpRegistryKeyValueDescriptor): RawObject => {
  const { id: omittedId, name, ...fields } = descriptor;
  void omittedId;
  return compactObject({ ...inputToRaw(fields), name });
};

const argumentToRaw = (argument: McpRegistryArgument): RawObject => {
  const { id: omittedId, ...fields } = argument;
  void omittedId;
  return compactObject({
    ...inputToRaw(fields),
    isRepeated: fields.isRepeated,
    name: fields.type === 'named' ? fields.name : undefined,
    type: fields.type,
    valueHint: fields.type === 'positional' ? fields.valueHint : undefined,
  });
};

const transportToRaw = (transport: McpRegistryLocalTransport): RawObject => {
  if (transport.type === 'stdio') return { type: 'stdio' };
  return compactObject({
    headers: transport.headers?.map(keyValueToRaw),
    type: transport.type,
    url: transport.url,
  });
};

const packageToRaw = (alternative: McpRegistryPackageAlternative): RawObject => {
  const { id: omittedId } = alternative;
  void omittedId;
  return compactObject({
    environmentVariables: alternative.environmentVariables?.map(keyValueToRaw),
    fileSha256: alternative.fileSha256,
    identifier: alternative.identifier,
    packageArguments: alternative.packageArguments?.map(argumentToRaw),
    registryBaseUrl: alternative.registryBaseUrl,
    registryType: alternative.registryType,
    runtimeArguments: alternative.runtimeArguments?.map(argumentToRaw),
    runtimeHint: alternative.runtimeHint,
    transport: transportToRaw(alternative.transport),
    version: alternative.version,
  });
};

const remoteToRaw = (alternative: McpRegistryRemoteAlternative): RawObject => {
  const { id: omittedId } = alternative;
  void omittedId;
  return compactObject({
    headers: alternative.headers?.map(keyValueToRaw),
    type: alternative.type,
    url: alternative.url,
    variables: variablesToRaw(alternative.variables),
  });
};

const metadataToRaw = (record: McpRegistryRecord): RawObject | undefined => {
  const metadata = Object.create(null) as RawObject;
  for (const [key, value] of Object.entries(record.registryExtensions ?? {})) {
    metadata[key] = value;
  }
  const official = compactObject({ ...record.official });
  if (Object.keys(official).length > 0) metadata[OFFICIAL_META_KEY] = official;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const recordToRaw = (record: McpRegistryRecord): RawObject => {
  const server = compactObject({
    $schema: record.schemaUrl,
    _meta: record.catalogMetadata,
    description: record.description,
    icons: record.icons,
    name: record.name,
    packages: record.packages?.map(packageToRaw),
    remotes: record.remotes?.map(remoteToRaw),
    repository: record.repository,
    title: record.title,
    version: record.version,
    websiteUrl: record.websiteUrl,
  });
  return compactObject({ _meta: metadataToRaw(record), server });
};

const persistedSnapshot = (snapshot: McpRegistrySnapshot): PersistedSnapshot => ({
  records: snapshot.records.map(recordToRaw),
  synchronizedThrough: snapshot.synchronizedThrough,
  version: MCP_REGISTRY_SNAPSHOT_VERSION,
});

const validWatermark = (value: unknown): value is string =>
  typeof value === 'string' && RFC3339.test(value) && !Number.isNaN(Date.parse(value));

const sameCanonicalMultiset = (
  rawRecords: readonly unknown[],
  records: readonly McpRegistryRecord[],
): boolean => {
  try {
    const source = rawRecords.map((record) => canonicalRegistryContent(record, false)).sort();
    const roundTrip = records
      .map((record) => canonicalRegistryContent(recordToRaw(record), false))
      .sort();
    return (
      source.length === roundTrip.length &&
      source.every((value, index) => value === roundTrip[index])
    );
  } catch {
    return false;
  }
};

const parsePersistedSnapshot = (
  bytes: Buffer,
):
  | { kind: 'invalid' }
  | { kind: 'snapshot'; requiresFullSync?: true; snapshot: McpRegistrySnapshot }
  | { kind: 'unsupported'; version: number } => {
  let value: unknown;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(decoded) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRegistryRecord(value)) return { kind: 'invalid' };
  if (
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version > MCP_REGISTRY_SNAPSHOT_VERSION
  ) {
    return { kind: 'unsupported', version: value.version };
  }
  const isLegacy = value.version === LEGACY_MCP_REGISTRY_SNAPSHOT_VERSION;
  if (
    (!isLegacy && value.version !== MCP_REGISTRY_SNAPSHOT_VERSION) ||
    Object.keys(value).some((key) => !SNAPSHOT_KEYS.has(key)) ||
    !validWatermark(value.synchronizedThrough) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_SNAPSHOT_RECORDS
  ) {
    return { kind: 'invalid' };
  }
  try {
    const normalized = normalizeMcpRegistryPages([value.records]);
    const records = isLegacy ? normalized : reconcileMcpRegistryLatest(normalized);
    if (!sameCanonicalMultiset(value.records, records)) return { kind: 'invalid' };
    return {
      kind: 'snapshot',
      ...(isLegacy ? { requiresFullSync: true as const } : {}),
      snapshot: {
        records,
        synchronizedThrough: value.synchronizedThrough,
        version: MCP_REGISTRY_SNAPSHOT_VERSION,
      },
    };
  } catch {
    return { kind: 'invalid' };
  }
};

const positiveSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
};

export class McpRegistrySnapshotStore implements McpRegistrySnapshotStoreLike {
  private readonly afterReadStat?: (candidatePath: string) => void;
  public readonly backupPath: string;
  private readonly directory: string;
  private readonly fsyncDirectory: (directoryPath: string) => void;
  private readonly maxBytes: number;
  public readonly storagePath: string;
  private readonly temporaryId: () => string;

  public constructor(storageRoot: string, options: McpRegistrySnapshotStoreOptions = {}) {
    this.afterReadStat = options.afterReadStat;
    this.directory = path.join(storageRoot, 'mcp');
    this.storagePath = path.join(this.directory, 'registry-snapshot.json');
    this.backupPath = `${this.storagePath}.bak`;
    this.fsyncDirectory = options.fsyncDirectory ?? defaultFsyncDirectory;
    this.maxBytes = positiveSafeInteger(
      options.maxBytes ?? DEFAULT_MCP_REGISTRY_SNAPSHOT_MAX_BYTES,
      'maxBytes',
    );
    this.temporaryId = options.temporaryId ?? randomUUID;
  }

  public load(): McpRegistrySnapshotLoadResult {
    const primary = this.readCandidate(this.storagePath, 'primary');
    if (primary.kind === 'snapshot') {
      return {
        kind: 'snapshot',
        ...(primary.requiresFullSync ? { requiresFullSync: true as const } : {}),
        snapshot: primary.snapshot,
        source: 'primary',
      };
    }
    const backup = this.readCandidate(this.backupPath, 'backup');
    if (backup.kind === 'snapshot') {
      return {
        kind: 'snapshot',
        ...(backup.requiresFullSync ? { requiresFullSync: true as const } : {}),
        snapshot: backup.snapshot,
        source: 'backup',
      };
    }
    if (primary.kind === 'unsupported') {
      return { kind: 'unsupported', source: 'primary', version: primary.version };
    }
    if (backup.kind === 'unsupported') {
      return { kind: 'unsupported', source: 'backup', version: backup.version };
    }
    const rejected =
      primary.kind === 'oversized' || backup.kind === 'oversized'
        ? 'oversized'
        : primary.kind === 'invalid' || backup.kind === 'invalid'
          ? 'invalid'
          : undefined;
    return rejected ? { kind: 'empty', rejected } : { kind: 'empty' };
  }

  public save(snapshot: McpRegistrySnapshot): void {
    const serialized = Buffer.from(`${JSON.stringify(persistedSnapshot(snapshot))}\n`, 'utf8');
    if (serialized.length > this.maxBytes) {
      throw registryError(
        'persist',
        'snapshot-oversized',
        'Registry snapshot exceeds its byte limit.',
      );
    }
    if (parsePersistedSnapshot(serialized).kind !== 'snapshot') {
      throw registryError('persist', 'persist-failed', 'Registry snapshot candidate is invalid.');
    }
    const primary = this.readCandidate(this.storagePath, 'primary');
    const backup = this.readCandidate(this.backupPath, 'backup');
    this.assertWritableCandidate(primary);
    this.assertWritableCandidate(backup);
    try {
      mkdirSync(this.directory, { recursive: true });
      if (primary.kind === 'snapshot' && primary.bytes) {
        this.writeDurable(this.backupPath, primary.bytes);
        const verifiedBackup = this.readCandidate(this.backupPath, 'backup');
        if (verifiedBackup.kind !== 'snapshot' || !verifiedBackup.bytes?.equals(primary.bytes)) {
          throw registryError(
            'persist',
            'persist-failed',
            'Registry snapshot backup verification failed.',
          );
        }
      }
      this.writeDurable(this.storagePath, serialized);
    } catch (error) {
      if (error instanceof McpRegistryError) throw error;
      throw registryError(
        'persist',
        'persist-failed',
        'Registry snapshot persistence failed.',
        error,
      );
    }
  }

  private assertWritableCandidate(candidate: SnapshotCandidate): void {
    if (candidate.kind === 'unsupported') {
      throw registryError(
        'snapshot',
        'snapshot-version-unsupported',
        `Registry snapshot version ${candidate.version} is unsupported.`,
      );
    }
    if (candidate.kind === 'oversized') {
      throw registryError(
        'snapshot',
        'snapshot-oversized',
        'An oversized Registry snapshot cannot be safely overwritten.',
      );
    }
  }

  private readCandidate(candidatePath: string, source: 'backup' | 'primary'): SnapshotCandidate {
    let handle: number | undefined;
    try {
      handle = openSync(candidatePath, 'r');
      const stats = fstatSync(handle);
      if (!stats.isFile()) return { kind: 'invalid', source };
      if (stats.size > this.maxBytes) return { kind: 'oversized', source };
      this.afterReadStat?.(candidatePath);
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < this.maxBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes - offset));
        const count = readSync(handle, chunk, 0, chunk.length, offset);
        if (count === 0) break;
        chunks.push(chunk.subarray(0, count));
        offset += count;
      }
      if (offset === this.maxBytes) {
        const extra = Buffer.allocUnsafe(1);
        if (readSync(handle, extra, 0, 1, offset) > 0) return { kind: 'oversized', source };
      }
      const bytes = Buffer.concat(chunks, offset);
      const parsed = parsePersistedSnapshot(bytes);
      return parsed.kind === 'snapshot'
        ? {
            bytes,
            kind: 'snapshot',
            ...(parsed.requiresFullSync ? { requiresFullSync: true as const } : {}),
            snapshot: parsed.snapshot,
            source,
          }
        : { ...parsed, source };
    } catch (error) {
      return isRegistryRecord(error) && error.code === 'ENOENT'
        ? { kind: 'missing', source }
        : { kind: 'invalid', source };
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }

  private writeDurable(targetPath: string, bytes: Buffer): void {
    const temporaryPath = `${targetPath}.${process.pid}.${this.temporaryId()}.tmp`;
    let created = false;
    try {
      writeFileSync(temporaryPath, bytes, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      created = true;
      const handle = openSync(temporaryPath, 'r+');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporaryPath, targetPath);
      try {
        this.fsyncDirectory(path.dirname(targetPath));
      } catch {
        // The same-volume rename is the logical commit boundary. Once it succeeds, reporting a
        // failed save would let memory retain the predecessor while restart loads this candidate.
        // The separately flushed backup remains the last-known-good durability fallback.
      }
    } finally {
      if (created) rmSync(temporaryPath, { force: true });
    }
  }
}
