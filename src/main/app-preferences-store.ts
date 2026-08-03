import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CloseBehavior } from '../shared/contracts';

export interface AppPreferences {
  closeBehavior: CloseBehavior;
  closeToTrayNoticeShown: boolean;
}

const DEFAULT_PREFERENCES: AppPreferences = {
  closeBehavior: 'tray',
  closeToTrayNoticeShown: false,
};

/**
 * Chromium owns a `Preferences` file directly inside `userData`. Windows paths are case-insensitive,
 * so the original `preferences` directory name collided with it and `mkdirSync` failed with EEXIST
 * every time the window was hidden to the tray. The directory is now namespaced away from anything
 * Chromium reserves, and any legacy directory left by an older build is migrated on first use.
 */
const PREFERENCES_DIRECTORY = 'app-preferences';
const LEGACY_PREFERENCES_DIRECTORY = 'preferences';

const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

export class AppPreferencesStore {
  private readonly directory: string;
  private readonly legacyStoragePath: string;
  private readonly storagePath: string;
  private migrated = false;

  public constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, PREFERENCES_DIRECTORY);
    this.storagePath = path.join(this.directory, 'app.json');
    this.legacyStoragePath = path.join(userDataPath, LEGACY_PREFERENCES_DIRECTORY, 'app.json');
  }

  public get(): AppPreferences {
    this.migrateLegacyStorage();
    const parsed = this.read(this.storagePath);
    return parsed ?? { ...DEFAULT_PREFERENCES };
  }

  public set(patch: Partial<AppPreferences>): AppPreferences {
    const current = this.get();
    const next = { ...current, ...patch };
    if (
      (next.closeBehavior !== 'exit' && next.closeBehavior !== 'tray') ||
      typeof next.closeToTrayNoticeShown !== 'boolean'
    ) {
      throw new Error('应用偏好设置无效。');
    }
    this.ensureDirectory();
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...next, version: 1 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
    return next;
  }

  private ensureDirectory(): void {
    if (isDirectory(this.directory)) {
      return;
    }
    /*
     * A stale non-directory entry at this path would make `recursive: true` throw EEXIST, which is
     * exactly the crash this store used to hit. Clear it first so the write can always proceed.
     */
    rmSync(this.directory, { force: true, recursive: true });
    mkdirSync(this.directory, { recursive: true });
  }

  private migrateLegacyStorage(): void {
    if (this.migrated) {
      return;
    }
    this.migrated = true;
    if (this.read(this.storagePath) !== null) {
      return;
    }
    const legacy = this.read(this.legacyStoragePath);
    if (legacy === null) {
      return;
    }
    try {
      this.ensureDirectory();
      writeFileSync(this.storagePath, `${JSON.stringify({ ...legacy, version: 1 }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // Migration is best effort; defaults remain usable when the legacy copy cannot be moved.
    }
  }

  private read(storagePath: string): AppPreferences | null {
    try {
      const parsed = JSON.parse(readFileSync(storagePath, 'utf8')) as {
        closeBehavior?: unknown;
        closeToTrayNoticeShown?: unknown;
        version?: unknown;
      };
      if (
        parsed.version === 1 &&
        (parsed.closeBehavior === 'exit' || parsed.closeBehavior === 'tray') &&
        typeof parsed.closeToTrayNoticeShown === 'boolean'
      ) {
        return {
          closeBehavior: parsed.closeBehavior,
          closeToTrayNoticeShown: parsed.closeToTrayNoticeShown,
        };
      }
    } catch {
      // Missing or malformed preferences use the safe tray default.
    }
    return null;
  }
}
