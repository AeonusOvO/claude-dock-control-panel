/* eslint-disable max-lines -- Download engine coordinates lifecycle, recovery, and ownership. */
import type { DownloadItem, Event } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { DownloadTaskView } from '../../shared/contracts';
import type { BusyRegistry } from '../coordination/busy-registry';
import { DownloadHistoryStore } from './history';
import {
  type ActiveDownload,
  cloneJournalEntry,
  deleteRecoveryPaths,
  deleteResumeSnapshot,
  interruptedDownloadOptions,
  JOURNAL_WRITE_INTERVAL_MS,
  type PendingDownloadOwnership,
  promoteRecoverySnapshot,
  removePendingOwnership,
  RESUME_SNAPSHOT_SUFFIX,
  snapshotPartialForRecovery,
} from './engine-state';
import { DownloadRetryController } from './engine-retry';
import { DownloadJournal, type DownloadJournalEntry } from './journal';
import { pickFastestGitHubReleaseRoute } from './github-release-routes';
import { calculateDownloadProgress } from './metrics';
import type {
  DownloadRequest,
  DownloadResult,
  DownloadSession,
  DownloadsListener,
} from './request';
import {
  isAllowedUrl,
  isPathWithinUserData,
  isRecoverableEntry,
  isSafePartialPath,
  verifyPartial,
} from './safety';
export type {
  DownloadRequest,
  DownloadResult,
  DownloadSession,
  DownloadsListener,
} from './request';

export class DownloadEngine {
  private disposed = false;
  private disposing = false;
  private installed = false;
  private readonly listeners = new Set<DownloadsListener>();
  private readonly pendingByUrl = new Map<string, PendingDownloadOwnership[]>();
  private readonly pendingRestores: PendingDownloadOwnership[] = [];
  private readonly tasks = new Map<string, ActiveDownload>();
  private readonly journal: DownloadJournal;
  private readonly history: DownloadHistoryStore;
  private readonly retry: DownloadRetryController;
  private recoveryRestorePromise?: Promise<void>;
  private readonly willDownloadListener = (event: Event, item: DownloadItem): void => {
    this.acceptItem(event, item);
  };

  public constructor(
    private readonly electronSession: DownloadSession,
    private readonly busyRegistry: BusyRegistry,
    private readonly userDataPath: string,
    onChange?: DownloadsListener,
  ) {
    this.journal = new DownloadJournal(userDataPath);
    this.history = new DownloadHistoryStore(userDataPath);
    this.retry = new DownloadRetryController({
      complete: (task, item, generation) => this.complete(task, item, generation),
      electronSession,
      fail: (task, error, preserveJournal) => this.fail(task, error, preserveJournal),
      journal: this.journal,
      notify: () => this.notify(),
      hasActiveDownloadUrl: (url, excludedTask) => this.hasActiveDownloadUrl(url, excludedTask),
      ownsItemGeneration: (task, item, generation) =>
        this.ownsItemGeneration(task, item, generation),
      pendingByUrl: this.pendingByUrl,
      pendingRestores: this.pendingRestores,
      persistTask: (task, force, recoveryBytes) => this.persistTask(task, force, recoveryBytes),
      rollbackStartupRestore: (task, error) => this.rollbackStartupRestore(task, error),
      settleCancelled: (task) => this.settleCancelled(task),
    });
    if (onChange) {
      this.listeners.add(onChange);
    }
  }

  public cancel(taskId: string): DownloadTaskView {
    this.requireOperational();
    const task = this.requireTask(taskId);
    if (task.settled) return { ...task.view };
    if (task.recoveryAwaitingDecision) {
      throw new Error('请先处理恢复确认。');
    }
    this.retry.clearStallTimer(task);
    this.retry.clearAutoResumeTimer(task);
    removePendingOwnership(task, this.pendingRestores, this.pendingByUrl);
    const item = task.item;
    this.retry.detachItemListeners(task);
    task.item = undefined;
    task.requestGeneration = undefined;
    task.itemGeneration += 1;
    try {
      item?.cancel();
    } catch {
      // The completion still has to settle if Electron already tore the item down.
    }
    this.settleCancelled(task);
    return { ...task.view };
  }

  public install(): void {
    if (this.installed || this.disposed || this.disposing) return;
    this.installed = true;
    try {
      this.electronSession.on('will-download', this.willDownloadListener);
    } catch (error) {
      this.installed = false;
      throw error;
    }
  }

  /** Final quit cleanup: durably preserve recovery state, then settle and detach every owner. */
  public flushJournal(): void {
    this.dispose();
  }

  public dispose(): void {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    try {
      for (const task of this.tasks.values()) {
        if (task.settled) continue;
        const snapshotBytes = snapshotPartialForRecovery(
          task.request,
          true,
          Boolean(task.recoveryFallback),
        );
        this.persistTask(task, true, snapshotBytes);
      }
      this.journal.flush();
    } catch (error) {
      // Do not latch disposal before durable recovery succeeds: session-end/before-quit may retry.
      this.disposing = false;
      throw error;
    }

    this.disposed = true;
    this.disposing = false;
    if (this.installed) {
      try {
        this.electronSession.removeListener?.('will-download', this.willDownloadListener);
      } catch {
        // All callbacks are also generation/disposal fenced if Electron is already shutting down.
      }
      this.installed = false;
    }
    this.listeners.clear();
    const disposalError = new Error('下载引擎已经关闭。');
    for (const task of this.tasks.values()) {
      this.retry.clearStallTimer(task);
      this.retry.clearAutoResumeTimer(task);
      removePendingOwnership(task, this.pendingRestores, this.pendingByUrl);
      const item = task.item;
      this.retry.detachItemListeners(task);
      task.item = undefined;
      task.requestGeneration = undefined;
      task.itemGeneration += 1;
      task.startupCreatePending = false;
      task.startupItemBindPending = false;
      if (task.settled) continue;
      task.settled = true;
      try {
        item?.cancel();
      } catch {
        // A dying Electron session may already have destroyed the native item.
      }
      task.releaseBusy();
      task.reject(disposalError);
    }
    this.tasks.clear();
    this.pendingByUrl.clear();
    this.pendingRestores.length = 0;
  }

  public list(): DownloadTaskView[] {
    const current = [...this.tasks.values()].map(({ view }) => ({ ...view }));
    const currentIds = new Set(current.map(({ id }) => id));
    return [...current, ...this.history.list().filter(({ id }) => !currentIds.has(id))];
  }

  public listRecoveryPending(): DownloadTaskView[] {
    return [...this.tasks.values()]
      .filter(({ recoveryAwaitingDecision, settled }) => recoveryAwaitingDecision && !settled)
      .map(({ view, recoveryToken }) => ({ ...view, recoveryPending: true, recoveryToken }));
  }

  /** Resumes one startup-recovered task only after the renderer has obtained explicit consent. */
  public resumeRecovery(taskId: string, recoveryToken?: string): DownloadTaskView {
    this.requireOperational();
    const task = this.requireActiveTask(taskId);
    if (recoveryToken !== undefined && task.recoveryToken !== recoveryToken) {
      throw new Error('恢复记录已更新，请重新确认后再操作。');
    }
    if (task.recoveryJournalPending || task.recoverySnapshotPending) {
      throw new Error('正在保存恢复快照，当前下载不能继续。');
    }
    if (!task.recoveryAwaitingDecision || !task.restored) {
      throw new Error('该下载不需要恢复确认。');
    }
    this.retry.clearAutoResumeTimer(task);
    task.resumeOnBind = true;
    const item = task.item;
    const generation = task.itemGeneration;
    if (item && this.ownsItemGeneration(task, item, generation)) {
      try {
        const canResume = item.canResume();
        // The explicit user choice is the authorization boundary. A native item that cannot resume
        // is allowed to fall through the existing source-restart path, but a thrown probe leaves the
        // prompt intact so a transient native failure cannot consume consent.
        task.recoveryAwaitingDecision = false;
        task.view = { ...task.view, recoveryPending: false };
        task.resumeOnBind = false;
        task.startupResumeFailed = false;
        if (canResume) {
          item.resume();
          if (this.ownsItemGeneration(task, item, generation)) {
            this.retry.armStallTimer(task, item, generation);
          }
        } else {
          this.retry.scheduleAutoResume(task, '恢复项目无法就地续传', item, generation);
        }
      } catch (error) {
        task.resumeOnBind = false;
        task.startupResumeFailed = task.startupItemBindPending;
        task.recoveryAwaitingDecision = true;
        task.view = { ...task.view, recoveryPending: true };
        throw error;
      }
    } else {
      // The startup item may still be binding. Consent is recorded now; acceptItem() will either
      // resume the exact item or invoke the source-restart path when it reports canResume=false.
      task.recoveryAwaitingDecision = false;
      task.view = { ...task.view, recoveryPending: false };
    }
    this.notify();
    return { ...task.view };
  }

  /** Discards only the selected recovered task and its journal/snapshot, never its final artifact. */
  public discardRecovery(taskId: string, recoveryToken?: string): DownloadTaskView[] {
    this.requireOperational();
    const task = this.requireActiveTask(taskId);
    if (recoveryToken !== undefined && task.recoveryToken !== recoveryToken) {
      throw new Error('恢复记录已更新，请重新确认后再操作。');
    }
    if (task.recoveryJournalPending || task.recoverySnapshotPending) {
      throw new Error('正在保存恢复快照，当前下载不能放弃。');
    }
    if (!task.recoveryAwaitingDecision || !task.restored) {
      throw new Error('该下载不需要恢复确认。');
    }
    // Remove the durable record first. If this fails the task remains visible and recoverable.
    this.journal.remove(taskId);
    this.retry.clearStallTimer(task);
    this.retry.clearAutoResumeTimer(task);
    removePendingOwnership(task, this.pendingRestores, this.pendingByUrl);
    this.retry.detachItemListeners(task);
    const item = task.item;
    task.item = undefined;
    task.requestGeneration = undefined;
    task.itemGeneration += 1;
    task.startupCreatePending = false;
    task.startupItemBindPending = false;
    try {
      item?.cancel();
    } catch {
      // Native recovery teardown is best effort; the journal removal prevents future execution.
    }
    this.deletePartial(task);
    task.settled = true;
    task.recoveryAwaitingDecision = false;
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      finishedAt: Date.now(),
      recoveryPending: false,
      state: 'cancelled',
    };
    this.tasks.delete(taskId);
    task.releaseBusy();
    task.reject(new Error('恢复下载已放弃。'));
    this.notify();
    return this.list();
  }

  public clearHistory(): DownloadTaskView[] {
    this.requireOperational();
    for (const [id, task] of this.tasks) {
      if (task.settled) {
        this.journal.remove(id);
        this.deletePartial(task);
        this.tasks.delete(id);
      }
    }
    this.history.clear();
    this.notify();
    return this.list();
  }

  public deleteHistory(taskId: string): DownloadTaskView[] {
    this.requireOperational();
    const task = this.tasks.get(taskId);
    if (task && !task.settled) throw new Error('进行中的下载不能删除记录。');
    if (task?.settled) {
      this.journal.remove(taskId);
      this.deletePartial(task);
      this.tasks.delete(taskId);
    }
    this.history.remove(taskId);
    this.notify();
    return this.list();
  }

  public onChange(listener: DownloadsListener): () => void {
    if (this.disposed || this.disposing) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public pause(taskId: string): DownloadTaskView {
    this.requireOperational();
    const task = this.requireActiveTask(taskId);
    if (task.recoveryAwaitingDecision) {
      throw new Error('请先处理恢复确认。');
    }
    if (task.recoveryJournalPending || task.recoverySnapshotPending) {
      throw new Error('正在保存恢复快照，当前下载不能暂停。');
    }
    const item = task.item;
    const generation = task.itemGeneration;
    if (!item || !task.view.canPause) {
      throw new Error('当前下载不能暂停。');
    }
    item.pause();
    this.retry.clearStallTimer(task);
    this.retry.updateFromItem(task, item, generation, 'progressing');
    return { ...task.view };
  }

  public resume(taskId: string): DownloadTaskView {
    this.requireOperational();
    const task = this.requireActiveTask(taskId);
    if (task.recoveryAwaitingDecision) {
      throw new Error('请先处理恢复确认。');
    }
    if (task.recoveryJournalPending || task.recoverySnapshotPending) {
      throw new Error('正在保存恢复快照，当前下载不能继续。');
    }
    if (task.pendingAutoResume) {
      // Asking to continue during backoff spends the attempt now; keep its generation through rebind.
      if (task.autoResumeTimer) clearTimeout(task.autoResumeTimer);
      task.autoResumeTimer = undefined;
      this.retry.runAutoResume(task, task.item, task.itemGeneration);
      return { ...task.view };
    }
    const item = task.item;
    const generation = task.itemGeneration;
    if (!item || !item.canResume()) {
      throw new Error('当前下载不能继续。');
    }
    item.resume();
    this.retry.armStallTimer(task, item, generation);
    this.retry.updateFromItem(task, item, generation, 'progressing');
    return { ...task.view };
  }

  public restoreInterrupted(): Promise<void> {
    if (this.disposed || this.disposing) return Promise.resolve();
    this.install();
    if (this.disposed || this.disposing) return Promise.resolve();
    if (this.recoveryRestorePromise) return this.recoveryRestorePromise;
    const restore = this.restoreInterruptedAsync();
    const pending = restore.finally(() => {
      if (this.recoveryRestorePromise === pending) this.recoveryRestorePromise = undefined;
    });
    this.recoveryRestorePromise = pending;
    return pending;
  }

  private async restoreInterruptedAsync(): Promise<void> {
    const storedEntries = this.journal.list();
    const retainedEntries: DownloadJournalEntry[] = [];
    const recoverableEntries: DownloadJournalEntry[] = [];
    const seenRestorePaths = new Set<string>();
    for (const entry of storedEntries) {
      // Distinct journal IDs must never be allowed to operate on one staging path concurrently.
      // Keep the first record authoritative and leave its artifact untouched while dropping later
      // duplicates from the durable journal below.
      const restorePath = path.resolve(entry.savePath);
      if (seenRestorePaths.has(restorePath)) continue;
      seenRestorePaths.add(restorePath);

      const promotion = existsSync(`${entry.savePath}${RESUME_SNAPSHOT_SUFFIX}`)
        ? await promoteRecoverySnapshot(this.userDataPath, entry)
        : 'none';
      const request = {
        allowedHosts: entry.allowedHosts,
        allowedPathPrefixes: entry.allowedPathPrefixes,
        expectedBytes: entry.expectedBytes,
        expectedSha256: entry.expectedSha256,
        finalPath: entry.finalPath,
        id: entry.id,
        label: entry.label,
        maxBytes: entry.maxBytes,
        url: entry.urlChain[0]!,
      };
      if (promotion === 'blocked') {
        // A sufficient sibling snapshot exists but a transient lock prevented promotion. Keep its
        // durable metadata and retry on a later startup; do not create a task against the bad path.
        retainedEntries.push(entry);
        continue;
      }
      if (
        entry.urlChain.every((candidate) => isAllowedUrl(request, candidate)) &&
        isRecoverableEntry(this.userDataPath, entry)
      ) {
        retainedEntries.push(entry);
        if (this.hasActiveDownloadUrl(entry.urlChain[0]!)) {
          // Electron exposes only URL metadata for will-download. Two live restores with the same
          // URL cannot be associated safely, so retain the later journal record for a future retry
          // instead of allowing either item to steal the other task's staging path.
          continue;
        }
        recoverableEntries.push(entry);
        continue;
      }
      if (isSafePartialPath(this.userDataPath, entry.savePath)) {
        deleteRecoveryPaths(entry.savePath);
      }
    }
    // Write the filtered journal before acquiring leases or starting Electron work. A failed replace
    // is therefore retryable and cannot strand half-created restore tasks.
    if (retainedEntries.length !== storedEntries.length) {
      this.journal.replace(retainedEntries);
    }

    for (const entry of recoverableEntries) {
      if (this.disposed || this.disposing) break;
      // A recoverable record stays in the journal unless a later, explicit safety policy rejects it.
      // Transient Electron creation/binding failures leave it available for the next retry.
      let completion: Promise<DownloadResult>;
      let task: ActiveDownload;
      try {
        ({ completion, task } = this.createTask(
          {
            allowedHosts: entry.allowedHosts,
            allowedPathPrefixes: entry.allowedPathPrefixes,
            expectedBytes: entry.expectedBytes,
            expectedSha256: entry.expectedSha256,
            finalPath: entry.finalPath,
            id: entry.id,
            label: entry.label,
            maxBytes: entry.maxBytes,
            url: entry.urlChain[0]!,
          },
          entry,
        ));
      } catch {
        // A duplicate live task owns this id for now; retain the record for a later retry.
        continue;
      }

      void completion.catch(() => undefined);
      this.retry.queuePendingRestore(task, task.itemGeneration);
      try {
        const creation = this.electronSession.createInterruptedDownload(
          interruptedDownloadOptions(entry),
        );
        this.retry.armStartupBindTimer(task, task.itemGeneration);
        if (creation) {
          void creation.then(
            () => {
              this.finishStartupCreate(task);
            },
            (error: unknown) => {
              this.rollbackStartupRestore(task, this.asError(error, '无法恢复下载。'));
            },
          );
        } else {
          this.finishStartupCreate(task);
        }
      } catch (error) {
        this.rollbackStartupRestore(task, this.asError(error, '无法恢复下载。'));
      }
    }
    this.notify();
  }

  public start(request: DownloadRequest): Promise<DownloadResult> {
    this.requireOperational();
    this.install();
    this.requireOperational();
    const url = new URL(request.url);
    if (url.protocol !== 'https:') {
      throw new Error('下载地址必须使用 HTTPS。');
    }
    if (!isAllowedUrl(request, url)) {
      throw new Error('下载地址不在允许的来源与路径范围内。');
    }
    if (
      request.allowedHosts.length === 0 ||
      request.allowedHosts.length !== request.allowedPathPrefixes.length
    ) {
      throw new Error('下载来源白名单配置无效。');
    }
    if (!Number.isFinite(request.maxBytes) || request.maxBytes <= 0) {
      throw new Error('下载大小上限无效。');
    }
    if (!isPathWithinUserData(this.userDataPath, request.finalPath)) {
      throw new Error('下载目标必须位于 ClaudeDock 用户数据目录。');
    }
    if (
      this.electronSession.fetch &&
      url.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/releases\/download\//.test(url.pathname)
    ) {
      return this.startGitHubRelease(request, url);
    }
    return this.launch({ ...request, url: url.toString() });
  }

  private async startGitHubRelease(
    request: DownloadRequest,
    officialUrl: URL,
  ): Promise<DownloadResult> {
    this.requireOperational();
    const route = await pickFastestGitHubReleaseRoute(officialUrl.toString(), (url, init) =>
      this.electronSession.fetch!(url, init),
    );
    // Sampling is asynchronous and its fetch implementation may also notify reentrantly.
    this.requireOperational();
    if (!route) return this.launch({ ...request, url: officialUrl.toString() });
    return this.launch({
      ...request,
      allowedHosts: route.allowedHosts,
      allowedPathPrefixes: route.allowedPathPrefixes,
      label: `${request.label} · ${route.label}`,
      url: route.url,
    });
  }

  private hasActiveDownloadUrl(url: string, excludedTask?: ActiveDownload): boolean {
    let normalized: string;
    try {
      normalized = new URL(url).toString();
    } catch {
      return false;
    }
    for (const task of this.tasks.values()) {
      if (task === excludedTask || task.settled) continue;
      const knownUrls = [task.request.url, ...(task.journalEntry?.urlChain ?? [])];
      if (
        knownUrls.some((known) => {
          try {
            return new URL(known).toString() === normalized;
          } catch {
            return false;
          }
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private launch(request: DownloadRequest): Promise<DownloadResult> {
    this.requireOperational();
    if (this.hasActiveDownloadUrl(request.url)) {
      return Promise.reject(new Error('同一下载地址已有任务正在进行，请等待当前任务结束后重试。'));
    }
    const { completion, task } = this.createTask(request);
    const generation = task.itemGeneration;
    try {
      /*
       * `createTask` has already acquired the busy lease and registered the task, so the initial
       * journal write has to be inside this cleanup: an ENOSPC/EACCES here used to leak both. The
       * task then stayed unsettled forever (undeletable via deleteHistory, skipped by
       * clearHistory), its lease sat in the quit dialog, and because ids are version-derived every
       * retry hit "下载任务已存在".
       */
      this.persistTask(task, true);
      this.notify();
      if (!this.ownsItemGeneration(task, undefined, generation)) return completion;
      if (!this.retry.queuePendingUrl(task, task.request.url, generation)) {
        this.fail(task, new Error('同一下载地址已有任务正在等待系统交付，请稍后重试。'));
        return completion;
      }
      this.electronSession.downloadURL(task.request.url);
      this.retry.armStallTimer(task, task.item, task.itemGeneration);
    } catch (error) {
      this.fail(task, error instanceof Error ? error : new Error('无法启动下载。'));
    }
    return completion;
  }

  private ownsItemGeneration(
    task: ActiveDownload,
    item: DownloadItem | undefined,
    generation: number,
  ): boolean {
    return (
      !this.disposed &&
      !this.disposing &&
      !task.settled &&
      this.tasks.get(task.request.id) === task &&
      task.item === item &&
      task.itemGeneration === generation
    );
  }

  private rollbackStartupRestore(task: ActiveDownload, error: Error): void {
    if (
      this.disposed ||
      this.disposing ||
      task.settled ||
      task.startupResumeFailed ||
      task.recoveryJournalPending ||
      task.recoverySnapshotPending ||
      (!task.startupCreatePending && !task.startupItemBindPending) ||
      this.tasks.get(task.request.id) !== task
    ) {
      return;
    }
    removePendingOwnership(task, this.pendingRestores, this.pendingByUrl);
    this.retry.clearStallTimer(task);
    this.retry.clearAutoResumeTimer(task);
    snapshotPartialForRecovery(task.request, false, true);
    const original = task.startupJournalEntry;
    if (original) {
      try {
        this.journal.upsert(original);
      } catch {
        this.retry.holdStartupJournalRollback(task, error);
        return;
      }
      task.journalEntry = cloneJournalEntry(original);
      task.lastJournalAt = Date.now();
      task.view = {
        ...task.view,
        receivedBytes: original.receivedBytes,
        totalBytes: original.length,
      };
    }
    task.startupCreatePending = false;
    task.startupItemBindPending = false;
    const item = task.item;
    this.retry.detachItemListeners(task);
    task.item = undefined;
    task.requestGeneration = undefined;
    task.itemGeneration += 1;
    try {
      item?.cancel();
    } catch {
      // Electron may already have torn down an item whose asynchronous creation/binding failed.
    }
    task.settled = true;
    this.tasks.delete(task.request.id);
    task.releaseBusy();
    task.reject(error);
    this.notify();
  }

  private asError(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(fallback);
  }

  private createTask(
    request: DownloadRequest,
    journalEntry?: DownloadJournalEntry,
  ): { completion: Promise<DownloadResult>; task: ActiveDownload } {
    const existing = this.tasks.get(request.id);
    if (existing?.settled) {
      this.tasks.delete(request.id);
    } else if (existing) {
      throw new Error(`下载任务 ${request.id} 已存在。`);
    }
    this.history.remove(request.id);
    mkdirSync(path.dirname(request.finalPath), { recursive: true });
    let resolve!: (result: DownloadResult) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<DownloadResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const startedAt = journalEntry ? journalEntry.startTime * 1000 : Date.now();
    const releaseBusy = this.busyRegistry.acquire({
      cancellable: true,
      id: `download:${request.id}`,
      kind: 'download',
      label: request.label,
      severity: 'resumable',
    });
    if (this.disposed || this.disposing) {
      releaseBusy();
      throw new Error('下载引擎已经关闭。');
    }
    const task: ActiveDownload = {
      autoResumeAttempts: 0,
      itemGeneration: 0,
      journalEntry,
      lastJournalAt: 0,
      lastSampleAt: startedAt,
      lastSampleBytes: journalEntry?.receivedBytes ?? 0,
      pendingAutoResume: false,
      reject,
      releaseBusy,
      request: { ...request },
      resolve,
      recoveryToken: journalEntry ? randomUUID() : undefined,
      restored: Boolean(journalEntry),
      recoveryAwaitingDecision: Boolean(journalEntry),
      resumeOnBind: false,
      settled: false,
      stallBytes: journalEntry?.receivedBytes ?? 0,
      startedAt,
      startupCreatePending: Boolean(journalEntry),
      startupItemBindPending: Boolean(journalEntry),
      startupResumeFailed: false,
      startupJournalEntry: journalEntry ? cloneJournalEntry(journalEntry) : undefined,
      view: {
        bytesPerSecond: 0,
        canPause: false,
        canResume: Boolean(journalEntry),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        id: request.id,
        label: request.label,
        percent: -1,
        receivedBytes: journalEntry?.receivedBytes ?? 0,
        remainingMs: -1,
        startedAt,
        state: journalEntry ? 'paused' : 'queued',
        totalBytes: journalEntry?.length ?? 0,
        recoveryPending: Boolean(journalEntry),
      },
    };
    if (journalEntry) {
      Object.assign(
        task.view,
        calculateDownloadProgress(
          journalEntry.receivedBytes,
          journalEntry.length,
          task.view.bytesPerSecond,
        ),
      );
    }
    this.tasks.set(request.id, task);
    return { completion, task };
  }

  private acceptItem(event: Event, item: DownloadItem): void {
    if (this.disposed || this.disposing) {
      event.preventDefault();
      return;
    }
    let ownership: (PendingDownloadOwnership & { urlChain: string[] }) | undefined;
    try {
      ownership = this.claimPendingTask(item);
    } catch {
      event.preventDefault();
      return;
    }
    if (!ownership || !this.ownsItemGeneration(ownership.task, undefined, ownership.generation)) {
      event.preventDefault();
      return;
    }
    const task = ownership.task;
    const recoveryEntry = task.recoveryFallback
      ? cloneJournalEntry(task.recoveryFallback)
      : task.restored && task.journalEntry
        ? cloneJournalEntry(task.journalEntry)
        : undefined;
    let attemptedStartupRecoveryResume = false;
    try {
      if (!ownership.urlChain.every((candidate) => isAllowedUrl(task.request, candidate))) {
        event.preventDefault();
        task.startupCreatePending = false;
        task.startupItemBindPending = false;
        try {
          item.cancel();
        } catch {
          // Safety cleanup remains terminal even if the native item refuses cancellation.
        }
        this.deletePartial(task);
        this.fail(task, new Error('下载重定向链包含未获允许的来源，任务已取消。'));
        return;
      }
      // createInterruptedDownload may already own the recovery path before this event. If the
      // snapshot transaction is blocked, retain and pause the exact item until retry succeeds.
      if (recoveryEntry) {
        try {
          snapshotPartialForRecovery(task.request, true, true, recoveryEntry.receivedBytes);
          task.recoveryFallback = cloneJournalEntry(recoveryEntry);
        } catch (error) {
          this.retry.holdItemForRecoverySnapshot(
            task,
            item,
            ownership.generation,
            recoveryEntry,
            this.asError(error, '无法保存恢复快照。'),
            task.startupItemBindPending,
          );
          return;
        }
      }
      this.retry.clearStallTimer(task);
      // A delayed restore item may arrive while its unbound generation is already backing off. The
      // bound item supersedes that timer and must be able to arm its own watchdog immediately.
      if (task.pendingAutoResume) this.retry.clearAutoResumeTimer(task);
      task.item = item;
      task.requestGeneration = ownership.generation;
      task.itemGeneration += 1;
      const generation = task.itemGeneration;
      item.setSavePath(`${task.request.finalPath}.partial`);
      if (item.getTotalBytes() > task.request.maxBytes) {
        event.preventDefault();
        task.startupCreatePending = false;
        task.startupItemBindPending = false;
        this.retry.detachItemListeners(task);
        task.item = undefined;
        task.requestGeneration = undefined;
        task.itemGeneration += 1;
        try {
          item.cancel();
        } catch {
          // Safety deletion and terminal settlement must not depend on native cancellation.
        }
        this.deletePartial(task);
        this.fail(task, new Error('下载内容超过安全上限，文件已删除。'));
        return;
      }
      this.retry.attachItemListeners(task, item, generation);
      this.retry.updateFromItem(
        task,
        item,
        generation,
        task.restored ? 'interrupted' : 'progressing',
      );
      if (!this.ownsItemGeneration(task, item, generation)) return;
      if (task.resumeOnBind) {
        task.resumeOnBind = false;
        this.retry.clearAutoResumeTimer(task);
        let canResume = false;
        try {
          canResume = item.canResume();
        } catch {
          // A native probe failure after explicit consent follows the same source-restart path as a
          // non-resumable item instead of reopening a hidden automatic retry.
        }
        if (canResume) {
          attemptedStartupRecoveryResume = task.startupItemBindPending;
          item.resume();
          if (task.view.state === 'verifying' || !this.ownsItemGeneration(task, item, generation)) {
            return;
          }
          task.startupResumeFailed = false;
          this.retry.armStallTimer(task, item, generation);
        } else {
          this.retry.scheduleAutoResume(task, '恢复项目无法就地续传', item, generation);
          if (!this.ownsItemGeneration(task, item, generation)) return;
        }
      }
      task.startupItemBindPending = false;
      if (!task.startupCreatePending) task.startupJournalEntry = undefined;
    } catch (error) {
      const failure = this.asError(error, '无法接管恢复的下载。');
      if (attemptedStartupRecoveryResume && recoveryEntry) {
        // The item is already bound, but native resume failed after explicit consent. Keep the item
        // and completion alive so the user can retry; a late create promise must not discard the
        // recovery task or its journal while this prompt is visible.
        task.startupResumeFailed = true;
        task.startupItemBindPending = false;
        task.resumeOnBind = false;
        task.recoveryAwaitingDecision = true;
        task.view = {
          ...task.view,
          canPause: false,
          canResume: false,
          errorMessage: failure.message,
          recoveryPending: true,
          state: 'paused',
        };
        try {
          item.pause();
        } catch {
          // A failed native resume may already have torn down the item; retain the journal regardless.
        }
        if (!task.startupCreatePending) task.startupJournalEntry = undefined;
        this.notify();
        return;
      }
      event.preventDefault();
      if (task.startupItemBindPending) {
        if (task.item !== item) {
          try {
            item.cancel();
          } catch {
            // setSavePath did not run, so the original partial remains outside this item's ownership.
          }
        }
        this.rollbackStartupRestore(task, failure);
      } else if (recoveryEntry) {
        this.retry.rollbackRebindItem(task, item, ownership.generation, recoveryEntry);
      } else {
        this.retry.detachItemListeners(task);
        if (task.item === item) {
          task.item = undefined;
          task.requestGeneration = undefined;
          task.itemGeneration += 1;
        }
        try {
          item.cancel();
        } catch {
          // The item may already have failed while Electron was delivering this event.
        }
        this.fail(task, failure);
      }
    }
  }

  /**
   * Electron may report the final redirected asset URL from DownloadItem#getURL even though
   * downloadURL was called with the original GitHub release URL. Match every normalized hop in the
   * item URL chain so a legitimate redirect is not mistaken for an unrelated browser download and
   * cancelled before its first byte arrives.
   */
  private claimPendingTask(
    item: DownloadItem,
  ): (PendingDownloadOwnership & { urlChain: string[] }) | undefined {
    const candidates: string[] = [];
    const urlChain = item.getURLChain();
    for (const candidate of [item.getURL(), ...urlChain]) {
      try {
        const normalized = new URL(candidate).toString();
        if (!candidates.includes(normalized)) candidates.push(normalized);
      } catch {
        // Invalid redirect hops fail the whitelist check if a task is otherwise claimed.
      }
    }
    for (const candidate of candidates) {
      const pending = this.pendingByUrl.get(candidate);
      while (pending?.length) {
        const ownership = pending.shift()!;
        if (pending.length === 0) this.pendingByUrl.delete(candidate);
        if (this.ownsItemGeneration(ownership.task, undefined, ownership.generation)) {
          return { ...ownership, urlChain };
        }
      }
    }
    for (let index = this.pendingRestores.length - 1; index >= 0; index -= 1) {
      const ownership = this.pendingRestores[index]!;
      if (!this.ownsItemGeneration(ownership.task, undefined, ownership.generation)) {
        this.pendingRestores.splice(index, 1);
      }
    }
    const restoredIndex = this.pendingRestores.findIndex(({ task }) => {
      const knownUrls = [task.request.url, ...(task.journalEntry?.urlChain ?? [])];
      return knownUrls.some((known) => {
        try {
          return candidates.includes(new URL(known).toString());
        } catch {
          return false;
        }
      });
    });
    if (restoredIndex < 0) return undefined;
    return { ...this.pendingRestores.splice(restoredIndex, 1)[0]!, urlChain };
  }

  private async complete(
    task: ActiveDownload,
    item: DownloadItem,
    generation: number,
  ): Promise<void> {
    if (task.view.state === 'verifying' || !this.ownsItemGeneration(task, item, generation)) {
      return;
    }
    this.retry.clearStallTimer(task);
    this.retry.clearAutoResumeTimer(task);
    this.retry.detachItemListeners(task);
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      state: 'verifying',
    };
    this.notify();
    if (!this.ownsItemGeneration(task, item, generation)) return;

    try {
      await verifyPartial(task.request);
    } catch (error) {
      if (!this.ownsItemGeneration(task, item, generation)) return;
      this.deletePartial(task);
      const detail = error instanceof Error ? error.message : '无法校验下载文件。';
      this.fail(task, new Error(`校验未通过，文件已删除：${detail}`));
      return;
    }
    // verifyPartial yields while hashing. Disposal, cancellation or a replacement generation must
    // fence the continuation before it publishes bytes to the final executable path.
    if (!this.ownsItemGeneration(task, item, generation)) return;
    // A reentrant resume callback may have tried to arm a watchdog while verification was yielding.
    this.retry.clearStallTimer(task);

    try {
      // Let the filesystem perform the replacement as one rename transaction. Pre-unlinking the old
      // executable would destroy the last working copy if the subsequent rename were blocked.
      renameSync(`${task.request.finalPath}.partial`, task.request.finalPath);
    } catch (error) {
      /*
       * Verification already passed, so these bytes are known-good. A failed replace (routine
       * EPERM/EBUSY on Windows while a scanner holds a handle) retains both journal and partial.
       */
      const detail = error instanceof Error ? error.message : '未知错误。';
      this.fail(task, new Error(`校验已通过，但替换目标文件失败，已保留下载内容：${detail}`), true);
      return;
    }

    task.settled = true;
    task.item = undefined;
    task.requestGeneration = undefined;
    task.rebindCreateGeneration = undefined;
    task.rebindJournalEntry = undefined;
    task.recoveryFallback = undefined;
    task.startupCreatePending = false;
    task.startupItemBindPending = false;
    task.itemGeneration += 1;
    deleteResumeSnapshot(task.request);
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      elapsedMs: Date.now() - task.startedAt,
      finishedAt: Date.now(),
      percent: 100,
      remainingMs: 0,
      state: 'completed',
    };
    // Same hazard as `fail()`: the task is already settled, so a throwing journal write would skip
    // the teardown below and leave the caller's promise pending with its lease held forever.
    try {
      this.journal.remove(task.request.id);
    } catch {
      // Losing the resume record is recoverable; wedging a completed download is not.
    }
    this.recordHistory(task.view);
    task.releaseBusy();
    task.resolve({ filePath: task.request.finalPath, id: task.request.id });
    this.notify();
  }

  private fail(task: ActiveDownload, error: Error, preserveJournal = false): void {
    if (task.settled) {
      return;
    }
    this.retry.clearStallTimer(task);
    this.retry.clearAutoResumeTimer(task);
    removePendingOwnership(task, this.pendingRestores, this.pendingByUrl);
    const recoveryBytes = preserveJournal
      ? snapshotPartialForRecovery(task.request, false, true)
      : undefined;
    const item = task.item;
    this.retry.detachItemListeners(task);
    task.item = undefined;
    task.requestGeneration = undefined;
    task.rebindCreateGeneration = undefined;
    task.rebindJournalEntry = undefined;
    task.itemGeneration += 1;
    try {
      item?.cancel();
    } catch {
      // Terminal settlement cannot depend on a native item that may already be tearing down.
    }
    if (!preserveJournal) this.deletePartial(task);
    task.startupCreatePending = false;
    task.startupItemBindPending = false;
    task.settled = true;
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      elapsedMs: Date.now() - task.startedAt,
      errorMessage: error.message,
      finishedAt: Date.now(),
      state: 'failed',
    };
    /*
     * Both journal paths write to disk and can throw (ENOSPC/EACCES). Teardown below — releasing
     * the busy lease and rejecting the caller — must happen regardless, or a failing disk leaves a
     * permanently unsettled task whose lease sits in the quit dialog and whose id can never be
     * retried.
     */
    try {
      if (preserveJournal) {
        this.persistTask(task, true, recoveryBytes);
      } else {
        this.journal.remove(task.request.id);
      }
    } catch {
      // Losing the resume record is recoverable; leaking the lease is not.
    }
    task.releaseBusy();
    this.recordHistory(task.view);
    task.reject(error);
    this.notify();
  }

  private notify(): void {
    if (this.disposed || this.disposing) return;
    const snapshot = this.list();
    for (const listener of [...this.listeners]) {
      if (this.disposed || this.disposing) break;
      try {
        listener(snapshot);
      } catch {
        // UI notification failures must not interrupt download ownership/timer transactions.
      }
    }
  }

  private recordHistory(view: DownloadTaskView): void {
    try {
      this.history.upsert(view);
    } catch {
      // History is useful metadata, but a write failure must not change download integrity/result.
    }
  }

  private persistTask(task: ActiveDownload, force = false, recoveryBytes?: number): void {
    if (task.view.state === 'cancelled' || task.view.state === 'completed') {
      return;
    }
    const now = Date.now();
    if (!force && now - task.lastJournalAt < JOURNAL_WRITE_INTERVAL_MS) {
      return;
    }
    const fallback = task.recoveryFallback;
    if (fallback && recoveryBytes !== undefined) {
      // Forced persistence is preserving the old sibling snapshot, so its validators and URL chain
      // must remain an exact unit; never query or combine metadata from the fresh native item.
      this.journal.upsert(fallback);
      task.journalEntry = cloneJournalEntry(fallback);
      task.lastJournalAt = now;
      return;
    }
    const item = task.item;
    const safeInteger = (value: number | undefined, fallbackValue = 0): number =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0
        ? value
        : Number.isSafeInteger(fallbackValue) && fallbackValue >= 0
          ? fallbackValue
          : 0;
    const receivedBytes = safeInteger(
      recoveryBytes ?? item?.getReceivedBytes(),
      task.view.receivedBytes,
    );
    const reportedLength = safeInteger(item?.getTotalBytes());
    const knownLength = safeInteger(task.journalEntry?.length, task.view.totalBytes);
    const length = Math.max(
      receivedBytes,
      reportedLength || knownLength,
      safeInteger(task.request.expectedBytes),
    );
    const entry: DownloadJournalEntry = {
      allowedHosts: [...task.request.allowedHosts],
      allowedPathPrefixes: [...task.request.allowedPathPrefixes],
      eTag: item?.getETag() || task.journalEntry?.eTag,
      expectedBytes: task.request.expectedBytes,
      expectedSha256: task.request.expectedSha256,
      finalPath: task.request.finalPath,
      id: task.request.id,
      label: task.request.label,
      lastModified: item?.getLastModifiedTime() || task.journalEntry?.lastModified,
      length,
      maxBytes: task.request.maxBytes,
      receivedBytes,
      savePath: `${task.request.finalPath}.partial`,
      startTime: safeInteger(item?.getStartTime(), Math.floor(task.startedAt / 1000)),
      urlChain: item?.getURLChain() ?? task.journalEntry?.urlChain ?? [task.request.url],
    };
    if (fallback && entry.receivedBytes <= fallback.receivedBytes) {
      // Equal bytes do not prove that a resumed request survived validator checks. Keep the old pair
      // authoritative until the replacement generation has made real forward progress beyond it.
      return;
    }
    this.journal.upsert(entry);
    task.journalEntry = entry;
    task.lastJournalAt = now;
    if (fallback) task.recoveryFallback = undefined;
  }

  private requireActiveTask(taskId: string): ActiveDownload {
    const task = this.requireTask(taskId);
    if (task.settled) {
      throw new Error('下载任务已经结束。');
    }
    return task;
  }

  private requireTask(taskId: string): ActiveDownload {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error('下载任务不存在。');
    }
    return task;
  }

  private settleCancelled(task: ActiveDownload): void {
    if (task.settled) {
      return;
    }
    this.retry.clearStallTimer(task);
    this.retry.clearAutoResumeTimer(task);
    removePendingOwnership(task, this.pendingRestores, this.pendingByUrl);
    this.retry.detachItemListeners(task);
    task.item = undefined;
    task.requestGeneration = undefined;
    task.itemGeneration += 1;
    task.startupCreatePending = false;
    task.startupItemBindPending = false;
    task.settled = true;
    this.deletePartial(task);
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      elapsedMs: Date.now() - task.startedAt,
      errorMessage: undefined,
      finishedAt: Date.now(),
      state: 'cancelled',
    };
    // Already settled, so the teardown below must run even if the journal cannot be written.
    try {
      this.journal.remove(task.request.id);
    } catch {
      // Losing the resume record is recoverable; wedging a cancelled download is not.
    }
    task.releaseBusy();
    this.recordHistory(task.view);
    task.reject(new Error('下载已取消。'));
    this.notify();
  }

  private finishStartupCreate(task: ActiveDownload): void {
    if (this.tasks.get(task.request.id) !== task || task.settled) return;
    task.startupCreatePending = false;
    if (!task.startupItemBindPending) {
      task.startupJournalEntry = undefined;
      task.startupResumeFailed = false;
    }
  }

  private requireOperational(): void {
    if (this.disposed || this.disposing) throw new Error('下载引擎已经关闭。');
  }

  private deletePartial(task: ActiveDownload): void {
    deleteRecoveryPaths(`${task.request.finalPath}.partial`);
  }
}
