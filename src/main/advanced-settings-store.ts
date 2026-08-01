import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdvancedSettings, ChatIdleTimeoutMinutes } from '../shared/contracts';

/**
 * Everything here is off by default. These switches work around relay-side protocol quirks, and a
 * relay that behaves correctly must not pay for them: web research isolation, for instance, adds a
 * subagent definition and a system prompt to every session, which is only worth it when the relay
 * actually refuses web search at higher effort levels.
 */
const DEFAULT_SETTINGS: AdvancedSettings = {
  chatIdleTimeoutMinutes: 0,
  webResearchIsolation: false,
};

const isChatIdleTimeoutMinutes = (value: unknown): value is ChatIdleTimeoutMinutes =>
  value === 0 || value === 5 || value === 10 || value === 30;

export class AdvancedSettingsStore {
  private readonly directory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'advanced');
    this.storagePath = path.join(this.directory, 'settings.json');
  }

  public get(): AdvancedSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        chatIdleTimeoutMinutes?: unknown;
        version?: unknown;
        webResearchIsolation?: unknown;
      };
      if (parsed.version === 1 && typeof parsed.webResearchIsolation === 'boolean') {
        return {
          chatIdleTimeoutMinutes: isChatIdleTimeoutMinutes(parsed.chatIdleTimeoutMinutes)
            ? parsed.chatIdleTimeoutMinutes
            : 0,
          webResearchIsolation: parsed.webResearchIsolation,
        };
      }
    } catch {
      // Missing or malformed settings fall back to the documented defaults.
    }
    return { ...DEFAULT_SETTINGS };
  }

  public set(settings: AdvancedSettings): AdvancedSettings {
    if (
      !isChatIdleTimeoutMinutes(settings.chatIdleTimeoutMinutes) ||
      typeof settings.webResearchIsolation !== 'boolean'
    ) {
      throw new Error('高级设置无效。');
    }
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...settings, version: 1 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
    return { ...settings };
  }
}
