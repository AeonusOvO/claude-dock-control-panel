import type { DownloadItem, Event } from 'electron';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import type { DownloadTaskView } from '../../shared/contracts';
import type { DownloadJournalEntry } from './journal';
import type { DownloadRequest, DownloadResult } from './request';
import { isPathWithinUserData, isSafePartialPath } from './safety';

export interface DownloadItemListeners {
  done: (event: Event, state: 'cancelled' | 'completed' | 'interrupted') => void;
  item: DownloadItem;
  updated: (event: Event, state: 'interrupted' | 'progressing') => void;
}

export interface ActiveDownload {
  /** How many automatic continuations this task has already spent. */
  autoResumeAttempts: number;
  /** Generation that owns pendingAutoResume and its timer, if any. */
  autoResumeGeneration?: number;
  autoResumeTimer?: ReturnType<typeof setTimeout>;
  item?: DownloadItem;
  itemGeneration: number;
  itemListeners?: DownloadItemListeners;
  journalEntry?: DownloadJournalEntry;
  lastJournalAt: number;
  lastSampleAt: number;
  lastSampleBytes: number;
  /** Set while an automatic continuation is in flight, so stalls are not counted twice. */
  pendingAutoResume: boolean;
  releaseBusy: () => void;
  reject: (error: Error) => void;
  request: DownloadRequest;
  resolve: (result: DownloadResult) => void;
  restored: boolean;
  /** Durable old prefix kept authoritative while a source restart catches up. */
  recoveryFallback?: DownloadJournalEntry;
  /** Recovery item is retained until its original journal transaction is durable again. */
  recoveryJournalPending?: boolean;
  /** Native recovery item is retained until its sole partial can be snapshotted safely. */
  recoverySnapshotPending?: boolean;
  /** Generation whose automatic createInterruptedDownload call is still unsettled. */
  rebindCreateGeneration?: number;
  /** Immutable journal metadata owned by that automatic restore creation attempt. */
  rebindJournalEntry?: DownloadJournalEntry;
  /** Unbound request generation that delivered the currently bound item. */
  requestGeneration?: number;
  /** Set when the next item bound to this task should start itself instead of waiting for the user. */
  resumeOnBind: boolean;
  settled: boolean;
  stallBytes: number;
  stallTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  /** True until app-start createInterruptedDownload has fulfilled or synchronously returned. */
  startupCreatePending: boolean;
  /** True until an app-start recovery item has fully bound. */
  startupItemBindPending: boolean;
  /** Opaque in-memory token binding renderer recovery decisions to this task instance. */
  recoveryToken?: string;
  /** Prevents a late startup-create rejection from tearing down a recovery prompt after native resume failed. */
  startupResumeFailed: boolean;
  /** Immutable metadata restored if Electron create/bind fails after mutating the live task. */
  startupJournalEntry?: DownloadJournalEntry;
  /** True until the user explicitly chooses to resume or discard an interrupted task. */
  recoveryAwaitingDecision: boolean;
  view: DownloadTaskView;
}

export interface PendingDownloadOwnership {
  generation: number;
  task: ActiveDownload;
}

export const SPEED_SAMPLE_MINIMUM_MS = 500;
export const JOURNAL_WRITE_INTERVAL_MS = 1_000;
/** How long a running download may receive zero bytes before it is treated as stalled. */
export const STALL_TIMEOUT_MS = 45_000;
export const MAX_AUTO_RESUME_ATTEMPTS = 12;
export const AUTO_RESUME_BASE_DELAY_MS = 1_000;
export const AUTO_RESUME_MAX_DELAY_MS = 15_000;
/** Chromium clears a cancelled item's staging file asynchronously; let that land before rebinding. */
export const REBIND_SETTLE_MS = 400;
/** Suffix for the prefix snapshot taken before a cancel, so cancellation cannot erase progress. */
export const RESUME_SNAPSHOT_SUFFIX = '.resume';

export const interruptedDownloadOptions = (
  entry: DownloadJournalEntry,
  offset = entry.receivedBytes,
  savePath = entry.savePath,
) => ({
  eTag: entry.eTag,
  lastModified: entry.lastModified,
  length: entry.length,
  offset,
  path: savePath,
  startTime: entry.startTime,
  urlChain: entry.urlChain,
});

export const removePendingOwnership = (
  task: ActiveDownload,
  pendingRestores: PendingDownloadOwnership[],
  pendingByUrl: Map<string, PendingDownloadOwnership[]>,
  generation?: number,
): boolean => {
  const matches = (ownership: PendingDownloadOwnership): boolean =>
    ownership.task === task && (generation === undefined || ownership.generation === generation);
  let removed = false;
  for (let index = pendingRestores.length - 1; index >= 0; index -= 1) {
    if (matches(pendingRestores[index]!)) {
      pendingRestores.splice(index, 1);
      removed = true;
    }
  }
  for (const [url, pending] of pendingByUrl) {
    const retained = pending.filter((ownership) => !matches(ownership));
    if (retained.length === pending.length) continue;
    removed = true;
    if (retained.length === 0) pendingByUrl.delete(url);
    else pendingByUrl.set(url, retained);
  }
  return removed;
};

export const cloneJournalEntry = (entry: DownloadJournalEntry): DownloadJournalEntry => ({
  ...entry,
  allowedHosts: [...entry.allowedHosts],
  allowedPathPrefixes: [...entry.allowedPathPrefixes],
  urlChain: [...entry.urlChain],
});

export const deleteRecoveryPaths = (savePath: string): void => {
  for (const candidate of [savePath, `${savePath}${RESUME_SNAPSHOT_SUFFIX}`]) {
    try {
      unlinkSync(candidate);
    } catch {
      // Missing and locked stale partials are both safe to leave unexecutable.
    }
  }
};

export const deleteResumeSnapshot = (request: DownloadRequest): void => {
  try {
    unlinkSync(`${request.finalPath}.partial${RESUME_SNAPSHOT_SUFFIX}`);
  } catch {
    // Most downloads never need a recovery snapshot.
  }
};

export const deleteStagingPartial = (request: DownloadRequest): void => {
  try {
    unlinkSync(`${request.finalPath}.partial`);
  } catch {
    // A cancelled item may already have removed its staging file.
  }
};

const recoveryComparisonChunkBytes = 64 * 1024;

const sharesRecoveryPrefix = async (
  leftPath: string,
  rightPath: string,
  bytes: number,
): Promise<boolean> => {
  let leftHandle: Awaited<ReturnType<typeof openAsync>> | undefined;
  let rightHandle: Awaited<ReturnType<typeof openAsync>> | undefined;
  try {
    leftHandle = await openAsync(leftPath, 'r');
    rightHandle = await openAsync(rightPath, 'r');
    const leftBuffer = Buffer.alloc(recoveryComparisonChunkBytes);
    const rightBuffer = Buffer.alloc(recoveryComparisonChunkBytes);
    let offset = 0;
    while (offset < bytes) {
      const length = Math.min(recoveryComparisonChunkBytes, bytes - offset);
      const [leftRead, rightRead] = await Promise.all([
        leftHandle.read(leftBuffer, 0, length, offset),
        rightHandle.read(rightBuffer, 0, length, offset),
      ]);
      if (leftRead.bytesRead !== length || rightRead.bytesRead !== length) return false;
      if (!leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) return false;
      offset += length;
    }
    return true;
  } catch {
    return false;
  } finally {
    await Promise.allSettled([leftHandle?.close(), rightHandle?.close()]);
  }
};

export type RecoverySnapshotPromotion = 'blocked' | 'none' | 'ready';

export const promoteRecoverySnapshot = async (
  userDataPath: string,
  entry: DownloadJournalEntry,
): Promise<RecoverySnapshotPromotion> => {
  if (
    !Number.isSafeInteger(entry.receivedBytes) ||
    entry.receivedBytes < 0 ||
    !isPathWithinUserData(userDataPath, entry.finalPath) ||
    !isSafePartialPath(userDataPath, entry.savePath)
  ) {
    return 'none';
  }
  const snapshotPath = `${entry.savePath}${RESUME_SNAPSHOT_SUFFIX}`;
  if (!existsSync(snapshotPath)) return 'none';
  try {
    const snapshotBytes = statSync(snapshotPath).size;
    if (snapshotBytes < entry.receivedBytes || snapshotBytes > entry.maxBytes) {
      // A snapshot shorter than the journal cannot satisfy the recorded offset. It must not remain
      // available for a later rebind where it could silently roll progress backwards.
      unlinkSync(snapshotPath);
      return 'none';
    }
    // A current partial is usable only when its recorded prefix matches the durable sibling
    // snapshot. Length alone cannot prove that a stale or replaced file belongs to this task.
    const currentBytes = existsSync(entry.savePath) ? statSync(entry.savePath).size : 0;
    if (
      existsSync(entry.savePath) &&
      currentBytes >= entry.receivedBytes &&
      currentBytes >= snapshotBytes &&
      (await sharesRecoveryPrefix(entry.savePath, snapshotPath, entry.receivedBytes))
    ) {
      unlinkSync(snapshotPath);
      return 'ready';
    }
    // The snapshot is the only task-associated recovery artifact. If the live partial is missing,
    // shorter, or has a different prefix, replace it from the verified snapshot rather than using
    // the unverified file or deleting the snapshot.
    if (existsSync(entry.savePath)) unlinkSync(entry.savePath);
    renameSync(snapshotPath, entry.savePath);
    return 'ready';
  } catch {
    // A lock/scanner can temporarily block replacement on Windows. The valid sibling snapshot and
    // its journal must survive for a later startup instead of being classified as corrupt.
    return 'blocked';
  }
};

export const snapshotPartialForRecovery = (
  request: DownloadRequest,
  strict: boolean,
  preserveExisting = false,
  minimumBytes = 0,
): number | undefined => {
  const savePath = `${request.finalPath}.partial`;
  const snapshotPath = `${savePath}${RESUME_SNAPSHOT_SUFFIX}`;
  const temporaryPath = `${snapshotPath}.tmp`;
  let existingSnapshotBytes: number | undefined;
  try {
    existingSnapshotBytes = statSync(snapshotPath).size;
    if (existingSnapshotBytes > request.maxBytes) {
      existingSnapshotBytes = undefined;
      throw new Error('恢复快照超过安全上限。');
    }
    if (preserveExisting && existingSnapshotBytes >= minimumBytes) return existingSnapshotBytes;
    if (existingSnapshotBytes < minimumBytes) {
      // A stale snapshot must not win over a newer live partial or be returned as a lower offset.
      unlinkSync(snapshotPath);
      existingSnapshotBytes = undefined;
    }
  } catch (error) {
    if (strict && error instanceof Error && error.message === '恢复快照超过安全上限。') throw error;
    // Most first attempts do not have a prior snapshot. An undersized sibling is also discarded
    // above; a locked stale sibling remains non-authoritative and will be retried later.
  }
  try {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A prior interrupted snapshot transaction may not have left a temporary file.
    }
    copyFileSync(savePath, temporaryPath);
    const descriptor = openSync(temporaryPath, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, snapshotPath);
    const snapshotBytes = statSync(snapshotPath).size;
    if (snapshotBytes < minimumBytes || snapshotBytes > request.maxBytes) {
      unlinkSync(snapshotPath);
      if (strict) throw new Error('恢复快照不满足安全边界。');
      return undefined;
    }
    return snapshotBytes;
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original error; stale temporary bytes are never considered recoverable.
    }
    if (existingSnapshotBytes !== undefined && existingSnapshotBytes >= minimumBytes) {
      return existingSnapshotBytes;
    }
    if (strict && existsSync(savePath)) throw error;
    return undefined;
  }
};
