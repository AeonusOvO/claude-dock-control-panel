import type { DownloadItem, Event } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { DownloadTaskState, DownloadTaskView } from '../shared/contracts';
import type { BusyRegistry } from './busy-registry';
import { DownloadJournal, type DownloadJournalEntry } from './download-journal';

export interface DownloadRequest {
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  expectedBytes?: number;
  expectedSha256?: string;
  finalPath: string;
  id: string;
  label: string;
  maxBytes: number;
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
    if (!this.isAllowedUrl(request, url)) {
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
    const existing = this.tasks.get(request.id);
    if (existing?.settled) {
      this.tasks.delete(request.id);
    } else if (existing) {
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
    if (!item.getURLChain().every((candidate) => this.isAllowedUrl(task.request, candidate))) {
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
      this.updateFromItem(task, state);
    });
    item.on('done', (_doneEvent, state) => {
      if (state === 'completed') {
        void this.complete(task);
      } else if (state === 'cancelled') {
        this.settleCancelled(task);
      } else if (item.canResume()) {
        this.updateFromItem(task, 'interrupted');
      } else {
        this.fail(task, new Error('下载已中断，且服务器不支持继续下载。'));
      }
    });
  }

  private async complete(task: ActiveDownload): Promise<void> {
    if (task.settled) {
      return;
    }
    try {
      task.view = {
        ...task.view,
        canPause: false,
        canResume: false,
        state: 'verifying',
      };
      this.notify();
      await this.verifyPartial(task);
      if (existsSync(task.request.finalPath)) {
        unlinkSync(task.request.finalPath);
      }
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
      this.deletePartial(task);
      const detail = error instanceof Error ? error.message : '无法校验下载文件。';
      this.fail(task, new Error(`校验未通过，文件已删除：${detail}`));
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

  private isAllowedUrl(request: DownloadRequest, candidate: string | URL): boolean {
    try {
      const url = candidate instanceof URL ? candidate : new URL(candidate);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        request.allowedHosts.some(
          (host, index) =>
            host === url.hostname &&
            url.pathname.startsWith(request.allowedPathPrefixes[index] ?? ''),
        )
      );
    } catch {
      return false;
    }
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
    task.settled = true;
    this.deletePartial(task);
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
    if (receivedBytes > task.request.maxBytes || task.item.getTotalBytes() > task.request.maxBytes) {
      task.item.cancel();
      this.deletePartial(task);
      this.fail(task, new Error('下载内容超过安全上限，文件已删除。'));
      return;
    }
    if (task.restored && receivedBytes < task.lastSampleBytes) {
      task.restored = false;
      task.view.errorMessage = '服务端文件已更新，已重新开始下载。';
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

  private deletePartial(task: ActiveDownload): void {
    try {
      unlinkSync(`${task.request.finalPath}.partial`);
    } catch {
      // Queued cancellation and Chromium cleanup can both leave no partial file.
    }
  }

  private async verifyPartial(task: ActiveDownload): Promise<void> {
    const partialPath = `${task.request.finalPath}.partial`;
    const actualBytes = statSync(partialPath).size;
    if (actualBytes > task.request.maxBytes) {
      throw new Error('下载内容超过安全上限。');
    }
    if (task.request.expectedBytes !== undefined && actualBytes !== task.request.expectedBytes) {
      throw new Error('文件字节数与发布信息不一致。');
    }
    if (task.request.expectedSha256) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(partialPath)) {
        hash.update(chunk);
      }
      if (hash.digest('hex') !== task.request.expectedSha256.toLowerCase()) {
        throw new Error('SHA-256 与发布信息不一致。');
      }
    }
  }
}
