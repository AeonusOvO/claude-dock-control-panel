import type { DownloadItem, Event } from 'electron';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { DownloadTaskState, DownloadTaskView } from '../shared/contracts';
import type { BusyRegistry } from './busy-registry';
import { DownloadJournal, type DownloadJournalEntry } from './download-journal';

export interface DownloadRequest {
  expectedBytes?: number;
  expectedSha256?: string;
  finalPath: string;
  id: string;
  label: string;
  url: string;
}

export interface DownloadResult {
  filePath: string;
  id: string;
}

export type DownloadsListener = (tasks: DownloadTaskView[]) => void;

export interface DownloadSession {
  createInterruptedDownload: (options: {
    eTag?: string;
    lastModified?: string;
    length: number;
    offset: number;
    path: string;
    startTime?: number;
    urlChain: string[];
  }) => void;
  downloadURL: (url: string) => void;
  on: (
    event: 'will-download',
    listener: (event: Event, item: DownloadItem) => void,
  ) => unknown;
}

interface ActiveDownload {
  item?: DownloadItem;
  journalEntry?: DownloadJournalEntry;
  lastJournalAt: number;
  lastSampleAt: number;
  lastSampleBytes: number;
  releaseBusy: () => void;
  reject: (error: Error) => void;
  request: DownloadRequest;
  resolve: (result: DownloadResult) => void;
  restored: boolean;
  settled: boolean;
  startedAt: number;
  view: DownloadTaskView;
}

const SPEED_EMA_ALPHA = 0.3;
const SPEED_SAMPLE_MINIMUM_MS = 500;
const JOURNAL_WRITE_INTERVAL_MS = 1_000;

export const exponentialMovingAverage = (
  previous: number,
  deltaBytes: number,
  deltaMs: number,
  alpha = SPEED_EMA_ALPHA,
): number => {
  if (deltaBytes < 0 || deltaMs <= 0 || alpha <= 0 || alpha > 1) {
    return Math.max(0, previous);
  }
  const instantaneous = (deltaBytes * 1000) / deltaMs;
  return previous > 0 ? alpha * instantaneous + (1 - alpha) * previous : instantaneous;
};

export const calculateDownloadProgress = (
  receivedBytes: number,
  totalBytes: number,
  bytesPerSecond: number,
): Pick<DownloadTaskView, 'percent' | 'remainingMs'> => {
  if (totalBytes <= 0) {
    return { percent: -1, remainingMs: -1 };
  }
  const percent = Math.min(100, Math.max(0, (receivedBytes / totalBytes) * 100));
  const remainingMs =
    bytesPerSecond > 0
      ? Math.max(0, ((totalBytes - receivedBytes) / bytesPerSecond) * 1000)
      : -1;
  return { percent, remainingMs };
};

export const mapDownloadItemState = (
  state: 'interrupted' | 'progressing',
  paused: boolean,
  canResume: boolean,
): DownloadTaskState => {
  if (state === 'progressing') {
    return paused ? 'paused' : 'progressing';
  }
  return canResume ? 'paused' : 'failed';
};

export class DownloadEngine {
  private installed = false;
  private readonly listeners = new Set<DownloadsListener>();
  private readonly pendingByUrl = new Map<string, ActiveDownload[]>();
  private readonly pendingRestores: ActiveDownload[] = [];
  private readonly tasks = new Map<string, ActiveDownload>();
  private readonly journal: DownloadJournal;

  public constructor(
    private readonly electronSession: DownloadSession,
    private readonly busyRegistry: BusyRegistry,
    private readonly userDataPath: string,
    onChange?: DownloadsListener,
  ) {
    this.journal = new DownloadJournal(userDataPath);
    if (onChange) {
      this.listeners.add(onChange);
    }
  }

  public cancel(taskId: string): DownloadTaskView {
    const task = this.requireTask(taskId);
    if (task.settled) {
      return { ...task.view };
    }
    if (task.item) {
      task.item.cancel();
    } else {
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
    return [...this.tasks.values()].map(({ view }) => ({ ...view }));
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
    this.updateFromItem(task, 'progressing');
    return { ...task.view };
  }

  public resume(taskId: string): DownloadTaskView {
    const task = this.requireActiveTask(taskId);
    if (!task.item || !task.item.canResume()) {
      throw new Error('当前下载不能继续。');
    }
    task.item.resume();
    this.updateFromItem(task, 'progressing');
    return { ...task.view };
  }

  public restoreInterrupted(): void {
    this.install();
    const retained: DownloadJournalEntry[] = [];
    for (const entry of this.journal.list()) {
      if (!this.isRecoverableEntry(entry)) {
        if (this.isSafePartialPath(entry.savePath)) {
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
            expectedBytes: entry.expectedBytes,
            expectedSha256: entry.expectedSha256,
            finalPath: entry.finalPath,
            id: entry.id,
            label: entry.label,
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
    if (!this.isPathWithinUserData(request.finalPath)) {
      throw new Error('下载目标必须位于 ClaudeDock 用户数据目录。');
    }
    const { completion, task } = this.createTask({ ...request, url: url.toString() });
    this.persistTask(task, true);
    const pending = this.pendingByUrl.get(task.request.url) ?? [];
    pending.push(task);
    this.pendingByUrl.set(task.request.url, pending);
    this.notify();
    try {
      this.electronSession.downloadURL(task.request.url);
    } catch (error) {
      this.fail(task, error instanceof Error ? error : new Error('无法启动下载。'));
    }
    return completion;
  }

  private createTask(
    request: DownloadRequest,
    journalEntry?: DownloadJournalEntry,
  ): { completion: Promise<DownloadResult>; task: ActiveDownload } {
    if (this.tasks.has(request.id)) {
      throw new Error(`下载任务 ${request.id} 已存在。`);
    }
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
      journalEntry,
      lastJournalAt: 0,
      lastSampleAt: startedAt,
      lastSampleBytes: journalEntry?.receivedBytes ?? 0,
      reject,
      releaseBusy,
      request: { ...request },
      resolve,
      restored: Boolean(journalEntry),
      settled: false,
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
    const url = new URL(item.getURL()).toString();
    const pending = this.pendingByUrl.get(url);
    const task = pending?.shift() ?? this.pendingRestores.shift();
    if (pending?.length === 0) {
      this.pendingByUrl.delete(url);
    }
    if (!task || task.settled) {
      event.preventDefault();
      return;
    }
    task.item = item;
    item.setSavePath(`${task.request.finalPath}.partial`);
    this.updateFromItem(task, task.restored ? 'interrupted' : 'progressing');
    item.on('updated', (_updatedEvent, state) => {
      this.updateFromItem(task, state);
    });
    item.on('done', (_doneEvent, state) => {
      if (state === 'completed') {
        this.complete(task);
      } else if (state === 'cancelled') {
        this.settleCancelled(task);
      } else if (item.canResume()) {
        this.updateFromItem(task, 'interrupted');
      } else {
        this.fail(task, new Error('下载已中断，且服务器不支持继续下载。'));
      }
    });
  }

  private complete(task: ActiveDownload): void {
    if (task.settled) {
      return;
    }
    try {
      renameSync(`${task.request.finalPath}.partial`, task.request.finalPath);
      task.settled = true;
      task.view = {
        ...task.view,
        canPause: false,
        canResume: false,
        elapsedMs: Date.now() - task.startedAt,
        percent: 100,
        remainingMs: 0,
        state: 'completed',
      };
      this.journal.remove(task.request.id);
      task.releaseBusy();
      task.resolve({ filePath: task.request.finalPath, id: task.request.id });
      this.notify();
    } catch (error) {
      this.fail(task, error instanceof Error ? error : new Error('无法保存下载文件。'));
    }
  }

  private fail(task: ActiveDownload, error: Error, preserveJournal = false): void {
    if (task.settled) {
      return;
    }
    task.settled = true;
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      elapsedMs: Date.now() - task.startedAt,
      errorMessage: error.message,
      state: 'failed',
    };
    if (preserveJournal) {
      this.persistTask(task, true);
    } else {
      this.journal.remove(task.request.id);
    }
    task.releaseBusy();
    task.reject(error);
    this.notify();
  }

  private notify(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private isPathWithinUserData(candidate: string): boolean {
    const relative = path.relative(path.resolve(this.userDataPath), path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private isRecoverableEntry(entry: DownloadJournalEntry): boolean {
    if (
      !this.isPathWithinUserData(entry.finalPath) ||
      !this.isSafePartialPath(entry.savePath) ||
      !existsSync(entry.savePath)
    ) {
      return false;
    }
    try {
      return statSync(entry.savePath).size === entry.receivedBytes;
    } catch {
      return false;
    }
  }

  private isSafePartialPath(candidate: string): boolean {
    return this.isPathWithinUserData(candidate) && candidate.endsWith('.partial');
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
      eTag: item?.getETag() || task.journalEntry?.eTag,
      expectedBytes: task.request.expectedBytes,
      expectedSha256: task.request.expectedSha256,
      finalPath: task.request.finalPath,
      id: task.request.id,
      label: task.request.label,
      lastModified: item?.getLastModifiedTime() || task.journalEntry?.lastModified,
      length: Math.max(0, item?.getTotalBytes() ?? task.view.totalBytes),
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
    task.settled = true;
    try {
      unlinkSync(`${task.request.finalPath}.partial`);
    } catch {
      // A queued cancellation or Chromium cleanup may leave no partial file.
    }
    task.view = {
      ...task.view,
      canPause: false,
      canResume: false,
      elapsedMs: Date.now() - task.startedAt,
      errorMessage: undefined,
      state: 'cancelled',
    };
    this.journal.remove(task.request.id);
    task.releaseBusy();
    task.reject(new Error('下载已取消。'));
    this.notify();
  }

  private updateFromItem(
    task: ActiveDownload,
    state: 'interrupted' | 'progressing',
  ): void {
    if (task.settled || !task.item) {
      return;
    }
    const now = Date.now();
    const receivedBytes = Math.max(0, task.item.getReceivedBytes());
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
    const progress = calculateDownloadProgress(
      receivedBytes,
      totalBytes,
      task.view.bytesPerSecond,
    );
    const mappedState = mapDownloadItemState(
      state,
      task.item.isPaused(),
      task.item.canResume(),
    );
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
      this.fail(task, new Error('下载已中断；重启 ClaudeDock 后可以从日志尝试恢复。'), true);
      return;
    }
    this.persistTask(task);
    this.notify();
  }
}
