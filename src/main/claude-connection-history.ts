import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type {
  ClaudeConnectionHistoryEntry,
  ClaudeRouterGatewayState,
  SaveClaudeConfigInput,
} from '../shared/contracts';
import { claudeProviderIdSet } from '../shared/claude-providers';
import { normalizeClaudeConfig, type NormalizedClaudeConfig } from './claude-configuration';

/**
 * One saved connection setup, as it was entered. The credential is encrypted with the same
 * `safeStorage` key the live profile uses — a history entry has to restore the whole state in one
 * click, and writing the key in clear text into a JSON file to achieve that is not a trade we make.
 */
interface StoredHistoryEntry extends NormalizedClaudeConfig {
  encryptedCredential?: string;
  gatewayEndpoint?: string;
  gatewayState: ClaudeRouterGatewayState;
  id: string;
  savedAt: number;
}

interface StoredHistoryFile {
  projects: Record<string, StoredHistoryEntry[]>;
  version: 1;
}

/** Enough to cover a session of trial and error without letting the file grow without bound. */
export const MAX_HISTORY_ENTRIES = 20;

const EMPTY_STORE: StoredHistoryFile = {
  projects: {},
  version: 1,
};

const projectKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();

const GATEWAY_STATES = new Set<ClaudeRouterGatewayState>([
  'error',
  'running',
  'starting',
  'stopped',
  'unknown',
]);

const isStoredEntry = (value: unknown): value is StoredHistoryEntry => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.savedAt === 'number' &&
    Number.isFinite(record.savedAt) &&
    (record.provider === 'anthropic' || record.provider === 'gateway') &&
    typeof record.model === 'string' &&
    typeof record.baseUrl === 'string' &&
    typeof record.authMode === 'string' &&
    (record.apiKeyHelperPolicy === undefined ||
      record.apiKeyHelperPolicy === 'inherit' ||
      record.apiKeyHelperPolicy === 'prefer-claudedock') &&
    typeof record.preset === 'string' &&
    claudeProviderIdSet.has(record.preset) &&
    GATEWAY_STATES.has(record.gatewayState as ClaudeRouterGatewayState) &&
    (record.gatewayEndpoint === undefined || typeof record.gatewayEndpoint === 'string') &&
    (record.encryptedCredential === undefined || typeof record.encryptedCredential === 'string')
  );
};

/**
 * Identity of what the user typed. The gateway state is deliberately excluded: it describes the
 * machine at save time, not the configuration, and a router that flaps between `running` and
 * `stopped` must not turn one unchanged setup into a wall of near-identical records.
 */
const entryFingerprint = (config: NormalizedClaudeConfig, credential?: string): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        apiKeyHelperPolicy: config.apiKeyHelperPolicy,
        authMode: config.authMode,
        baseUrl: config.baseUrl,
        credential: credential ?? '',
        model: config.model,
        modelFast: config.modelFast || config.model,
        preset: config.preset,
        provider: config.provider,
      }),
    )
    .digest('hex');

export interface RecordConnectionInput {
  config: SaveClaudeConfigInput;
  credential?: string;
  gatewayEndpoint?: string;
  gatewayState: ClaudeRouterGatewayState;
}

export class ClaudeConnectionHistoryStore {
  private sequence = 0;
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'connection-history.json');
  }

  /** Newest first, so the list reads top-down as "most recent thing I tried". */
  public list(cwd: string): ClaudeConnectionHistoryEntry[] {
    return (this.load().projects[projectKey(cwd)] ?? []).map((entry) => ({
      apiKeyHelperPolicy: entry.apiKeyHelperPolicy ?? 'prefer-claudedock',
      authMode: entry.authMode,
      baseUrl: entry.baseUrl,
      credentialConfigured: Boolean(entry.encryptedCredential),
      gatewayEndpoint: entry.gatewayEndpoint,
      gatewayState: entry.gatewayState,
      id: entry.id,
      model: entry.model,
      modelFast: entry.modelFast || entry.model,
      preset: entry.preset,
      provider: entry.provider,
      savedAt: entry.savedAt,
    }));
  }

  /**
   * Appends a record unless it repeats the newest one. Returns the list as the UI should show it,
   * so the caller does not need a second read to find out whether anything changed.
   */
  public record(cwd: string, input: RecordConnectionInput): ClaudeConnectionHistoryEntry[] {
    const config = normalizeClaudeConfig(input.config);
    const credential = input.credential?.trim() || undefined;
    const store = this.load();
    const key = projectKey(cwd);
    const entries = store.projects[key] ?? [];
    const newest = entries[0];

    if (newest && this.fingerprintOf(newest) === entryFingerprint(config, credential)) {
      return this.list(cwd);
    }

    this.sequence += 1;
    const entry: StoredHistoryEntry = {
      ...config,
      encryptedCredential: this.encrypt(credential),
      gatewayEndpoint: input.gatewayEndpoint,
      gatewayState: input.gatewayState,
      id: `history-${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      savedAt: Date.now(),
    };

    store.projects[key] = [entry, ...entries].slice(0, MAX_HISTORY_ENTRIES);
    this.persist(store);
    return this.list(cwd);
  }

  public remove(cwd: string, entryId: string): ClaudeConnectionHistoryEntry[] {
    const store = this.load();
    const key = projectKey(cwd);
    const entries = store.projects[key];
    if (!entries) {
      return [];
    }

    const remaining = entries.filter((entry) => entry.id !== entryId);
    if (remaining.length === entries.length) {
      return this.list(cwd);
    }

    if (remaining.length === 0) {
      delete store.projects[key];
    } else {
      store.projects[key] = remaining;
    }
    this.persist(store);
    return this.list(cwd);
  }

  /** The input needed to reapply a record, credential included, ready for `ClaudeConfigStore`. */
  public toSaveInput(cwd: string, entryId: string): SaveClaudeConfigInput {
    const entry = (this.load().projects[projectKey(cwd)] ?? []).find(
      (candidate) => candidate.id === entryId,
    );
    if (!entry) {
      throw new Error('这条接入记录已被删除。');
    }

    const credential = this.decrypt(entry.encryptedCredential);
    return {
      apiKeyHelperPolicy: entry.apiKeyHelperPolicy ?? 'prefer-claudedock',
      authMode: entry.authMode,
      baseUrl: entry.baseUrl,
      credential,
      // Without a credential there is nothing to restore, so leave whatever is stored untouched.
      credentialAction: credential ? 'replace' : 'keep',
      model: entry.model,
      modelFast: entry.modelFast || entry.model,
      preset: entry.preset,
      provider: entry.provider,
    };
  }

  private fingerprintOf(entry: StoredHistoryEntry): string {
    return entryFingerprint(
      {
        apiKeyHelperPolicy: entry.apiKeyHelperPolicy ?? 'prefer-claudedock',
        authMode: entry.authMode,
        baseUrl: entry.baseUrl,
        model: entry.model,
        modelFast: entry.modelFast || entry.model,
        preset: entry.preset,
        provider: entry.provider,
      },
      this.decrypt(entry.encryptedCredential),
    );
  }

  private decrypt(encrypted?: string): string | undefined {
    if (!encrypted || !safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      // A record encrypted under a key we no longer hold is still useful for everything else.
      return undefined;
    }
  }

  private encrypt(credential?: string): string | undefined {
    if (!credential || !safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    return safeStorage.encryptString(credential).toString('base64');
  }

  private load(): StoredHistoryFile {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        projects?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== 'object') {
        return structuredClone(EMPTY_STORE);
      }

      const projects: Record<string, StoredHistoryEntry[]> = {};
      for (const [key, value] of Object.entries(parsed.projects)) {
        if (Array.isArray(value)) {
          const entries = value.filter(isStoredEntry).slice(0, MAX_HISTORY_ENTRIES);
          if (entries.length > 0) {
            projects[key] = entries;
          }
        }
      }
      return { projects, version: 1 };
    } catch {
      return structuredClone(EMPTY_STORE);
    }
  }

  private persist(store: StoredHistoryFile): void {
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
