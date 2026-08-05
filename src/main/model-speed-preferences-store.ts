import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelSpeedMode } from '../shared/contracts';

interface StoredModelSpeedEntry {
  mode: ModelSpeedMode;
  updatedAt: number;
}

interface StoredModelSpeedPreferences {
  entries: Record<string, StoredModelSpeedEntry>;
  version: 1;
}

export interface ModelSpeedPreference {
  mode: ModelSpeedMode;
  source: 'default' | 'user';
}

const EMPTY_STORE: StoredModelSpeedPreferences = { entries: {}, version: 1 };
const TARGET_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 400;
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80] as const;
const renameRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let nextTemporaryFileId = 0;

const isRetryableRenameError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'EACCES' || error.code === 'EBUSY' || error.code === 'EPERM');

const renameWithRetry = (temporaryPath: string, storagePath: string): void => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporaryPath, storagePath);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!isRetryableRenameError(error) || delay === undefined) {
        throw error;
      }
      Atomics.wait(renameRetrySignal, 0, 0, delay);
    }
  }
};

const sanitizeMode = (value: unknown): ModelSpeedMode | undefined =>
  value === 'fast' || value === 'standard' ? value : undefined;

/** Remembers serving speed independently for every credential-free route and model identity. */
export class ModelSpeedPreferencesStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'model-speed-preferences.json');
  }

  public get(targetKey: string): ModelSpeedPreference {
    if (!TARGET_KEY_PATTERN.test(targetKey)) {
      return { mode: 'standard', source: 'default' };
    }
    const entry = this.load().entries[targetKey];
    return entry ? { mode: entry.mode, source: 'user' } : { mode: 'standard', source: 'default' };
  }

  public set(targetKey: string, mode: ModelSpeedMode): ModelSpeedPreference {
    if (!TARGET_KEY_PATTERN.test(targetKey) || !sanitizeMode(mode)) {
      throw new Error('模型速度偏好无效。');
    }
    const store = this.load();
    const current = store.entries[targetKey];
    if (current?.mode === mode) {
      return { mode, source: 'user' };
    }
    delete store.entries[targetKey];
    store.entries[targetKey] = { mode, updatedAt: Date.now() };
    this.persist(store);
    return { mode, source: 'user' };
  }

  private load(): StoredModelSpeedPreferences {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        entries?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        return structuredClone(EMPTY_STORE);
      }
      const entries: Record<string, StoredModelSpeedEntry> = {};
      for (const [key, raw] of Object.entries(parsed.entries)) {
        if (!TARGET_KEY_PATTERN.test(key) || !raw || typeof raw !== 'object') {
          continue;
        }
        const entry = raw as Partial<StoredModelSpeedEntry>;
        const mode = sanitizeMode(entry.mode);
        if (!mode || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) {
          continue;
        }
        entries[key] = { mode, updatedAt: entry.updatedAt };
      }
      return { entries, version: 1 };
    } catch {
      return structuredClone(EMPTY_STORE);
    }
  }

  private persist(store: StoredModelSpeedPreferences): void {
    const entries = Object.entries(store.entries)
      .map(([key, entry], index) => ({ entry, index, key }))
      .sort(
        (left, right) => left.entry.updatedAt - right.entry.updatedAt || left.index - right.index,
      )
      .slice(-MAX_ENTRIES)
      .map(({ entry, key }) => [key, entry] as const);
    mkdirSync(this.storageDirectory, { recursive: true });
    nextTemporaryFileId =
      nextTemporaryFileId >= Number.MAX_SAFE_INTEGER ? 1 : nextTemporaryFileId + 1;
    const temporaryPath = `${this.storagePath}.tmp-${process.pid}-${Date.now()}-${nextTemporaryFileId}`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ entries: Object.fromEntries(entries), version: 1 }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    try {
      renameWithRetry(temporaryPath, this.storagePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
