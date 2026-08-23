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
  /** Immutable metadata restored if Electron create/bind fails after mutating the live task. */
  startupJournalEntry?: DownloadJournalEntry;
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

export type RecoverySnapshotPromotion = 'blocked' | 'none' | 'ready';

export const promoteRecoverySnapshot = (
  userDataPath: string,
  entry: DownloadJournalEntry,
): RecoverySnapshotPromotion => {
  if (
    !isPathWithinUserData(userDataPath, entry.finalPath) ||
    !isSafePartialPath(userDataPath, entry.savePath)
  ) {
    return 'none';
  }
  const snapshotPath = `${entry.savePath}${RESUME_SNAPSHOT_SUFFIX}`;
  if (!existsSync(snapshotPath)) return 'none';
  try {
    if (existsSync(entry.savePath) && statSync(entry.savePath).size >= entry.receivedBytes) {
      unlinkSync(snapshotPath);
      return 'ready';
    }
    if (statSync(snapshotPath).size < entry.receivedBytes) return 'none';
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
): number | undefined => {
  const savePath = `${request.finalPath}.partial`;
  const snapshotPath = `${savePath}${RESUME_SNAPSHOT_SUFFIX}`;
  const temporaryPath = `${snapshotPath}.tmp`;
  let existingSnapshotBytes: number | undefined;
  try {
    existingSnapshotBytes = statSync(snapshotPath).size;
    if (preserveExisting) return existingSnapshotBytes;
  } catch {
    // Most first attempts do not have a prior snapshot.
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
    return statSync(snapshotPath).size;
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original error; stale temporary bytes are never considered recoverable.
    }
    if (existingSnapshotBytes !== undefined) return existingSnapshotBytes;
    if (strict && existsSync(savePath)) throw error;
    return undefined;
  }
};
