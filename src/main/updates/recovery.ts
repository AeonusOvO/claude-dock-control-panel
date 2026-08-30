import {
  closeSync,
  existsSync,
  mkdirSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface ApplicationUpdateRecoveryRecord {
  currentVersion: string;
  createdAt: number;
  phase: 'installing';
  source: 'electron-updater';
  targetVersion: string;
}

export interface ApplicationUpdateRecoveryStore {
  clear: () => void;
  read: () => ApplicationUpdateRecoveryRecord | undefined;
  write: (record: ApplicationUpdateRecoveryRecord) => void;
}

const RECOVERY_FILE_NAME = 'application-update-recovery.json';

const isValidRecord = (value: unknown): value is ApplicationUpdateRecoveryRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ApplicationUpdateRecoveryRecord>;
  return (
    typeof record.currentVersion === 'string' &&
    record.currentVersion.length > 0 &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    record.createdAt > 0 &&
    record.phase === 'installing' &&
    record.source === 'electron-updater' &&
    typeof record.targetVersion === 'string' &&
    record.targetVersion.length > 0
  );
};

/** A small atomic marker: it is written before any quit/installer side effect and cleared on success. */
export class ApplicationUpdateRecoveryJournal implements ApplicationUpdateRecoveryStore {
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storagePath = path.join(userDataPath, RECOVERY_FILE_NAME);
  }

  public clear(): void {
    try {
      unlinkSync(this.storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  public read(): ApplicationUpdateRecoveryRecord | undefined {
    if (!existsSync(this.storagePath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown;
      if (isValidRecord(value)) return { ...value };
    } catch {
      // A corrupt marker cannot authorize use of an old installer cache.
    }
    // An invalid marker is not actionable recovery evidence. Remove it so the next explicit check
    // obtains a fresh package instead of treating a stale cache as trusted.
    try {
      unlinkSync(this.storagePath);
    } catch {
      // A locked marker remains harmless; the updater still performs a fresh network check.
    }
    return undefined;
  }

  public write(record: ApplicationUpdateRecoveryRecord): void {
    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const descriptor = openSync(temporaryPath, 'r+');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.storagePath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write/rename failure; a stale temporary file is never trusted.
      }
      throw error;
    }
  }
}
