import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface DownloadJournalEntry {
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  eTag?: string;
  expectedBytes?: number;
  expectedSha256?: string;
  finalPath: string;
  id: string;
  label: string;
  lastModified?: string;
  length: number;
  maxBytes: number;
  receivedBytes: number;
  savePath: string;
  startTime: number;
  urlChain: string[];
}

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 256;
const MAX_JOURNAL_ARRAY_ITEMS = 64;
const MAX_JOURNAL_STRING_LENGTH = 16 * 1024;
const MAX_JOURNAL_URL_LENGTH = 8 * 1024;

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isBoundedString = (value: unknown, maximum = MAX_JOURNAL_STRING_LENGTH): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isSafeHttpsUrl = (value: unknown): value is string => {
  if (!isBoundedString(value, MAX_JOURNAL_URL_LENGTH)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
};

const parseEntry = (value: unknown): DownloadJournalEntry | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const entry = value as Partial<DownloadJournalEntry>;
  if (
    !Array.isArray(entry.allowedHosts) ||
    entry.allowedHosts.length === 0 ||
    entry.allowedHosts.length > MAX_JOURNAL_ARRAY_ITEMS ||
    !entry.allowedHosts.every((host) => isBoundedString(host, 255)) ||
    !Array.isArray(entry.allowedPathPrefixes) ||
    entry.allowedPathPrefixes.length === 0 ||
    entry.allowedPathPrefixes.length > MAX_JOURNAL_ARRAY_ITEMS ||
    entry.allowedHosts.length !== entry.allowedPathPrefixes.length ||
    !entry.allowedPathPrefixes.every(
      (prefix) => isBoundedString(prefix) && prefix.startsWith('/'),
    ) ||
    !isBoundedString(entry.finalPath) ||
    !path.isAbsolute(entry.finalPath) ||
    !isBoundedString(entry.id, 512) ||
    !isBoundedString(entry.label) ||
    !isSafeNonNegativeInteger(entry.length) ||
    !isSafeNonNegativeInteger(entry.maxBytes) ||
    entry.maxBytes <= 0 ||
    entry.length > entry.maxBytes ||
    !isSafeNonNegativeInteger(entry.receivedBytes) ||
    entry.receivedBytes > entry.length ||
    entry.receivedBytes > entry.maxBytes ||
    !isBoundedString(entry.savePath) ||
    !path.isAbsolute(entry.savePath) ||
    entry.savePath !== `${entry.finalPath}.partial` ||
    !isSafeNonNegativeInteger(entry.startTime) ||
    !Array.isArray(entry.urlChain) ||
    entry.urlChain.length === 0 ||
    entry.urlChain.length > MAX_JOURNAL_ARRAY_ITEMS ||
    !entry.urlChain.every((url) => isSafeHttpsUrl(url))
  ) {
    return undefined;
  }
  const expectedBytes =
    entry.expectedBytes === undefined
      ? undefined
      : isSafeNonNegativeInteger(entry.expectedBytes) &&
          entry.expectedBytes <= entry.maxBytes &&
          entry.receivedBytes <= entry.expectedBytes
        ? entry.expectedBytes
        : undefined;
  if (entry.expectedBytes !== undefined && expectedBytes === undefined) return undefined;
  const expectedSha256 =
    entry.expectedSha256 === undefined
      ? undefined
      : typeof entry.expectedSha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.expectedSha256)
        ? entry.expectedSha256.toLowerCase()
        : undefined;
  if (entry.expectedSha256 !== undefined && expectedSha256 === undefined) return undefined;
  return {
    allowedHosts: [...entry.allowedHosts],
    allowedPathPrefixes: [...entry.allowedPathPrefixes],
    eTag: typeof entry.eTag === 'string' && entry.eTag ? entry.eTag : undefined,
    expectedBytes,
    expectedSha256,
    finalPath: entry.finalPath,
    id: entry.id,
    label: entry.label,
    lastModified:
      typeof entry.lastModified === 'string' && entry.lastModified ? entry.lastModified : undefined,
    length: entry.length,
    maxBytes: entry.maxBytes,
    receivedBytes: entry.receivedBytes,
    savePath: entry.savePath,
    startTime: entry.startTime,
    urlChain: [...entry.urlChain],
  };
};

export class DownloadJournal {
  private readonly entries = new Map<string, DownloadJournalEntry>();
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storagePath = path.join(userDataPath, 'download-journal.json');
    this.load();
  }

  public list(): DownloadJournalEntry[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      allowedHosts: [...entry.allowedHosts],
      allowedPathPrefixes: [...entry.allowedPathPrefixes],
      urlChain: [...entry.urlChain],
    }));
  }

  public flush(): void {
    this.write();
  }

  public remove(id: string): void {
    if (!this.entries.has(id)) return;
    const next = new Map(this.entries);
    next.delete(id);
    this.write(next);
    this.entries.delete(id);
  }

  public replace(entries: DownloadJournalEntry[]): void {
    const next = new Map<string, DownloadJournalEntry>();
    for (const entry of entries) {
      next.set(entry.id, this.cloneEntry(entry));
    }
    this.write(next);
    this.entries.clear();
    for (const [id, entry] of next) this.entries.set(id, entry);
  }

  public upsert(entry: DownloadJournalEntry): void {
    const next = new Map(this.entries);
    next.set(entry.id, this.cloneEntry(entry));
    this.write(next);
    this.entries.set(entry.id, this.cloneEntry(entry));
  }

  private cloneEntry(entry: DownloadJournalEntry): DownloadJournalEntry {
    return {
      ...entry,
      allowedHosts: [...entry.allowedHosts],
      allowedPathPrefixes: [...entry.allowedPathPrefixes],
      urlChain: [...entry.urlChain],
    };
  }

  private write(entries = this.entries): void {
    const snapshot = [...entries.values()].map((entry) => this.cloneEntry(entry));
    if (snapshot.length > MAX_JOURNAL_ENTRIES) throw new Error('下载恢复日志条目过多。');
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES) {
      throw new Error('下载恢复日志超过安全上限。');
    }
    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, serialized, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }

  private load(): void {
    if (!existsSync(this.storagePath)) {
      return;
    }
    try {
      if (statSync(this.storagePath).size > MAX_JOURNAL_BYTES) return;
      const value = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown;
      if (!Array.isArray(value) || value.length > MAX_JOURNAL_ENTRIES) {
        return;
      }
      for (const candidate of value) {
        const entry = parseEntry(candidate);
        if (entry && !this.entries.has(entry.id)) {
          this.entries.set(entry.id, entry);
        }
      }
    } catch {
      // A corrupt journal is ignored; partial files are never executed as final artifacts.
    }
  }
}
