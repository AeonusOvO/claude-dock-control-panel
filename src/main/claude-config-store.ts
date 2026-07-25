import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { ClaudeConfigView, SaveClaudeConfigInput } from '../shared/contracts';
import {
  DEFAULT_CLAUDE_CONFIG,
  type NormalizedClaudeConfig,
  normalizeClaudeConfig,
} from './claude-configuration';

interface StoredClaudeConfig extends NormalizedClaudeConfig {
  encryptedCredential?: string;
}

interface StoredClaudeConfigFile {
  projects: Record<string, StoredClaudeConfig>;
  version: 1;
}

const EMPTY_STORE: StoredClaudeConfigFile = {
  projects: {},
  version: 1,
};

const projectKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();

const isStoredConfig = (value: unknown): value is StoredClaudeConfig => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.provider === 'anthropic' || record.provider === 'gateway') &&
    typeof record.model === 'string' &&
    typeof record.baseUrl === 'string' &&
    typeof record.authMode === 'string' &&
    typeof record.preset === 'string' &&
    (record.encryptedCredential === undefined || typeof record.encryptedCredential === 'string')
  );
};

export class ClaudeConfigStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'project-profiles.json');
  }

  public getConfig(cwd: string): NormalizedClaudeConfig {
    const stored = this.load().projects[projectKey(cwd)];
    if (!stored) {
      return { ...DEFAULT_CLAUDE_CONFIG };
    }

    return {
      authMode: stored.authMode,
      baseUrl: stored.baseUrl,
      model: stored.model,
      preset: stored.preset,
      provider: stored.provider,
    };
  }

  public getCredential(cwd: string): string | undefined {
    const encrypted = this.load().projects[projectKey(cwd)]?.encryptedCredential;
    if (!encrypted) {
      return undefined;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储当前不可用，无法解密 API 凭据。');
    }

    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      throw new Error('API 凭据无法解密，请在接入设置中重新填写。');
    }
  }

  public getView(cwd: string): ClaudeConfigView {
    const config = this.getConfig(cwd);
    const stored = this.load().projects[projectKey(cwd)];
    return {
      ...config,
      credentialConfigured: Boolean(stored?.encryptedCredential),
    };
  }

  public save(cwd: string, input: SaveClaudeConfigInput): ClaudeConfigView {
    const config = normalizeClaudeConfig(input);
    const store = this.load();
    const key = projectKey(cwd);
    const existingCredential = store.projects[key]?.encryptedCredential;
    let encryptedCredential = existingCredential;

    if (input.credentialAction === 'replace') {
      const credential = input.credential?.trim() ?? '';
      if (!credential || credential.length > 4096 || /[\r\n]/.test(credential)) {
        throw new Error('API 凭据不能为空、不能换行，且长度不能超过 4096 个字符。');
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows 安全存储当前不可用，拒绝以明文保存 API 凭据。');
      }
      encryptedCredential = safeStorage.encryptString(credential).toString('base64');
    } else if (input.credentialAction === 'clear') {
      encryptedCredential = undefined;
    }

    if (config.authMode === 'existing' || config.authMode === 'none') {
      encryptedCredential = undefined;
    }

    store.projects[key] = {
      ...config,
      encryptedCredential,
    };
    this.persist(store);
    return this.getView(cwd);
  }

  private load(): StoredClaudeConfigFile {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        projects?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== 'object') {
        return structuredClone(EMPTY_STORE);
      }

      const projects: Record<string, StoredClaudeConfig> = {};
      for (const [key, value] of Object.entries(parsed.projects)) {
        if (isStoredConfig(value)) {
          projects[key] = value;
        }
      }
      return { projects, version: 1 };
    } catch {
      return structuredClone(EMPTY_STORE);
    }
  }

  private persist(store: StoredClaudeConfigFile): void {
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
