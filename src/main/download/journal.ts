import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const parseEntry = (value: unknown): DownloadJournalEntry | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const entry = value as Partial<DownloadJournalEntry>;
  if (
    !Array.isArray(entry.allowedHosts) ||
    entry.allowedHosts.length === 0 ||
    !entry.allowedHosts.every((host) => typeof host === 'string' && host.length > 0) ||
    !Array.isArray(entry.allowedPathPrefixes) ||
    entry.allowedPathPrefixes.length === 0 ||
    entry.allowedHosts.length !== entry.allowedPathPrefixes.length ||
    !entry.allowedPathPrefixes.every(
      (prefix) => typeof prefix === 'string' && prefix.startsWith('/'),
    ) ||
    typeof entry.finalPath !== 'string' ||
    !path.isAbsolute(entry.finalPath) ||
    typeof entry.id !== 'string' ||
    !entry.id ||
    typeof entry.label !== 'string' ||
    !entry.label ||
    !isNonNegativeNumber(entry.length) ||
    !isNonNegativeNumber(entry.maxBytes) ||
    entry.maxBytes <= 0 ||
    !isNonNegativeNumber(entry.receivedBytes) ||
    typeof entry.savePath !== 'string' ||
    !path.isAbsolute(entry.savePath) ||
    entry.savePath !== `${entry.finalPath}.partial` ||
    !isNonNegativeNumber(entry.startTime) ||
    !Array.isArray(entry.urlChain) ||
    entry.urlChain.length === 0 ||
    !entry.urlChain.every((url) => typeof url === 'string' && url.startsWith('https://'))
  ) {
    return undefined;
  }
  const expectedBytes = isNonNegativeNumber(entry.expectedBytes) ? entry.expectedBytes : undefined;
  const expectedSha256 =
    typeof entry.expectedSha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.expectedSha256)
      ? entry.expectedSha256.toLowerCase()
      : undefined;
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
    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    const snapshot = [...entries.values()].map((entry) => this.cloneEntry(entry));
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
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
      const value = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown;
      if (!Array.isArray(value)) {
        return;
      }
      for (const candidate of value) {
        const entry = parseEntry(candidate);
        if (entry) {
          this.entries.set(entry.id, entry);
        }
      }
    } catch {
      // A corrupt journal is ignored; partial files are never executed as final artifacts.
    }
  }
}
