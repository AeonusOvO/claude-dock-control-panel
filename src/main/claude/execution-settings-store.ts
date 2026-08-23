import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION,
  type ClaudeExecutionProfileId,
  type ClaudeExecutionSettingsRequest,
  type ClaudeExecutionSettingsSnapshot,
} from '../../shared/contracts/claude-execution-settings';
import {
  CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION,
  getClaudeExecutionProfile,
  isClaudeExecutionRequestedValues,
} from '../../shared/claude/execution-profiles';

export const CLAUDE_EXECUTION_SETTINGS_MAX_BYTES = 32 * 1024;

export class ClaudeExecutionSettingsNewerVersionError extends Error {
  public readonly code = 'CLAUDE_EXECUTION_SETTINGS_NEWER_VERSION' as const;

  public constructor(
    public readonly declaredSchemaVersion: number | undefined,
    public readonly declaredCatalogVersion: number | undefined,
  ) {
    super(
      `执行设置文件由较新版本 ClaudeDock 创建（schema ${declaredSchemaVersion ?? '未知'}，catalog ${declaredCatalogVersion ?? '未知'}）；请升级 ClaudeDock 后再修改，原文件未更改。`,
    );
    this.name = 'ClaudeExecutionSettingsNewerVersionError';
  }
}

export type ClaudeExecutionSettingsWriteBlockReason = 'invalid-json' | 'unreadable' | 'unversioned';

export class ClaudeExecutionSettingsWriteBlockedError extends Error {
  public readonly code = 'CLAUDE_EXECUTION_SETTINGS_WRITE_BLOCKED' as const;

  public constructor(public readonly reason: ClaudeExecutionSettingsWriteBlockReason) {
    super(
      `现有执行设置文件无法安全识别（${reason}）；为避免覆盖较新版本数据，已拒绝写入。请先备份并使用创建该文件的 ClaudeDock 版本处理。`,
    );
    this.name = 'ClaudeExecutionSettingsWriteBlockedError';
  }
}

const WINDOWS_RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80] as const;
const RETRYABLE_WINDOWS_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

export interface AtomicExecutionSettingsOperations {
  closeFile: (fileDescriptor: number) => void;
  createTemporaryId: () => string;
  flushFile: (fileDescriptor: number) => void;
  openFile: (filePath: string, flags: 'wx', mode: number) => number;
  renameFile: (source: string, destination: string) => void;
  sleep: (delayMs: number) => void | Promise<void>;
  unlinkFile: (filePath: string) => void;
  writeFile: (fileDescriptor: number, contents: string) => void;
}

const defaultAtomicOperations: AtomicExecutionSettingsOperations = {
  closeFile: closeSync,
  createTemporaryId: randomUUID,
  flushFile: fsyncSync,
  openFile: openSync,
  renameFile: renameSync,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  unlinkFile: unlinkSync,
  writeFile: (fileDescriptor, contents) => {
    writeFileSync(fileDescriptor, contents, 'utf8');
  },
};

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

/** Atomically replaces one settings file without sharing a predictable temporary path. */
export const replaceExecutionSettingsFileAtomically = async (
  storagePath: string,
  contents: string,
  operationOverrides: Partial<AtomicExecutionSettingsOperations> = {},
): Promise<void> => {
  const operations = { ...defaultAtomicOperations, ...operationOverrides };
  const temporaryPath = `${storagePath}.tmp-${process.pid}-${operations.createTemporaryId()}`;
  let ownedFileDescriptor: number | undefined;
  let ownsTemporaryFile = false;
  try {
    ownedFileDescriptor = operations.openFile(temporaryPath, 'wx', 0o600);
    ownsTemporaryFile = true;
    operations.writeFile(ownedFileDescriptor, contents);
    operations.flushFile(ownedFileDescriptor);
    operations.closeFile(ownedFileDescriptor);
    ownedFileDescriptor = undefined;

    for (let retryIndex = 0; ; retryIndex += 1) {
      try {
        operations.renameFile(temporaryPath, storagePath);
        ownsTemporaryFile = false;
        return;
      } catch (error) {
        const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
        if (
          !RETRYABLE_WINDOWS_RENAME_ERRORS.has(errorCode(error) ?? '') ||
          retryDelay === undefined
        ) {
          throw error;
        }
        await operations.sleep(retryDelay);
      }
    }
  } finally {
    if (ownedFileDescriptor !== undefined) {
      try {
        operations.closeFile(ownedFileDescriptor);
      } catch {
        // Preserve the write/flush/close error; descriptor cleanup is best effort.
      }
    }
    if (ownsTemporaryFile) {
      try {
        operations.unlinkFile(temporaryPath);
      } catch {
        // The destination and original failure remain authoritative.
      }
    }
  }
};

const DEFAULT_SETTINGS: ClaudeExecutionSettingsSnapshot = Object.freeze({
  catalogVersion: CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION,
  requested: Object.freeze({ mode: 'claude-default' as const }),
  version: CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION,
});

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
};

const parseRequest = (value: unknown): ClaudeExecutionSettingsRequest | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.mode === 'claude-default' && exactKeys(record, ['mode'])) {
    return { mode: 'claude-default' };
  }
  if (
    record.mode === 'profile' &&
    exactKeys(record, ['mode', 'profileId']) &&
    typeof record.profileId === 'string' &&
    getClaudeExecutionProfile(record.profileId as ClaudeExecutionProfileId)
  ) {
    return { mode: 'profile', profileId: record.profileId as ClaudeExecutionProfileId };
  }
  if (
    record.mode === 'custom' &&
    exactKeys(record, ['mode', 'values']) &&
    isClaudeExecutionRequestedValues(record.values)
  ) {
    return { mode: 'custom', values: { ...record.values } };
  }
  return undefined;
};

const parseSnapshot = (value: unknown): ClaudeExecutionSettingsSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ['catalogVersion', 'requested', 'version']) ||
    record.version !== CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION ||
    record.catalogVersion !== CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION
  ) {
    return undefined;
  }
  const requested = parseRequest(record.requested);
  return requested
    ? {
        catalogVersion: CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION,
        requested,
        version: CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION,
      }
    : undefined;
};

interface DeclaredExecutionSettingsVersions {
  catalogVersion?: number;
  schemaVersion?: number;
}

const parseDeclaredVersion = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const parseDeclaredSnapshotVersions = (
  value: unknown,
): DeclaredExecutionSettingsVersions | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const catalogVersion = parseDeclaredVersion(record.catalogVersion);
  const schemaVersion = parseDeclaredVersion(record.version);
  return catalogVersion === undefined && schemaVersion === undefined
    ? undefined
    : { catalogVersion, schemaVersion };
};

const cloneSnapshot = (
  snapshot: ClaudeExecutionSettingsSnapshot,
): ClaudeExecutionSettingsSnapshot => structuredClone(snapshot);

const readBoundedUtf8File = (filePath: string): string => {
  const handle = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(CLAUDE_EXECUTION_SETTINGS_MAX_BYTES + 1);
  let total = 0;
  try {
    while (total < buffer.length) {
      const bytesRead = readSync(handle, buffer, total, buffer.length - total, total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
  } finally {
    closeSync(handle);
  }
  if (total > CLAUDE_EXECUTION_SETTINGS_MAX_BYTES) {
    throw new Error('Claude 执行设置文件超过大小上限。');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
};

const assertNoNewerStoredSnapshot = (storagePath: string): void => {
  let contents: string;
  try {
    contents = readBoundedUtf8File(storagePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw new ClaudeExecutionSettingsWriteBlockedError('unreadable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ClaudeExecutionSettingsWriteBlockedError('invalid-json');
  }

  const declared = parseDeclaredSnapshotVersions(parsed);
  const hasNewerSchema =
    declared?.schemaVersion !== undefined &&
    declared.schemaVersion > CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION;
  const hasNewerCatalog =
    declared?.catalogVersion !== undefined &&
    declared.catalogVersion > CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION;
  if (declared && (hasNewerSchema || hasNewerCatalog)) {
    throw new ClaudeExecutionSettingsNewerVersionError(
      declared.schemaVersion,
      declared.catalogVersion,
    );
  }
  if (declared?.schemaVersion === undefined || declared.catalogVersion === undefined) {
    throw new ClaudeExecutionSettingsWriteBlockedError('unversioned');
  }
};

/** Independent, global execution policy stored under the Electron userData directory. */
export class ClaudeExecutionSettingsStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'execution-settings.json');
  }

  public get(): ClaudeExecutionSettingsSnapshot {
    try {
      const parsed = parseSnapshot(JSON.parse(readBoundedUtf8File(this.storagePath)));
      return cloneSnapshot(parsed ?? DEFAULT_SETTINGS);
    } catch {
      return cloneSnapshot(DEFAULT_SETTINGS);
    }
  }

  public async set(
    requested: ClaudeExecutionSettingsRequest,
  ): Promise<ClaudeExecutionSettingsSnapshot> {
    const parsedRequest = parseRequest(requested);
    if (!parsedRequest) {
      throw new Error('Claude 执行设置请求无效。');
    }
    assertNoNewerStoredSnapshot(this.storagePath);
    const snapshot: ClaudeExecutionSettingsSnapshot = {
      catalogVersion: CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION,
      requested: parsedRequest,
      version: CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION,
    };
    await this.persist(snapshot);
    return cloneSnapshot(snapshot);
  }

  public reset(): Promise<ClaudeExecutionSettingsSnapshot> {
    return this.set({ mode: 'claude-default' });
  }

  private async persist(snapshot: ClaudeExecutionSettingsSnapshot): Promise<void> {
    mkdirSync(this.storageDirectory, { recursive: true });
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > CLAUDE_EXECUTION_SETTINGS_MAX_BYTES) {
      throw new Error('Claude 执行设置文件超过大小上限。');
    }
    await replaceExecutionSettingsFileAtomically(this.storagePath, serialized);
  }
}
