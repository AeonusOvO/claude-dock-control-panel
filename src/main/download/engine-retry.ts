import type { DownloadItem, Event } from 'electron';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import type { DownloadJournal, DownloadJournalEntry } from './journal';
import {
  calculateDownloadProgress,
  exponentialMovingAverage,
  mapDownloadItemState,
} from './metrics';
import type { DownloadSession } from './request';
import {
  type ActiveDownload,
  AUTO_RESUME_BASE_DELAY_MS,
  AUTO_RESUME_MAX_DELAY_MS,
  cloneJournalEntry,
  deleteRecoveryPaths,
  deleteStagingPartial,
  interruptedDownloadOptions,
  MAX_AUTO_RESUME_ATTEMPTS,
  type PendingDownloadOwnership,
  REBIND_SETTLE_MS,
  removePendingOwnership,
  RESUME_SNAPSHOT_SUFFIX,
  snapshotPartialForRecovery,
  SPEED_SAMPLE_MINIMUM_MS,
  STALL_TIMEOUT_MS,
} from './engine-state';

export interface DownloadRetryControllerHost {
  complete: (task: ActiveDownload, item: DownloadItem, generation: number) => Promise<void>;
  electronSession: DownloadSession;
  fail: (task: ActiveDownload, error: Error, preserveJournal?: boolean) => void;
  journal: Pick<DownloadJournal, 'upsert'>;
  notify: () => void;
  hasActiveDownloadUrl: (url: string, excludedTask?: ActiveDownload) => boolean;
  ownsItemGeneration: (
    task: ActiveDownload,
    item: DownloadItem | undefined,
    generation: number,
  ) => boolean;
  pendingByUrl: Map<string, PendingDownloadOwnership[]>;
  pendingRestores: PendingDownloadOwnership[];
  persistTask: (task: ActiveDownload, force?: boolean, recoveryBytes?: number) => void;
  rollbackStartupRestore: (task: ActiveDownload, error: Error) => void;
  settleCancelled: (task: ActiveDownload) => void;
}

export class DownloadRetryController {
  public constructor(private readonly host: DownloadRetryControllerHost) {}

  public armStallTimer(
    task: ActiveDownload,
    item = task.item,
    generation = task.itemGeneration,
  ): void {
    if (
      task.settled ||
      task.view.state === 'verifying' ||
      task.pendingAutoResume ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      return;
    }
    this.clearStallTimer(task);
    const timer = setTimeout(() => {
      if (task.stallTimer !== timer) return;
      task.stallTimer = undefined;
      if (!this.host.ownsItemGeneration(task, item, generation)) return;
      this.scheduleAutoResume(
        task,
        `${Math.round(STALL_TIMEOUT_MS / 1000)} 秒内没有收到任何数据`,
        item,
        generation,
      );
    }, STALL_TIMEOUT_MS);
    task.stallTimer = timer;
    timer.unref?.();
  }

  public armStartupBindTimer(task: ActiveDownload, generation: number): void {
    if (
      !task.startupItemBindPending ||
      !this.host.ownsItemGeneration(task, undefined, generation)
    ) {
      return;
    }
    this.clearStallTimer(task);
    const timer = setTimeout(() => {
      if (task.stallTimer !== timer) return;
      task.stallTimer = undefined;
      if (
        task.startupItemBindPending &&
        this.host.ownsItemGeneration(task, undefined, generation)
      ) {
        this.host.rollbackStartupRestore(task, new Error('恢复下载未交付可接管的项目。'));
      }
    }, STALL_TIMEOUT_MS);
    task.stallTimer = timer;
    timer.unref?.();
  }

  public scheduleAutoResume(
    task: ActiveDownload,
    reason: string,
    item = task.item,
    generation = task.itemGeneration,
  ): void {
    if (
      task.settled ||
      task.recoveryAwaitingDecision ||
      task.pendingAutoResume ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      return;
    }
    this.clearStallTimer(task);
    if (task.autoResumeAttempts >= MAX_AUTO_RESUME_ATTEMPTS) {
      try {
        snapshotPartialForRecovery(task.request, true, Boolean(task.recoveryFallback));
      } catch {
        this.deferExhaustionSnapshot(task, reason, item, generation);
        return;
      }
      removePendingOwnership(task, this.host.pendingRestores, this.host.pendingByUrl);
      this.detachItemListeners(task);
      task.item = undefined;
      task.requestGeneration = undefined;
      task.itemGeneration += 1;
      try {
        item?.cancel();
      } catch {
        // The exhausted task is terminal even if Electron already destroyed its native item.
      }
      this.host.fail(
        task,
        new Error(
          `${reason}；已自动续传 ${MAX_AUTO_RESUME_ATTEMPTS} 次仍未完成，请检查网络或代理设置后重试。`,
        ),
        true,
      );
      return;
    }
    task.autoResumeAttempts += 1;
    task.pendingAutoResume = true;
    task.autoResumeGeneration = generation;
    const delay = Math.min(
      AUTO_RESUME_MAX_DELAY_MS,
      AUTO_RESUME_BASE_DELAY_MS * 2 ** (task.autoResumeAttempts - 1),
    );
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      errorMessage: `${reason}，正在自动续传（第 ${task.autoResumeAttempts}/${MAX_AUTO_RESUME_ATTEMPTS} 次）…`,
      state: 'paused',
    };
    this.host.notify();
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (task.autoResumeTimer !== timer) return;
      task.autoResumeTimer = undefined;
      if (task.autoResumeGeneration !== generation) return;
      if (!this.host.ownsItemGeneration(task, item, generation)) {
        task.pendingAutoResume = false;
        task.autoResumeGeneration = undefined;
        return;
      }
      this.runAutoResume(task, item, generation);
    }, delay);
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      clearTimeout(timer);
      return;
    }
    task.autoResumeTimer = timer;
    timer.unref?.();
  }

  public runAutoResume(
    task: ActiveDownload,
    item = task.item,
    generation = task.itemGeneration,
  ): void {
    if (
      task.recoveryAwaitingDecision ||
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      return;
    }
    try {
      if (item && item.getState() === 'interrupted' && item.canResume()) {
        task.pendingAutoResume = false;
        task.autoResumeGeneration = undefined;
        item.resume();
        if (!this.host.ownsItemGeneration(task, item, generation)) return;
        task.view = {
          ...task.view,
          canPause: true,
          canResume: false,
          errorMessage: undefined,
          state: 'progressing',
        };
        this.armStallTimer(task, item, generation);
        this.host.notify();
        return;
      }
    } catch {
      if (!this.host.ownsItemGeneration(task, item, generation)) return;
      task.pendingAutoResume = true;
      task.autoResumeGeneration = generation;
      this.rebindFromDisk(task, item, generation);
      return;
    }
    this.rebindFromDisk(task, item, generation);
  }

  public clearAutoResumeTimer(task: ActiveDownload): void {
    if (task.autoResumeTimer) {
      clearTimeout(task.autoResumeTimer);
      task.autoResumeTimer = undefined;
    }
    task.pendingAutoResume = false;
    task.autoResumeGeneration = undefined;
  }

  public clearStallTimer(task: ActiveDownload): void {
    if (task.stallTimer) {
      clearTimeout(task.stallTimer);
      task.stallTimer = undefined;
    }
  }

  public attachItemListeners(task: ActiveDownload, item: DownloadItem, generation: number): void {
    this.detachItemListeners(task);
    const updated = (_event: Event, state: 'interrupted' | 'progressing'): void => {
      if (!this.host.ownsItemGeneration(task, item, generation)) return;
      try {
        this.updateFromItem(task, item, generation, state);
      } catch {
        this.scheduleAutoResume(task, '无法读取下载状态', item, generation);
      }
    };
    const done = (_event: Event, state: 'cancelled' | 'completed' | 'interrupted'): void => {
      if (!this.host.ownsItemGeneration(task, item, generation)) return;
      try {
        if (state === 'completed') {
          void this.host.complete(task, item, generation);
        } else if (state === 'cancelled') {
          this.host.settleCancelled(task);
        } else if (item.canResume()) {
          this.updateFromItem(task, item, generation, 'interrupted');
          this.scheduleAutoResume(task, '连接已中断', item, generation);
        } else {
          this.scheduleAutoResume(task, '连接已中断且无法就地续传', item, generation);
        }
      } catch {
        this.scheduleAutoResume(task, '无法读取下载状态', item, generation);
      }
    };
    task.itemListeners = { done, item, updated };
    item.on('updated', updated);
    item.on('done', done);
  }

  public detachItemListeners(task: ActiveDownload): void {
    const listeners = task.itemListeners;
    if (!listeners) return;
    task.itemListeners = undefined;
    try {
      listeners.item.removeListener('updated', listeners.updated);
      listeners.item.removeListener('done', listeners.done);
    } catch {
      // Native listener teardown is best-effort during Electron shutdown.
    }
  }

  public updateFromItem(
    task: ActiveDownload,
    item: DownloadItem,
    generation: number,
    state: 'interrupted' | 'progressing',
  ): void {
    if (!this.host.ownsItemGeneration(task, item, generation)) return;
    const now = Date.now();
    const receivedBytes = Math.max(0, item.getReceivedBytes());
    const totalBytes = Math.max(0, item.getTotalBytes());
    if (receivedBytes > task.request.maxBytes || totalBytes > task.request.maxBytes) {
      this.detachItemListeners(task);
      task.item = undefined;
      task.requestGeneration = undefined;
      task.itemGeneration += 1;
      try {
        item.cancel();
      } catch {
        // The size-policy failure remains terminal even if Electron already stopped the item.
      }
      deleteRecoveryPaths(`${task.request.finalPath}.partial`);
      this.host.fail(task, new Error('下载内容超过安全上限，文件已删除。'));
      return;
    }
    if (task.restored && receivedBytes < task.lastSampleBytes) {
      task.restored = false;
      task.recoveryAwaitingDecision = false;
      task.resumeOnBind = false;
      task.recoveryFallback = undefined;
      this.clearAutoResumeTimer(task);
      task.view = {
        ...task.view,
        errorMessage: '服务端文件已更新，已重新开始下载。',
        recoveryPending: false,
      };
    }
    if (now - task.lastSampleAt >= SPEED_SAMPLE_MINIMUM_MS) {
      task.view.bytesPerSecond = exponentialMovingAverage(
        task.view.bytesPerSecond,
        receivedBytes - task.lastSampleBytes,
        now - task.lastSampleAt,
      );
      task.lastSampleAt = now;
      task.lastSampleBytes = receivedBytes;
    }
    const progress = calculateDownloadProgress(receivedBytes, totalBytes, task.view.bytesPerSecond);
    const mappedState = mapDownloadItemState(state, item.isPaused(), item.canResume());
    if (receivedBytes < task.stallBytes) {
      // A server-side reset establishes a new liveness baseline. Growth from 0 toward the old offset
      // must cancel a stale retry instead of being misclassified as zero progress.
      task.stallBytes = receivedBytes;
    }
    const receivedIncreased = receivedBytes > task.stallBytes;
    const receivedChanged = receivedBytes !== task.stallBytes;

    if (mappedState === 'progressing' && task.pendingAutoResume && !receivedIncreased) {
      task.view = {
        ...task.view,
        ...progress,
        elapsedMs: now - task.startedAt,
        receivedBytes,
        totalBytes,
      };
      this.host.persistTask(task);
      this.host.notify();
      return;
    }

    const cancelledStaleResume =
      mappedState === 'progressing' && task.pendingAutoResume && receivedIncreased;
    if (cancelledStaleResume) {
      task.autoResumeAttempts = Math.max(0, task.autoResumeAttempts - 1);
      this.clearAutoResumeTimer(task);
    }
    if (receivedChanged) task.stallBytes = receivedBytes;
    task.view = {
      ...task.view,
      ...progress,
      canPause: mappedState === 'progressing',
      canResume: mappedState === 'paused' && item.canResume(),
      elapsedMs: now - task.startedAt,
      errorMessage: cancelledStaleResume ? undefined : task.view.errorMessage,
      receivedBytes,
      state: mappedState,
      totalBytes,
    };
    if (mappedState === 'failed') {
      this.scheduleAutoResume(task, '连接已中断', item, generation);
      return;
    }
    if (mappedState === 'progressing') {
      if (receivedChanged || !task.stallTimer) this.armStallTimer(task, item, generation);
    } else {
      this.clearStallTimer(task);
    }
    this.host.persistTask(task);
    this.host.notify();
  }

  public queuePendingRestore(task: ActiveDownload, generation: number): void {
    removePendingOwnership(task, this.host.pendingRestores, this.host.pendingByUrl);
    this.host.pendingRestores.push({ generation, task });
  }

  public queuePendingUrl(task: ActiveDownload, url: string, generation: number): boolean {
    removePendingOwnership(task, this.host.pendingRestores, this.host.pendingByUrl);
    const pending = this.host.pendingByUrl.get(url);
    if (
      pending?.some(({ task: candidate, generation: candidateGeneration }) =>
        this.host.ownsItemGeneration(candidate, undefined, candidateGeneration),
      )
    ) {
      return false;
    }
    this.host.pendingByUrl.set(url, [{ generation, task }]);
    return true;
  }

  public holdStartupJournalRollback(task: ActiveDownload, error: Error): void {
    const item = task.item;
    const generation = task.itemGeneration;
    if (!this.host.ownsItemGeneration(task, item, generation)) return;
    this.holdRecoveryJournalTransaction(task, item, generation, () => {
      task.recoveryJournalPending = false;
      this.host.rollbackStartupRestore(task, error);
    });
  }

  public holdItemForRecoverySnapshot(
    task: ActiveDownload,
    item: DownloadItem,
    requestGeneration: number,
    recoveryEntry: DownloadJournalEntry,
    error: Error,
    startup: boolean,
  ): void {
    if (!this.host.ownsItemGeneration(task, undefined, requestGeneration)) return;
    this.clearStallTimer(task);
    this.clearAutoResumeTimer(task);
    task.item = item;
    task.requestGeneration = requestGeneration;
    task.itemGeneration += 1;
    const boundGeneration = task.itemGeneration;
    task.recoverySnapshotPending = true;
    task.pendingAutoResume = true;
    task.autoResumeGeneration = boundGeneration;
    try {
      item.pause();
    } catch {
      // Keep exact ownership even if the native item cannot be paused during filesystem recovery.
    }
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      errorMessage: '无法保存恢复快照，稍后重试…',
      state: 'paused',
    };
    this.host.notify();
    if (!this.host.ownsItemGeneration(task, item, boundGeneration)) return;
    this.deferHeldRecoverySnapshot(
      task,
      item,
      boundGeneration,
      requestGeneration,
      recoveryEntry,
      error,
      startup,
    );
  }

  public rollbackRebindItem(
    task: ActiveDownload,
    item: DownloadItem,
    requestGeneration: number,
    recoveryEntry: DownloadJournalEntry,
  ): void {
    const ownsUnbound = this.host.ownsItemGeneration(task, undefined, requestGeneration);
    const ownsBound =
      task.requestGeneration === requestGeneration &&
      this.host.ownsItemGeneration(task, item, task.itemGeneration);
    if (!ownsUnbound && !ownsBound) return;
    this.clearStallTimer(task);
    this.clearAutoResumeTimer(task);
    if (task.rebindCreateGeneration === requestGeneration) {
      task.rebindCreateGeneration = undefined;
      task.rebindJournalEntry = undefined;
    }
    task.recoveryFallback = cloneJournalEntry(recoveryEntry);
    try {
      this.host.journal.upsert(recoveryEntry);
    } catch {
      this.holdRebindJournalRollback(task, item, requestGeneration, recoveryEntry);
      return;
    }
    task.journalEntry = cloneJournalEntry(recoveryEntry);
    this.finishRebindItemRollback(task, item, requestGeneration);
  }

  private finishRebindItemRollback(
    task: ActiveDownload,
    item: DownloadItem,
    requestGeneration: number,
  ): void {
    const ownsUnbound = this.host.ownsItemGeneration(task, undefined, requestGeneration);
    const ownsBound =
      task.requestGeneration === requestGeneration &&
      this.host.ownsItemGeneration(task, item, task.itemGeneration);
    if (!ownsUnbound && !ownsBound) return;
    try {
      snapshotPartialForRecovery(task.request, true, true);
    } catch {
      if (ownsUnbound) {
        try {
          item.cancel();
        } catch {
          // setSavePath never ran, so cancellation cannot touch the original recovery partial.
        }
        task.pendingAutoResume = true;
        task.autoResumeGeneration = requestGeneration;
        this.deferRebindSnapshot(task, undefined, requestGeneration);
      } else {
        const boundGeneration = task.itemGeneration;
        task.pendingAutoResume = true;
        task.autoResumeGeneration = boundGeneration;
        this.deferRebindSnapshot(task, item, boundGeneration);
      }
      return;
    }
    this.detachItemListeners(task);
    task.item = undefined;
    task.requestGeneration = undefined;
    task.itemGeneration += 1;
    const unboundGeneration = task.itemGeneration;
    try {
      item.cancel();
    } catch {
      // A delayed source restart still fences this failed native item by generation.
    }
    this.deferSourceRestart(task, unboundGeneration);
  }

  private holdRebindJournalRollback(
    task: ActiveDownload,
    item: DownloadItem,
    requestGeneration: number,
    recoveryEntry: DownloadJournalEntry,
  ): void {
    const ownsUnbound = this.host.ownsItemGeneration(task, undefined, requestGeneration);
    const generation = ownsUnbound ? requestGeneration : task.itemGeneration;
    const ownedItem = ownsUnbound ? undefined : item;
    if (!this.host.ownsItemGeneration(task, ownedItem, generation)) return;
    this.holdRecoveryJournalTransaction(task, ownedItem, generation, () => {
      try {
        this.host.journal.upsert(recoveryEntry);
      } catch {
        this.holdRebindJournalRollback(task, item, requestGeneration, recoveryEntry);
        return;
      }
      task.recoveryJournalPending = false;
      task.journalEntry = cloneJournalEntry(recoveryEntry);
      this.finishRebindItemRollback(task, item, requestGeneration);
    });
  }

  private holdRecoveryJournalTransaction(
    task: ActiveDownload,
    item: DownloadItem | undefined,
    generation: number,
    retry: () => void,
  ): void {
    if (!this.host.ownsItemGeneration(task, item, generation)) return;
    this.clearStallTimer(task);
    this.clearAutoResumeTimer(task);
    this.detachItemListeners(task);
    task.recoveryJournalPending = true;
    task.pendingAutoResume = true;
    task.autoResumeGeneration = generation;
    try {
      item?.pause();
    } catch {
      // Exact ownership remains fenced while the durable journal rollback is retried.
    }
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      errorMessage: '无法恢复续传日志，稍后重试…',
      state: 'paused',
    };
    this.host.notify();
    if (!this.host.ownsItemGeneration(task, item, generation)) return;
    const timer = setTimeout(() => {
      if (task.autoResumeTimer !== timer) return;
      task.autoResumeTimer = undefined;
      if (!task.recoveryJournalPending || !this.host.ownsItemGeneration(task, item, generation)) {
        return;
      }
      task.pendingAutoResume = false;
      task.autoResumeGeneration = undefined;
      retry();
    }, AUTO_RESUME_BASE_DELAY_MS);
    if (!task.recoveryJournalPending || !this.host.ownsItemGeneration(task, item, generation)) {
      clearTimeout(timer);
      return;
    }
    task.autoResumeTimer = timer;
    timer.unref?.();
  }

  private rebindFromDisk(
    task: ActiveDownload,
    item: DownloadItem | undefined,
    generation: number,
  ): void {
    if (task.recoveryAwaitingDecision || !this.host.ownsItemGeneration(task, item, generation)) {
      return;
    }
    const savePath = `${task.request.finalPath}.partial`;
    const snapshotPath = `${savePath}${RESUME_SNAPSHOT_SUFFIX}`;
    let offset: number;
    try {
      offset = snapshotPartialForRecovery(task.request, true, Boolean(task.recoveryFallback)) ?? 0;
    } catch {
      this.deferRebindSnapshot(task, item, generation);
      return;
    }
    removePendingOwnership(task, this.host.pendingRestores, this.host.pendingByUrl);
    this.detachItemListeners(task);
    task.item = undefined;
    task.requestGeneration = undefined;
    task.itemGeneration += 1;
    const unboundGeneration = task.itemGeneration;
    task.autoResumeGeneration = unboundGeneration;
    if (item) {
      let shouldCancel = true;
      try {
        const state = item.getState();
        shouldCancel = state !== 'completed' && state !== 'cancelled';
      } catch {
        // Unknown native state is treated as live before admitting same-path replacement I/O.
      }
      if (shouldCancel) {
        try {
          item.cancel();
        } catch {
          // The replacement still owns the stable snapshot if the old native item disappeared.
        }
      }
    }
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== unboundGeneration ||
      !this.host.ownsItemGeneration(task, undefined, unboundGeneration)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (task.autoResumeTimer !== timer) return;
      task.autoResumeTimer = undefined;
      if (task.autoResumeGeneration !== unboundGeneration) return;
      if (
        !task.pendingAutoResume ||
        !this.host.ownsItemGeneration(task, undefined, unboundGeneration)
      ) {
        task.pendingAutoResume = false;
        task.autoResumeGeneration = undefined;
        return;
      }
      this.relaunchFromSnapshot(task, savePath, snapshotPath, offset, unboundGeneration);
    }, REBIND_SETTLE_MS);
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== unboundGeneration ||
      !this.host.ownsItemGeneration(task, undefined, unboundGeneration)
    ) {
      clearTimeout(timer);
      return;
    }
    task.autoResumeTimer = timer;
    timer.unref?.();
  }

  private relaunchFromSnapshot(
    task: ActiveDownload,
    savePath: string,
    snapshotPath: string,
    snapshotBytes: number,
    generation: number,
  ): void {
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, undefined, generation)
    ) {
      return;
    }
    task.pendingAutoResume = false;
    task.autoResumeGeneration = undefined;
    let offset = snapshotBytes;
    let preserveRecoverySnapshot = false;
    try {
      if (existsSync(snapshotPath)) {
        if (existsSync(savePath)) unlinkSync(savePath);
        renameSync(snapshotPath, savePath);
      } else {
        offset = 0;
      }
    } catch {
      offset = 0;
      preserveRecoverySnapshot = true;
    }

    const entry = task.journalEntry;
    if (offset > 0 && entry && entry.length > offset && entry.urlChain.length > 0) {
      task.restored = true;
      task.resumeOnBind = true;
      task.lastSampleAt = Date.now();
      task.lastSampleBytes = offset;
      task.stallBytes = offset;
      task.view = {
        ...task.view,
        errorMessage: undefined,
        receivedBytes: offset,
        state: 'paused',
      };
      task.rebindCreateGeneration = generation;
      task.rebindJournalEntry = cloneJournalEntry(entry);
      this.queuePendingRestore(task, generation);
      try {
        const creation = this.host.electronSession.createInterruptedDownload(
          interruptedDownloadOptions(entry, offset, savePath),
        );
        if (creation) {
          void creation.then(
            () => {
              this.finishRebindCreate(task, generation);
            },
            () => {
              this.rejectRebindRestore(task, generation);
            },
          );
        } else {
          this.finishRebindCreate(task, generation);
        }
        this.armStallTimer(task, task.item, task.itemGeneration);
        this.host.notify();
        return;
      } catch {
        this.rejectRebindRestore(task, generation);
        return;
      }
    }

    this.restartFromSource(task, generation, preserveRecoverySnapshot);
  }

  private finishRebindCreate(task: ActiveDownload, generation: number): void {
    if (task.rebindCreateGeneration !== generation) return;
    task.rebindCreateGeneration = undefined;
    task.rebindJournalEntry = undefined;
  }

  private rejectRebindRestore(task: ActiveDownload, generation: number): void {
    if (task.rebindCreateGeneration !== generation) return;
    const recoveryEntry = task.rebindJournalEntry;
    task.rebindCreateGeneration = undefined;
    task.rebindJournalEntry = undefined;
    const item = task.item;
    if (item && task.requestGeneration === generation && recoveryEntry) {
      this.rollbackRebindItem(task, item, generation, recoveryEntry);
      return;
    }
    if (!this.host.ownsItemGeneration(task, undefined, generation)) return;
    removePendingOwnership(task, this.host.pendingRestores, this.host.pendingByUrl);
    this.clearStallTimer(task);
    this.restartFromSource(task, generation);
  }

  private restartFromSource(
    task: ActiveDownload,
    generation: number,
    preserveRecoverySnapshot = false,
  ): void {
    if (
      task.recoveryAwaitingDecision ||
      !this.host.ownsItemGeneration(task, undefined, generation)
    ) {
      return;
    }
    let recoveryBytes: number | undefined;
    try {
      recoveryBytes = snapshotPartialForRecovery(
        task.request,
        true,
        preserveRecoverySnapshot || Boolean(task.recoveryFallback),
      );
    } catch {
      // Never delete the only staging path until a sibling snapshot is durable. Retry the filesystem
      // transaction without spending another network continuation attempt.
      this.deferSourceRestart(task, generation);
      return;
    }
    if (
      recoveryBytes !== undefined &&
      task.journalEntry &&
      recoveryBytes >= task.journalEntry.receivedBytes
    ) {
      task.recoveryFallback = cloneJournalEntry(task.journalEntry);
    }
    removePendingOwnership(task, this.host.pendingRestores, this.host.pendingByUrl);
    task.itemGeneration += 1;
    const requestGeneration = task.itemGeneration;
    task.restored = false;
    task.resumeOnBind = false;
    task.lastSampleAt = Date.now();
    task.lastSampleBytes = 0;
    task.stallBytes = 0;
    task.view = {
      ...task.view,
      bytesPerSecond: 0,
      errorMessage: undefined,
      percent: -1,
      receivedBytes: 0,
      state: 'queued',
    };
    this.host.notify();
    if (!this.host.ownsItemGeneration(task, undefined, requestGeneration)) return;
    if (this.host.hasActiveDownloadUrl(task.request.url, task)) {
      // Electron exposes no request identity beyond URL metadata. Wait for the other task to leave
      // this URL before deleting our snapshot or issuing an ambiguous downloadURL call.
      this.deferSourceRestart(task, requestGeneration);
      return;
    }
    deleteStagingPartial(task.request);
    if (!this.queuePendingUrl(task, task.request.url, requestGeneration)) {
      this.deferSourceRestart(task, requestGeneration);
      return;
    }
    try {
      this.host.electronSession.downloadURL(task.request.url);
      this.armStallTimer(task, task.item, task.itemGeneration);
    } catch (error) {
      this.host.fail(task, error instanceof Error ? error : new Error('无法重新启动下载。'), true);
    }
  }

  private deferHeldRecoverySnapshot(
    task: ActiveDownload,
    item: DownloadItem,
    boundGeneration: number,
    requestGeneration: number,
    recoveryEntry: DownloadJournalEntry,
    error: Error,
    startup: boolean,
  ): void {
    const timer = setTimeout(() => {
      if (task.autoResumeTimer !== timer) return;
      task.autoResumeTimer = undefined;
      if (
        !task.recoverySnapshotPending ||
        !this.host.ownsItemGeneration(task, item, boundGeneration)
      ) {
        return;
      }
      try {
        snapshotPartialForRecovery(task.request, true, true);
      } catch {
        this.deferHeldRecoverySnapshot(
          task,
          item,
          boundGeneration,
          requestGeneration,
          recoveryEntry,
          error,
          startup,
        );
        return;
      }
      task.recoverySnapshotPending = false;
      if (startup) this.host.rollbackStartupRestore(task, error);
      else this.rollbackRebindItem(task, item, requestGeneration, recoveryEntry);
    }, AUTO_RESUME_BASE_DELAY_MS);
    if (
      !task.recoverySnapshotPending ||
      !this.host.ownsItemGeneration(task, item, boundGeneration)
    ) {
      clearTimeout(timer);
      return;
    }
    task.autoResumeTimer = timer;
    timer.unref?.();
  }

  private deferExhaustionSnapshot(
    task: ActiveDownload,
    reason: string,
    item: DownloadItem | undefined,
    generation: number,
  ): void {
    if (!this.host.ownsItemGeneration(task, item, generation)) return;
    task.pendingAutoResume = true;
    task.autoResumeGeneration = generation;
    task.view = {
      ...task.view,
      errorMessage: '无法保存最终续传快照，稍后重试…',
      state: 'paused',
    };
    this.host.notify();
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (task.autoResumeTimer !== timer) return;
      task.autoResumeTimer = undefined;
      if (
        !task.pendingAutoResume ||
        task.autoResumeGeneration !== generation ||
        !this.host.ownsItemGeneration(task, item, generation)
      ) {
        return;
      }
      task.pendingAutoResume = false;
      task.autoResumeGeneration = undefined;
      this.scheduleAutoResume(task, reason, item, generation);
    }, AUTO_RESUME_BASE_DELAY_MS);
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      clearTimeout(timer);
      return;
    }
    task.autoResumeTimer = timer;
    timer.unref?.();
  }

  private deferRebindSnapshot(
    task: ActiveDownload,
    item: DownloadItem | undefined,
    generation: number,
  ): void {
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, item, generation)
    ) {
      return;
    }
    task.view = {
      ...task.view,
      errorMessage: '无法保存续传快照，稍后重试…',
      state: 'paused',
    };
    this.host.notify();
    if (!this.host.ownsItemGeneration(task, item, generation)) return;
    const timer = setTimeout(() => {
      if (task.autoResumeTimer !== timer) return;
      task.autoResumeTimer = undefined;
      if (
        !task.recoveryAwaitingDecision &&
        task.pendingAutoResume &&
        task.autoResumeGeneration === generation &&
        this.host.ownsItemGeneration(task, item, generation)
      ) {
        this.rebindFromDisk(task, item, generation);
      }
    }, AUTO_RESUME_BASE_DELAY_MS);
    if (!this.host.ownsItemGeneration(task, item, generation)) {
      clearTimeout(timer);
      return;
    }
    task.autoResumeTimer = timer;
    timer.unref?.();
  }

  private deferSourceRestart(task: ActiveDownload, generation: number): void {
    if (!this.host.ownsItemGeneration(task, undefined, generation)) return;
    task.pendingAutoResume = true;
    task.autoResumeGeneration = generation;
    const timer = setTimeout(() => {
      if (task.autoResumeTimer !== timer) return;
      task.autoResumeTimer = undefined;
      if (
        task.recoveryAwaitingDecision ||
        !task.pendingAutoResume ||
        task.autoResumeGeneration !== generation ||
        !this.host.ownsItemGeneration(task, undefined, generation)
      ) {
        return;
      }
      task.pendingAutoResume = false;
      task.autoResumeGeneration = undefined;
      this.restartFromSource(task, generation, true);
    }, REBIND_SETTLE_MS);
    if (
      !task.pendingAutoResume ||
      task.autoResumeGeneration !== generation ||
      !this.host.ownsItemGeneration(task, undefined, generation)
    ) {
      clearTimeout(timer);
      return;
    }
    task.autoResumeTimer = timer;
    timer.unref?.();
  }
}
