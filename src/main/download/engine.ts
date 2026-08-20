import type { DownloadItem, Event } from 'electron';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { DownloadTaskView } from '../../shared/contracts';
import type { BusyRegistry } from '../coordination/busy-registry';
import { DownloadHistoryStore } from './history';
import { DownloadJournal, type DownloadJournalEntry } from './journal';
import { pickFastestGitHubReleaseRoute } from './github-release-routes';
import {
  calculateDownloadProgress,
  exponentialMovingAverage,
  mapDownloadItemState,
} from './metrics';
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

interface ActiveDownload {
  /** How many automatic continuations this task has already spent. */
  autoResumeAttempts: number;
  autoResumeTimer?: ReturnType<typeof setTimeout>;
  item?: DownloadItem;
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
  /** Set when the next item bound to this task should start itself instead of waiting for the user. */
  resumeOnBind: boolean;
  settled: boolean;
  stallBytes: number;
  stallTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  view: DownloadTaskView;
}

const SPEED_SAMPLE_MINIMUM_MS = 500;
const JOURNAL_WRITE_INTERVAL_MS = 1_000;
/**
 * How long a running download may receive zero bytes before the connection is treated as dead.
 * Blocked or blackholed sockets never emit `done`, so without this the task sits at 0% forever and
 * whatever is awaiting it hangs with no way to recover.
 * Hitting the timeout no longer fails the task: it triggers an automatic continuation instead.
 */
const STALL_TIMEOUT_MS = 45_000;
/**
 * Large assets on throttled routes routinely die several times mid-transfer, each attempt moving the
 * file a few megabytes further. Retrying that many times is what turns "core download always fails"
 * into a download that eventually finishes, because every attempt resumes from the bytes on disk.
 */
const MAX_AUTO_RESUME_ATTEMPTS = 12;
const AUTO_RESUME_BASE_DELAY_MS = 1_000;
const AUTO_RESUME_MAX_DELAY_MS = 15_000;
/** Chromium clears a cancelled item's staging file asynchronously; let that land before rebinding. */
const REBIND_SETTLE_MS = 400;
/** Suffix for the prefix snapshot taken before a cancel, so cancellation cannot erase progress. */
const RESUME_SNAPSHOT_SUFFIX = '.resume';

export class DownloadEngine {
  private installed = false;
  private readonly listeners = new Set<DownloadsListener>();
  private readonly pendingByUrl = new Map<string, ActiveDownload[]>();
  private readonly pendingRestores: ActiveDownload[] = [];
  private readonly tasks = new Map<string, ActiveDownload>();
  private readonly journal: DownloadJournal;
  private readonly history: DownloadHistoryStore;

  public constructor(
    private readonly electronSession: DownloadSession,
    private readonly busyRegistry: BusyRegistry,
    private readonly userDataPath: string,
    onChange?: DownloadsListener,
  ) {
    this.journal = new DownloadJournal(userDataPath);
    this.history = new DownloadHistoryStore(userDataPath);
    if (onChange) {
      this.listeners.add(onChange);
    }
  }

  public cancel(taskId: string): DownloadTaskView {
    const task = this.requireTask(taskId);
    if (task.settled) {
      return { ...task.view };
    }
    // A cancel during an automatic continuation has no live item to stop, so settle it directly.
    const wasRetrying = task.pendingAutoResume;
    this.clearAutoResumeTimer(task);
    if (task.item && !wasRetrying) {
      task.item.cancel();
    } else {
      task.item?.cancel();
      this.settleCancelled(task);
    }
    return { ...task.view };
  }

  public install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;
    this.electronSession.on('will-download', (event, item) => {
      this.acceptItem(event, item);
    });
  }

  public flushJournal(): void {
    this.journal.flush();
  }

  public list(): DownloadTaskView[] {
    const current = [...this.tasks.values()].map(({ view }) => ({ ...view }));
    const currentIds = new Set(current.map(({ id }) => id));
    return [...current, ...this.history.list().filter(({ id }) => !currentIds.has(id))];
  }

  public clearHistory(): DownloadTaskView[] {
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
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public pause(taskId: string): DownloadTaskView {
    const task = this.requireActiveTask(taskId);
    if (!task.item || !task.view.canPause) {
      throw new Error('当前下载不能暂停。');
    }
    task.item.pause();
    this.clearStallTimer(task);
    this.updateFromItem(task, 'progressing');
    return { ...task.view };
  }

  public resume(taskId: string): DownloadTaskView {
    const task = this.requireActiveTask(taskId);
    if (task.pendingAutoResume) {
      // Asking to continue during the backoff window just runs the pending attempt right now.
      this.clearAutoResumeTimer(task);
      this.runAutoResume(task);
      return { ...task.view };
    }
    if (!task.item || !task.item.canResume()) {
      throw new Error('当前下载不能继续。');
    }
    task.item.resume();
    this.armStallTimer(task);
    this.updateFromItem(task, 'progressing');
    return { ...task.view };
  }

  public restoreInterrupted(): void {
    this.install();
    const retained: DownloadJournalEntry[] = [];
    for (const entry of this.journal.list()) {
      if (!isRecoverableEntry(this.userDataPath, entry)) {
        if (isSafePartialPath(this.userDataPath, entry.savePath)) {
          try {
            unlinkSync(entry.savePath);
          } catch {
            // Missing and locked stale partials are both safe to leave unexecutable.
          }
        }
        continue;
      }
      try {
        const { completion, task } = this.createTask(
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
        );
        void completion.catch(() => undefined);
        this.pendingRestores.push(task);
        this.electronSession.createInterruptedDownload({
          eTag: entry.eTag,
          lastModified: entry.lastModified,
          length: entry.length,
          offset: entry.receivedBytes,
          path: entry.savePath,
          startTime: entry.startTime,
          urlChain: entry.urlChain,
        });
        retained.push(entry);
      } catch {
        // An invalid or duplicate recovery record is discarded below.
      }
    }
    this.journal.replace(retained);
    this.notify();
  }

  public start(request: DownloadRequest): Promise<DownloadResult> {
    this.install();
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
    const route = await pickFastestGitHubReleaseRoute(officialUrl.toString(), (url, init) =>
      this.electronSession.fetch!(url, init),
    );
    if (!route) {
      return this.launch({ ...request, url: officialUrl.toString() });
    }
    return this.launch({
      ...request,
      allowedHosts: route.allowedHosts,
      allowedPathPrefixes: route.allowedPathPrefixes,
      label: `${request.label} · ${route.label}`,
      url: route.url,
    });
  }

  private launch(request: DownloadRequest): Promise<DownloadResult> {
    const { completion, task } = this.createTask(request);
    try {
      /*
       * `createTask` has already acquired the busy lease and registered the task, so the initial
       * journal write has to be inside this cleanup: an ENOSPC/EACCES here used to leak both. The
       * task then stayed unsettled forever (undeletable via deleteHistory, skipped by
       * clearHistory), its lease sat in the quit dialog, and because ids are version-derived every
       * retry hit "下载任务已存在".
       */
      this.persistTask(task, true);
      const pending = this.pendingByUrl.get(task.request.url) ?? [];
      pending.push(task);
      this.pendingByUrl.set(task.request.url, pending);
      this.notify();
      this.electronSession.downloadURL(task.request.url);
      this.armStallTimer(task);
    } catch (error) {
      this.fail(task, error instanceof Error ? error : new Error('无法启动下载。'));
    }
    return completion;
  }

  /**
   * (Re)starts the zero-progress watchdog. Called whenever the task makes progress or resumes, so
   * the timeout measures silence rather than total duration — a slow but live download is fine.
   */
  private armStallTimer(task: ActiveDownload): void {
    this.clearStallTimer(task);
    if (task.settled || task.pendingAutoResume) {
      return;
    }
    task.stallTimer = setTimeout(() => {
      this.scheduleAutoResume(task, `${Math.round(STALL_TIMEOUT_MS / 1000)} 秒内没有收到任何数据`);
    }, STALL_TIMEOUT_MS);
    task.stallTimer.unref?.();
  }

  /**
   * Single entry point for every recoverable interruption: stalls, resets and non-resumable aborts.
   * Progress already on disk is always preserved, so each attempt starts where the last one died.
   */
  private scheduleAutoResume(task: ActiveDownload, reason: string): void {
    if (task.settled || task.pendingAutoResume) {
      return;
    }
    this.clearStallTimer(task);
    if (task.autoResumeAttempts >= MAX_AUTO_RESUME_ATTEMPTS) {
      // The journal is kept so the next app start can still offer to continue from these bytes.
      this.fail(
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
    this.notify();
    task.autoResumeTimer = setTimeout(() => {
      this.runAutoResume(task);
    }, delay);
    task.autoResumeTimer.unref?.();
  }

  private runAutoResume(task: ActiveDownload): void {
    if (task.settled) {
      return;
    }
    const item = task.item;
    if (item && item.getState() === 'interrupted' && item.canResume()) {
      // Chromium still owns a resumable request: continuing it re-issues a ranged GET by itself.
      task.pendingAutoResume = false;
      item.resume();
      task.view = {
        ...task.view,
        canPause: true,
        canResume: false,
        errorMessage: undefined,
        state: 'progressing',
      };
      this.armStallTimer(task);
      this.notify();
      return;
    }
    this.rebindFromDisk(task);
  }

  /**
   * Drops the current item and rebuilds the request from whatever is already on disk. A cancel wipes
   * Chromium's staging file, so a prefix snapshot is taken first — downloads only ever append, which
   * makes any prefix a valid resume point even if the copy races the writer.
   */
  private rebindFromDisk(task: ActiveDownload): void {
    const savePath = `${task.request.finalPath}.partial`;
    const snapshotPath = `${savePath}${RESUME_SNAPSHOT_SUFFIX}`;
    let offset = 0;
    try {
      copyFileSync(savePath, snapshotPath);
      offset = statSync(snapshotPath).size;
    } catch {
      offset = 0;
    }
    const item = task.item;
    task.item = undefined;
    if (item && item.getState() !== 'completed' && item.getState() !== 'cancelled') {
      item.cancel();
    }
    task.autoResumeTimer = setTimeout(() => {
      this.relaunchFromSnapshot(task, savePath, snapshotPath, offset);
    }, REBIND_SETTLE_MS);
    task.autoResumeTimer.unref?.();
  }

  private relaunchFromSnapshot(
    task: ActiveDownload,
    savePath: string,
    snapshotPath: string,
    snapshotBytes: number,
  ): void {
    if (task.settled) {
      return;
    }
    task.pendingAutoResume = false;
    let offset = snapshotBytes;
    try {
      if (existsSync(snapshotPath)) {
        if (existsSync(savePath)) {
          unlinkSync(savePath);
        }
        renameSync(snapshotPath, savePath);
      } else {
        offset = 0;
      }
    } catch {
      offset = 0;
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
      this.pendingRestores.push(task);
      try {
        this.electronSession.createInterruptedDownload({
          eTag: entry.eTag,
          lastModified: entry.lastModified,
          length: entry.length,
          offset,
          path: savePath,
          startTime: entry.startTime,
          urlChain: entry.urlChain,
        });
        this.armStallTimer(task);
        this.notify();
        return;
      } catch {
        // A rejected recovery record just means this attempt starts over from the original URL.
        const index = this.pendingRestores.indexOf(task);
        if (index >= 0) {
          this.pendingRestores.splice(index, 1);
        }
      }
    }

    this.deletePartial(task);
    task.restored = false;
    task.resumeOnBind = false;
    task.lastSampleAt = Date.now();
    task.lastSampleBytes = 0;
    task.stallBytes = 0;
    task.view = { ...task.view, bytesPerSecond: 0, percent: -1, receivedBytes: 0, state: 'queued' };
    const pending = this.pendingByUrl.get(task.request.url) ?? [];
    pending.push(task);
    this.pendingByUrl.set(task.request.url, pending);
    this.notify();
    try {
      this.electronSession.downloadURL(task.request.url);
      this.armStallTimer(task);
    } catch (error) {
      this.fail(task, error instanceof Error ? error : new Error('无法重新启动下载。'));
    }
  }

  private clearAutoResumeTimer(task: ActiveDownload): void {
    if (task.autoResumeTimer) {
      clearTimeout(task.autoResumeTimer);
      task.autoResumeTimer = undefined;
    }
    task.pendingAutoResume = false;
  }

  private clearStallTimer(task: ActiveDownload): void {
    if (task.stallTimer) {
      clearTimeout(task.stallTimer);
      task.stallTimer = undefined;
    }
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
    const task: ActiveDownload = {
      autoResumeAttempts: 0,
      journalEntry,
      lastJournalAt: 0,
      lastSampleAt: startedAt,
      lastSampleBytes: journalEntry?.receivedBytes ?? 0,
      pendingAutoResume: false,
      reject,
      releaseBusy,
      request: { ...request },
      resolve,
      restored: Boolean(journalEntry),
      resumeOnBind: false,
      settled: false,
      stallBytes: journalEntry?.receivedBytes ?? 0,
      startedAt,
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
    const task = this.claimPendingTask(item);
    if (!task || task.settled) {
      event.preventDefault();
      return;
    }
    if (!item.getURLChain().every((candidate) => isAllowedUrl(task.request, candidate))) {
      item.cancel();
      this.fail(task, new Error('下载重定向链包含未获允许的来源，任务已取消。'));
      return;
    }
    task.item = item;
    item.setSavePath(`${task.request.finalPath}.partial`);
    if (item.getTotalBytes() > task.request.maxBytes) {
      item.cancel();
      this.deletePartial(task);
      this.fail(task, new Error('下载内容超过安全上限，文件已删除。'));
      return;
    }
    this.updateFromItem(task, task.restored ? 'interrupted' : 'progressing');
    item.on('updated', (_updatedEvent, state) => {
      // A rebound task keeps older items alive for a moment; only the current one owns the view.
      if (task.item !== item) {
        return;
      }
      this.updateFromItem(task, state);
    });
    item.on('done', (_doneEvent, state) => {
      if (task.item !== item) {
        return;
      }
      if (state === 'completed') {
        void this.complete(task);
      } else if (state === 'cancelled') {
        this.settleCancelled(task);
      } else if (item.canResume()) {
        this.updateFromItem(task, 'interrupted');
        this.scheduleAutoResume(task, '连接已中断');
      } else {
        // Chromium discarded its staging file, so the next attempt starts over from the source.
        this.scheduleAutoResume(task, '连接已中断且无法就地续传');
      }
    });
    if (task.resumeOnBind) {
      task.resumeOnBind = false;
      if (item.canResume()) {
        item.resume();
        this.armStallTimer(task);
      }
    }
  }

  /**
   * Electron may report the final redirected asset URL from DownloadItem#getURL even though
   * downloadURL was called with the original GitHub release URL. Match every normalized hop in the
   * item URL chain so a legitimate redirect is not mistaken for an unrelated browser download and
   * cancelled before its first byte arrives.
   */
  private claimPendingTask(item: DownloadItem): ActiveDownload | undefined {
    const candidates: string[] = [];
    for (const candidate of [item.getURL(), ...item.getURLChain()]) {
      try {
        const normalized = new URL(candidate).toString();
        if (!candidates.includes(normalized)) {
          candidates.push(normalized);
        }
      } catch {
        // Invalid redirect hops fail the whitelist check if a task is otherwise claimed.
      }
    }
    for (const candidate of candidates) {
      const pending = this.pendingByUrl.get(candidate);
      const task = pending?.shift();
      if (pending?.length === 0) {
        this.pendingByUrl.delete(candidate);
      }
      if (task) {
        return task;
      }
    }
    const restoredIndex = this.pendingRestores.findIndex((task) => {
      const knownUrls = [task.request.url, ...(task.journalEntry?.urlChain ?? [])];
      return knownUrls.some((known) => {
        try {
          return candidates.includes(new URL(known).toString());
        } catch {
          return false;
        }
      });
    });
    return restoredIndex >= 0 ? this.pendingRestores.splice(restoredIndex, 1)[0] : undefined;
  }

  private async complete(task: ActiveDownload): Promise<void> {
    if (task.settled) {
      return;
    }
    this.clearStallTimer(task);
    this.clearAutoResumeTimer(task);
    try {
      task.view = {
        ...task.view,
        canPause: false,
        canResume: false,
        state: 'verifying',
      };
      this.notify();
      await verifyPartial(task.request);
      try {
        if (existsSync(task.request.finalPath)) {
          unlinkSync(task.request.finalPath);
        }
        renameSync(`${task.request.finalPath}.partial`, task.request.finalPath);
      } catch (error) {
        /*
         * Verification already passed, so these bytes are known-good. A failed replace (routine
         * EPERM/EBUSY on Windows while a scanner holds a handle) must not fall into the catch below
         * and delete them — that used to lose the old file AND the new one, drop the journal entry,
         * and blame verification for a failure that never happened. Keeping the partial plus its
         * journal entry leaves the download resumable.
         */
        const detail = error instanceof Error ? error.message : '未知错误。';
        this.fail(
          task,
          new Error(`校验已通过，但替换目标文件失败，已保留下载内容：${detail}`),
          true,
        );
        return;
      }
      task.settled = true;
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
      this.journal.remove(task.request.id);
      this.recordHistory(task.view);
      task.releaseBusy();
      task.resolve({ filePath: task.request.finalPath, id: task.request.id });
      this.notify();
    } catch (error) {
      this.deletePartial(task);
      const detail = error instanceof Error ? error.message : '无法校验下载文件。';
      this.fail(task, new Error(`校验未通过，文件已删除：${detail}`));
    }
  }

  private fail(task: ActiveDownload, error: Error, preserveJournal = false): void {
    if (task.settled) {
      return;
    }
    this.clearStallTimer(task);
    this.clearAutoResumeTimer(task);
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
        this.persistTask(task, true);
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
    const snapshot = this.list();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private recordHistory(view: DownloadTaskView): void {
    try {
      this.history.upsert(view);
    } catch {
      // History is useful metadata, but a write failure must not change download integrity/result.
    }
  }

  private persistTask(task: ActiveDownload, force = false): void {
    if (task.view.state === 'cancelled' || task.view.state === 'completed') {
      return;
    }
    const now = Date.now();
    if (!force && now - task.lastJournalAt < JOURNAL_WRITE_INTERVAL_MS) {
      return;
    }
    const item = task.item;
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
      length: Math.max(0, item?.getTotalBytes() ?? task.view.totalBytes),
      maxBytes: task.request.maxBytes,
      receivedBytes: Math.max(0, item?.getReceivedBytes() ?? task.view.receivedBytes),
      savePath: `${task.request.finalPath}.partial`,
      startTime: item?.getStartTime() || task.startedAt / 1000,
      urlChain: item?.getURLChain() ?? task.journalEntry?.urlChain ?? [task.request.url],
    };
    task.journalEntry = entry;
    task.lastJournalAt = now;
    this.journal.upsert(entry);
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
    this.clearStallTimer(task);
    this.clearAutoResumeTimer(task);
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
    this.journal.remove(task.request.id);
    task.releaseBusy();
    this.recordHistory(task.view);
    task.reject(new Error('下载已取消。'));
    this.notify();
  }

  private updateFromItem(task: ActiveDownload, state: 'interrupted' | 'progressing'): void {
    if (task.settled || !task.item) {
      return;
    }
    const now = Date.now();
    const receivedBytes = Math.max(0, task.item.getReceivedBytes());
    if (
      receivedBytes > task.request.maxBytes ||
      task.item.getTotalBytes() > task.request.maxBytes
    ) {
      task.item.cancel();
      this.deletePartial(task);
      this.fail(task, new Error('下载内容超过安全上限，文件已删除。'));
      return;
    }
    if (task.restored && receivedBytes < task.lastSampleBytes) {
      task.restored = false;
      task.view.errorMessage = '服务端文件已更新，已重新开始下载。';
    }
    if (receivedBytes !== task.stallBytes) {
      task.stallBytes = receivedBytes;
      this.armStallTimer(task);
    } else if (task.item.isPaused()) {
      this.clearStallTimer(task);
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
    const totalBytes = Math.max(0, task.item.getTotalBytes());
    const progress = calculateDownloadProgress(receivedBytes, totalBytes, task.view.bytesPerSecond);
    const mappedState = mapDownloadItemState(state, task.item.isPaused(), task.item.canResume());
    task.view = {
      ...task.view,
      ...progress,
      canPause: mappedState === 'progressing',
      canResume: mappedState === 'paused' && task.item.canResume(),
      elapsedMs: now - task.startedAt,
      receivedBytes,
      state: mappedState,
      totalBytes,
    };
    if (mappedState === 'failed') {
      this.scheduleAutoResume(task, '连接已中断');
      return;
    }
    this.persistTask(task);
    this.notify();
  }

  private deletePartial(task: ActiveDownload): void {
    for (const suffix of ['.partial', `.partial${RESUME_SNAPSHOT_SUFFIX}`]) {
      try {
        unlinkSync(`${task.request.finalPath}${suffix}`);
      } catch {
        // Queued cancellation and Chromium cleanup can both leave no partial file.
      }
    }
  }
}
