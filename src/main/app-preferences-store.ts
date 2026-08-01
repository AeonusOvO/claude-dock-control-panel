import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export class AppPreferencesStore {
  private readonly directory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'preferences');
    this.storagePath = path.join(this.directory, 'app.json');
  }

  public get(): AppPreferences {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
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
    return { ...DEFAULT_PREFERENCES };
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
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...next, version: 1 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
    return next;
  }
}
