import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DownloadTaskView } from '../shared/contracts';

const HISTORY_VERSION = 1;
const MAX_HISTORY_ENTRIES = 100;
const SETTLED_STATES = new Set<DownloadTaskView['state']>(['cancelled', 'completed', 'failed']);

interface StoredDownloadHistory {
  entries: DownloadTaskView[];
  version: number;
}

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseEntry = (value: unknown): DownloadTaskView | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Partial<DownloadTaskView>;
  if (
    typeof entry.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(entry.id) ||
    typeof entry.label !== 'string' ||
    entry.label.length === 0 ||
    entry.label.length > 240 ||
    typeof entry.state !== 'string' ||
    !SETTLED_STATES.has(entry.state as DownloadTaskView['state']) ||
    !finiteNumber(entry.bytesPerSecond) ||
    !finiteNumber(entry.elapsedMs) ||
    !finiteNumber(entry.percent) ||
    !finiteNumber(entry.receivedBytes) ||
    !finiteNumber(entry.remainingMs) ||
    !finiteNumber(entry.totalBytes) ||
    !finiteNumber(entry.startedAt) ||
    !finiteNumber(entry.finishedAt)
  ) {
    return undefined;
  }
  return {
    bytesPerSecond: Math.max(0, entry.bytesPerSecond),
    canPause: false,
    canResume: false,
    elapsedMs: Math.max(0, entry.elapsedMs),
    errorMessage:
      typeof entry.errorMessage === 'string' && entry.errorMessage.length <= 1_000
        ? entry.errorMessage
        : undefined,
    finishedAt: entry.finishedAt,
    id: entry.id,
    label: entry.label,
    percent: entry.percent,
    receivedBytes: Math.max(0, entry.receivedBytes),
    remainingMs: entry.remainingMs,
    startedAt: entry.startedAt,
    state: entry.state as DownloadTaskView['state'],
    totalBytes: Math.max(0, entry.totalBytes),
  };
};

export class DownloadHistoryStore {
  private readonly entries = new Map<string, DownloadTaskView>();
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storagePath = path.join(userDataPath, 'download-history.json');
    this.load();
  }

  public clear(): number {
    const removed = this.entries.size;
    if (removed > 0) {
      this.entries.clear();
      this.write();
    }
    return removed;
  }

  public list(): DownloadTaskView[] {
    return [...this.entries.values()]
      .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))
      .map((entry) => ({ ...entry }));
  }

  public remove(id: string): boolean {
    const removed = this.entries.delete(id);
    if (removed) this.write();
    return removed;
  }

  public upsert(entry: DownloadTaskView): void {
    const parsed = parseEntry(entry);
    if (!parsed) throw new Error('下载历史记录无效。');
    this.entries.delete(parsed.id);
    this.entries.set(parsed.id, parsed);
    const retained = this.list().slice(0, MAX_HISTORY_ENTRIES);
    this.entries.clear();
    for (const item of retained) this.entries.set(item.id, item);
    this.write();
  }

  private load(): void {
    if (!existsSync(this.storagePath)) return;
    try {
      const stored = JSON.parse(
        readFileSync(this.storagePath, 'utf8'),
      ) as Partial<StoredDownloadHistory>;
      if (stored.version !== HISTORY_VERSION || !Array.isArray(stored.entries)) return;
      for (const candidate of stored.entries.slice(0, MAX_HISTORY_ENTRIES)) {
        const entry = parseEntry(candidate);
        if (entry) this.entries.set(entry.id, entry);
      }
    } catch {
      // A corrupt history file is ignored; it never contains executable paths or download bytes.
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    const payload: StoredDownloadHistory = {
      entries: this.list(),
      version: HISTORY_VERSION,
    };
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
