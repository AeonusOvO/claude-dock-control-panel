import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { ClaudeConfigView, SaveClaudeConfigInput } from '../shared/contracts';
import { findClaudeProvider, providerForPreset } from '../shared/claude-providers';
import {
  DEFAULT_CLAUDE_CONFIG,
  type NormalizedClaudeConfig,
  normalizeClaudeConfig,
} from './claude-configuration';

interface StoredClaudeConfig extends NormalizedClaudeConfig {
  /**
   * Arms `bypassPermissions` at launch so Shift+Tab can reach 「完全允许」. Kept out of
   * `NormalizedClaudeConfig` because it steers the launch command, not the model route.
   */
  allowBypassPermissions?: boolean;
  encryptedCredential?: string;
}

export interface ClaudeConfigSnapshot {
  project?: StoredClaudeConfig;
}

/** Armed by default: without it the mode picker could never offer 「完全允许」 at all. */
const DEFAULT_ALLOW_BYPASS_PERMISSIONS = true;

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
    (record.apiKeyHelperPolicy === undefined ||
      record.apiKeyHelperPolicy === 'inherit' ||
      record.apiKeyHelperPolicy === 'prefer-claudedock') &&
    typeof record.preset === 'string' &&
    (record.allowBypassPermissions === undefined ||
      typeof record.allowBypassPermissions === 'boolean') &&
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

    const preset = findClaudeProvider(stored.preset)?.id ?? 'custom';
    try {
      return normalizeClaudeConfig({
        apiKeyHelperPolicy: stored.apiKeyHelperPolicy,
        authMode: stored.authMode,
        baseUrl: stored.baseUrl,
        credentialAction: 'keep',
        model: stored.model,
        modelFast: stored.modelFast || stored.model,
        preset,
        provider: providerForPreset(preset),
      });
    } catch {
      return { ...DEFAULT_CLAUDE_CONFIG };
    }
  }

  public getCredential(cwd: string): string | undefined {
    const encrypted = this.load().projects[projectKey(cwd)]?.encryptedCredential;
    if (!encrypted) {
      return undefined;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储当前不可用，无法解密接口凭据。');
    }

    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      throw new Error('接口凭据无法解密，请在接入设置中重新填写。');
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

  public getAllowBypassPermissions(cwd: string): boolean {
    return (
      this.load().projects[projectKey(cwd)]?.allowBypassPermissions ??
      DEFAULT_ALLOW_BYPASS_PERMISSIONS
    );
  }

  public createSnapshot(cwd: string): ClaudeConfigSnapshot {
    const project = this.load().projects[projectKey(cwd)];
    return project ? { project: structuredClone(project) } : {};
  }

  public restoreSnapshot(cwd: string, snapshot: ClaudeConfigSnapshot): void {
    const store = this.load();
    const key = projectKey(cwd);
    if (snapshot.project) {
      store.projects[key] = structuredClone(snapshot.project);
    } else {
      delete store.projects[key];
    }
    this.persist(store);
  }

  /**
   * Persists the launch-time arming switch on its own, so toggling it never rewrites — or requires
   * the caller to re-supply — the credential.
   */
  public setAllowBypassPermissions(cwd: string, allowed: boolean): void {
    const store = this.load();
    const key = projectKey(cwd);
    const existing = store.projects[key];
    store.projects[key] = existing
      ? { ...existing, allowBypassPermissions: allowed }
      : { ...this.getConfig(cwd), allowBypassPermissions: allowed };
    this.persist(store);
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
        throw new Error('接口凭据不能为空、不能换行，且长度不能超过 4096 个字符。');
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows 安全存储当前不可用，拒绝以明文保存接口凭据。');
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
      // Saving a route must not silently re-arm (or disarm) the permission switch.
      allowBypassPermissions: store.projects[key]?.allowBypassPermissions,
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
