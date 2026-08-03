import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NetworkPreflightSettings } from '../shared/contracts';

const DEFAULT_SETTINGS: NetworkPreflightSettings = {
  enhancedPrivacyMode: true,
};

export class NetworkPreflightSettingsStore {
  private readonly directory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'network-preflight');
    this.storagePath = path.join(this.directory, 'settings.json');
  }

  public get(): NetworkPreflightSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        enhancedPrivacyMode?: unknown;
        version?: unknown;
      };
      if (parsed.version === 1 && typeof parsed.enhancedPrivacyMode === 'boolean') {
        return { enhancedPrivacyMode: parsed.enhancedPrivacyMode };
      }
    } catch {
      // Missing or malformed settings fall back to the privacy-documented default.
    }
    return { ...DEFAULT_SETTINGS };
  }

  public set(settings: NetworkPreflightSettings): NetworkPreflightSettings {
    if (typeof settings.enhancedPrivacyMode !== 'boolean') {
      throw new Error('网络预检隐私设置无效。');
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
