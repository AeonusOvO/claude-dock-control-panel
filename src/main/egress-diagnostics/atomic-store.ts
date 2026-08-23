import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const WINDOWS_RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80] as const;
const RETRYABLE_WINDOWS_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const synchronousSleepBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface EgressAtomicFileOperations {
  readonly closeFile: (handle: number) => void;
  readonly createTemporaryId: () => string;
  readonly flushFile: (handle: number) => void;
  readonly openExclusiveFile: (filePath: string, mode: number) => number;
  readonly renameFile: (source: string, destination: string) => void;
  readonly sleep: (delayMs: number) => void;
  readonly unlinkFile: (filePath: string) => void;
  readonly writeFile: (handle: number, contents: string) => void;
}

const defaultOperations: EgressAtomicFileOperations = {
  closeFile: closeSync,
  createTemporaryId: randomUUID,
  flushFile: fsyncSync,
  openExclusiveFile: (filePath, mode) => openSync(filePath, 'wx', mode),
  renameFile: renameSync,
  sleep: (delayMs) => {
    Atomics.wait(synchronousSleepBuffer, 0, 0, delayMs);
  },
  unlinkFile: unlinkSync,
  writeFile: (handle, contents) => writeFileSync(handle, contents, { encoding: 'utf8' }),
};

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

export const isMissingFileError = (error: unknown): boolean => errorCode(error) === 'ENOENT';

/** Reads at most `maximumBytes + 1` and rejects malformed UTF-8 without creating anything. */
export const readEgressBoundedUtf8File = (
  filePath: string,
  maximumBytes: number,
): string | undefined => {
  let handle: number;
  try {
    handle = openSync(filePath, 'r');
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let total = 0;
  try {
    while (total < buffer.length) {
      const bytesRead = readSync(handle, buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
  } finally {
    closeSync(handle);
  }
  if (total > maximumBytes) throw new Error('bounded file is too large');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
};

/** Unique same-directory exclusive write, file fsync, then bounded-retry atomic replacement. */
export const replaceEgressFileAtomically = (
  destination: string,
  contents: string,
  operationOverrides: Partial<EgressAtomicFileOperations> = {},
): void => {
  const operations = { ...defaultOperations, ...operationOverrides };
  const temporaryPath = `${destination}.tmp-${process.pid}-${operations.createTemporaryId()}`;
  let handle: number | undefined;
  let ownsTemporary = false;
  try {
    try {
      handle = operations.openExclusiveFile(temporaryPath, 0o600);
      ownsTemporary = true;
      operations.writeFile(handle, contents);
      operations.flushFile(handle);
    } catch (error) {
      if (handle !== undefined) {
        try {
          operations.closeFile(handle);
        } catch {
          // The original create, write, or flush failure remains authoritative.
        }
        handle = undefined;
      }
      if (ownsTemporary) {
        try {
          operations.unlinkFile(temporaryPath);
          ownsTemporary = false;
        } catch {
          // Cleanup is best effort and targets only the UUID path this call created.
        }
      }
      throw error;
    }

    operations.closeFile(handle);
    handle = undefined;
    for (let retryIndex = 0; ; retryIndex += 1) {
      try {
        operations.renameFile(temporaryPath, destination);
        ownsTemporary = false;
        return;
      } catch (error) {
        const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
        if (
          retryDelay === undefined ||
          !RETRYABLE_WINDOWS_RENAME_ERRORS.has(errorCode(error) ?? '')
        ) {
          throw error;
        }
        operations.sleep(retryDelay);
      }
    }
  } finally {
    if (handle !== undefined) {
      try {
        operations.closeFile(handle);
      } catch {
        // Cleanup must not replace the durable operation result.
      }
    }
    if (ownsTemporary) {
      try {
        operations.unlinkFile(temporaryPath);
      } catch {
        // Cleanup must never touch the destination or another writer's exclusive path.
      }
    }
  }
};
