import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type {
  ClaudeConnectionHistoryEntry,
  ClaudeEndpointProtocol,
  ClaudeRouterGatewayState,
  SaveClaudeConfigInput,
} from '../../shared/contracts';
import { claudeProviderIdSet } from '../../shared/claude/providers';
import { normalizeClaudeConfig, type NormalizedClaudeConfig } from './configuration';

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
  name?: string;
  protocol: ClaudeEndpointProtocol;
  routerProviderId?: string;
  savedAt: number;
  sourceAuthMode?: SaveClaudeConfigInput['authMode'];
  sourceBaseUrl?: string;
  sourceCredentialConfigured?: boolean;
  sourceModel?: string;
  sourceModelFast?: string;
}

interface StoredHistoryFile {
  projects: Record<string, StoredHistoryEntry[]>;
  version: 3;
}

export type ClaudeConnectionHistorySnapshot = StoredHistoryFile;

/** Enough to cover a session of trial and error without letting the file grow without bound. */
export const MAX_HISTORY_ENTRIES = 20;

const EMPTY_STORE: StoredHistoryFile = {
  projects: {},
  version: 3,
};

const projectKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase('en-US');

const GATEWAY_STATES = new Set<ClaudeRouterGatewayState>([
  'error',
  'running',
  'starting',
  'stopped',
  'unknown',
]);
const AUTH_MODES = new Set(['apiKey', 'authToken', 'existing', 'none']);
const HISTORY_PROTOCOLS = new Set<ClaudeEndpointProtocol>(['anthropic', 'openai', 'unknown']);

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

const normalizeHistoryName = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 60 || hasControlCharacter(normalized)) {
    throw new Error('连接名称需为 1-60 个字符，且不能包含控制字符。');
  }
  return normalized;
};

const legacyProtocol = (preset: string, provider: string): ClaudeEndpointProtocol =>
  provider === 'gateway' && preset === 'gateway' ? 'unknown' : 'anthropic';

const parseStoredEntry = (value: unknown): StoredHistoryEntry | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id === 'string' &&
    typeof record.savedAt === 'number' &&
    Number.isFinite(record.savedAt) &&
    (record.provider === 'anthropic' || record.provider === 'gateway') &&
    typeof record.model === 'string' &&
    (record.modelFast === undefined || typeof record.modelFast === 'string') &&
    typeof record.baseUrl === 'string' &&
    typeof record.authMode === 'string' &&
    AUTH_MODES.has(record.authMode) &&
    (record.apiKeyHelperPolicy === undefined ||
      record.apiKeyHelperPolicy === 'inherit' ||
      record.apiKeyHelperPolicy === 'prefer-claudedock') &&
    typeof record.preset === 'string' &&
    claudeProviderIdSet.has(record.preset) &&
    GATEWAY_STATES.has(record.gatewayState as ClaudeRouterGatewayState) &&
    (record.gatewayEndpoint === undefined || typeof record.gatewayEndpoint === 'string') &&
    (record.encryptedCredential === undefined || typeof record.encryptedCredential === 'string') &&
    (record.routerProviderId === undefined || typeof record.routerProviderId === 'string') &&
    (record.sourceAuthMode === undefined ||
      (typeof record.sourceAuthMode === 'string' && AUTH_MODES.has(record.sourceAuthMode))) &&
    (record.sourceBaseUrl === undefined || typeof record.sourceBaseUrl === 'string') &&
    (record.sourceCredentialConfigured === undefined ||
      typeof record.sourceCredentialConfigured === 'boolean') &&
    (record.sourceModel === undefined || typeof record.sourceModel === 'string') &&
    (record.sourceModelFast === undefined || typeof record.sourceModelFast === 'string')
  ) {
    const protocol = HISTORY_PROTOCOLS.has(record.protocol as ClaudeEndpointProtocol)
      ? (record.protocol as ClaudeEndpointProtocol)
      : legacyProtocol(record.preset, record.provider);
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    return {
      apiKeyHelperPolicy: record.apiKeyHelperPolicy === 'inherit' ? 'inherit' : 'prefer-claudedock',
      authMode: record.authMode as NormalizedClaudeConfig['authMode'],
      baseUrl: record.baseUrl,
      encryptedCredential: record.encryptedCredential as string | undefined,
      gatewayEndpoint: record.gatewayEndpoint as string | undefined,
      gatewayState: record.gatewayState as ClaudeRouterGatewayState,
      id: record.id,
      model: record.model,
      modelFast: record.modelFast as string | undefined,
      name: rawName && rawName.length <= 60 && !hasControlCharacter(rawName) ? rawName : undefined,
      preset: record.preset as NormalizedClaudeConfig['preset'],
      protocol,
      provider: record.provider,
      routerProviderId: record.routerProviderId as string | undefined,
      savedAt: record.savedAt,
      sourceAuthMode: record.sourceAuthMode as SaveClaudeConfigInput['authMode'] | undefined,
      sourceBaseUrl: record.sourceBaseUrl as string | undefined,
      sourceCredentialConfigured: record.sourceCredentialConfigured as boolean | undefined,
      sourceModel: record.sourceModel as string | undefined,
      sourceModelFast: record.sourceModelFast as string | undefined,
    };
  }
  return undefined;
};

/**
 * Identity of what the user typed. The gateway state is deliberately excluded: it describes the
 * machine at save time, not the configuration, and a router that flaps between `running` and
 * `stopped` must not turn one unchanged setup into a wall of near-identical records.
 */
const entryFingerprint = (
  config: NormalizedClaudeConfig,
  credential: string | undefined,
  protocol: ClaudeEndpointProtocol,
  source?: {
    authMode?: SaveClaudeConfigInput['authMode'];
    baseUrl?: string;
    model?: string;
    modelFast?: string;
    routerProviderId?: string;
    sourceCredentialConfigured?: boolean;
  },
): string =>
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
        protocol,
        provider: config.provider,
        source,
      }),
    )
    .digest('hex');

export interface RecordConnectionInput {
  config: SaveClaudeConfigInput;
  credential?: string;
  gatewayEndpoint?: string;
  gatewayState: ClaudeRouterGatewayState;
  name?: string;
  protocol?: ClaudeEndpointProtocol;
  routerProviderId?: string;
  sourceConfig?: SaveClaudeConfigInput;
  sourceCredentialConfigured?: boolean;
}

export interface ConnectionHistoryReplay {
  config: SaveClaudeConfigInput;
  name?: string;
  protocol: ClaudeEndpointProtocol;
}

export class ClaudeConnectionHistoryStore {
  private sequence = 0;
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'connection-history.json');
  }

  public createSnapshot(): ClaudeConnectionHistorySnapshot {
    return structuredClone(this.load());
  }

  public restoreSnapshot(snapshot: ClaudeConnectionHistorySnapshot): void {
    this.persist(structuredClone(snapshot));
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
      name: entry.name,
      preset: entry.preset,
      protocol: entry.protocol,
      provider: entry.provider,
      routerProviderId: entry.routerProviderId,
      savedAt: entry.savedAt,
      sourceAuthMode: entry.sourceAuthMode,
      sourceBaseUrl: entry.sourceBaseUrl,
      sourceCredentialConfigured: entry.sourceCredentialConfigured,
      sourceModel: entry.sourceModel,
      sourceModelFast: entry.sourceModelFast,
    }));
  }

  /**
   * Records a save unless the same setup is already stored. A repeat moves the record it matches
   * back to the top instead of appending — replaying an older entry is what the list is for, and
   * doing that must not turn one setup into a wall of identical records.
   */
  public record(cwd: string, input: RecordConnectionInput): ClaudeConnectionHistoryEntry[] {
    const config = normalizeClaudeConfig(input.config);
    const store = this.load();
    const key = projectKey(cwd);
    const entries = store.projects[key] ?? [];
    const protocol = input.protocol ?? 'anthropic';
    const name = input.name ? normalizeHistoryName(input.name) : undefined;
    let credential = input.credential?.trim() || undefined;
    if (!credential && input.sourceConfig && input.sourceCredentialConfigured) {
      const previous = entries.find(
        (entry) => entry.protocol === 'openai' && entry.routerProviderId === input.routerProviderId,
      );
      credential = this.decrypt(previous?.encryptedCredential);
    }

    const sourceIdentity = input.sourceConfig
      ? {
          authMode: input.sourceConfig.authMode,
          baseUrl: input.sourceConfig.baseUrl,
          model: input.sourceConfig.model,
          modelFast: input.sourceConfig.modelFast || input.sourceConfig.model,
          routerProviderId: input.routerProviderId,
          sourceCredentialConfigured: input.sourceCredentialConfigured,
        }
      : undefined;
    const fingerprint = entryFingerprint(config, credential, protocol, sourceIdentity);
    const existing = entries.find((entry) => this.fingerprintOf(entry) === fingerprint);
    if (existing) {
      // The id stays, so a rename or a pending reference to this record survives the replay.
      existing.savedAt = Date.now();
      if (name) {
        existing.name = name;
      }
      store.projects[key] = [existing, ...entries.filter((entry) => entry !== existing)];
      this.persist(store);
      return this.list(cwd);
    }

    this.sequence += 1;
    const entry: StoredHistoryEntry = {
      ...config,
      encryptedCredential: this.encrypt(credential),
      gatewayEndpoint: input.gatewayEndpoint,
      gatewayState: input.gatewayState,
      id: `history-${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      name,
      protocol,
      routerProviderId: input.routerProviderId,
      savedAt: Date.now(),
      sourceAuthMode: input.sourceConfig?.authMode,
      sourceBaseUrl: input.sourceConfig?.baseUrl,
      sourceCredentialConfigured: input.sourceCredentialConfigured,
      sourceModel: input.sourceConfig?.model,
      // Stored the way the fingerprint reads it, so a blank fast model cannot look like a change.
      sourceModelFast: input.sourceConfig
        ? input.sourceConfig.modelFast || input.sourceConfig.model
        : undefined,
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

  public rename(cwd: string, entryId: string, name: string): ClaudeConnectionHistoryEntry[] {
    const store = this.load();
    const key = projectKey(cwd);
    const entry = store.projects[key]?.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new Error('这条接入记录已被删除。');
    }
    entry.name = normalizeHistoryName(name);
    this.persist(store);
    return this.list(cwd);
  }

  /** The input needed to reapply a record, credential included, ready for `ClaudeConfigStore`. */
  public toSaveInput(cwd: string, entryId: string): SaveClaudeConfigInput {
    return this.toReplayInput(cwd, entryId).config;
  }

  public toReplayInput(cwd: string, entryId: string): ConnectionHistoryReplay {
    const entry = (this.load().projects[projectKey(cwd)] ?? []).find(
      (candidate) => candidate.id === entryId,
    );
    if (!entry) {
      throw new Error('这条接入记录已被删除。');
    }

    const credential = this.decrypt(entry.encryptedCredential);
    const sourceConfig =
      entry.protocol === 'openai' && entry.sourceBaseUrl && entry.sourceModel
        ? {
            apiKeyHelperPolicy: entry.apiKeyHelperPolicy ?? 'prefer-claudedock',
            authMode: entry.sourceAuthMode ?? ('authToken' as const),
            baseUrl: entry.sourceBaseUrl,
            credential,
            credentialAction: credential ? ('replace' as const) : ('keep' as const),
            model: entry.sourceModel,
            modelFast: entry.sourceModelFast || entry.sourceModel,
            preset: 'custom' as const,
            protocol: 'openai' as const,
            provider: 'gateway' as const,
            routerProviderId: entry.routerProviderId,
          }
        : undefined;
    return {
      config: {
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
        ...sourceConfig,
      },
      name: entry.name,
      protocol: entry.protocol,
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
      entry.protocol,
      entry.sourceBaseUrl
        ? {
            authMode: entry.sourceAuthMode,
            baseUrl: entry.sourceBaseUrl,
            model: entry.sourceModel,
            modelFast: entry.sourceModelFast || entry.sourceModel,
            routerProviderId: entry.routerProviderId,
            sourceCredentialConfigured: entry.sourceCredentialConfigured,
          }
        : undefined,
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
      if (
        (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
        !parsed.projects ||
        typeof parsed.projects !== 'object'
      ) {
        return structuredClone(EMPTY_STORE);
      }

      const projects: Record<string, StoredHistoryEntry[]> = {};
      for (const [key, value] of Object.entries(parsed.projects)) {
        if (Array.isArray(value)) {
          const entries = value
            .map(parseStoredEntry)
            .filter((entry): entry is StoredHistoryEntry => Boolean(entry))
            .slice(0, MAX_HISTORY_ENTRIES);
          if (entries.length > 0) {
            projects[key] = entries;
          }
        }
      }
      return { projects, version: 3 };
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
