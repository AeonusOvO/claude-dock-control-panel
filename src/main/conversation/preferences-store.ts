import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type {
  ClaudeAuthMode,
  ClaudeEffortRequest,
  ClaudeEndpointProtocol,
  ClaudePermissionMode,
  ClaudePreset,
  ClaudeProvider,
  SaveClaudeConfigInput,
} from '../../shared/contracts';
import { CLAUDE_EFFORT_REQUESTS } from '../../shared/claude/effort';
import { claudeProviderIdSet } from '../../shared/claude/providers';

const PERMISSION_MODES: ReadonlySet<string> = new Set<ClaudePermissionMode>([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);
const AUTH_MODES = new Set<ClaudeAuthMode>(['apiKey', 'authToken', 'existing', 'none']);
const PROTOCOLS = new Set<ClaudeEndpointProtocol>(['anthropic', 'openai', 'unknown']);

export interface ConversationConnectionBinding {
  accountIdentity?: string;
  authMethod?: string;
  config: SaveClaudeConfigInput;
  connectionName?: string;
  credentialConfigured: boolean;
  /** Full digest stays in the main process; renderer views receive only a short prefix. */
  credentialFingerprint?: string;
  protocol: ClaudeEndpointProtocol;
}

export interface ConversationPreferences {
  binding?: ConversationConnectionBinding;
  effort?: ClaudeEffortRequest;
  model?: string;
  permissionMode?: ClaudePermissionMode;
  updatedAt: number;
}

interface StoredConversationConnectionBinding
  extends
    Omit<ConversationConnectionBinding, 'config'>,
    Omit<SaveClaudeConfigInput, 'credential' | 'credentialAction' | 'protocol'> {
  encryptedCredential?: string;
}

interface StoredConversationPreferences extends Omit<ConversationPreferences, 'binding'> {
  binding?: StoredConversationConnectionBinding;
}

interface StoredConversationPreferencesFile {
  conversations: Record<string, StoredConversationPreferences>;
  version: 2;
}

const EMPTY_STORE: StoredConversationPreferencesFile = {
  conversations: {},
  version: 2,
};

/** Claude Code conversation ids are UUIDs, so arbitrary display slugs never become storage keys. */
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same shape accepted by the live connection form and launch command. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]~-]{0,199}$/;
const MAX_ENTRIES = 400;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

export const isConversationId = (value: string): boolean => CONVERSATION_ID_PATTERN.test(value);

export const credentialFingerprint = (credential: string | undefined): string | undefined => {
  const normalized = credential?.trim();
  return normalized ? createHash('sha256').update(normalized).digest('hex') : undefined;
};

/**
 * Remembers what each conversation was last running with. Version 2 also binds the complete model
 * connection, including an encrypted API credential when one exists. A blank small-model field is
 * canonicalised to the main model at this boundary, so blank and explicitly-equal values are one
 * identity everywhere else.
 */
export class ConversationPreferencesStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'conversation-preferences.json');
  }

  public get(conversationId: string): ConversationPreferences | undefined {
    if (!isConversationId(conversationId)) return undefined;
    const stored = this.load().conversations[conversationId.toLowerCase()];
    if (!stored) return undefined;
    return {
      ...(stored.binding ? { binding: this.inflateBinding(stored.binding) } : {}),
      effort: stored.effort,
      model: stored.model,
      permissionMode: stored.permissionMode,
      updatedAt: stored.updatedAt,
    };
  }

  /** Partial runtime observations merge without erasing fields captured earlier in the session. */
  public record(
    conversationId: string,
    patch: Omit<Partial<ConversationPreferences>, 'updatedAt'>,
  ): void {
    if (!isConversationId(conversationId)) return;
    const key = conversationId.toLowerCase();
    const store = this.load();
    const current = store.conversations[key];
    const sanitizedBinding = patch.binding ? this.deflateBinding(patch.binding) : undefined;
    if (
      sanitizedBinding &&
      current?.binding?.encryptedCredential &&
      sanitizedBinding.credentialFingerprint === current.binding.credentialFingerprint
    ) {
      // DPAPI ciphertext may be nondeterministic. Reuse the prior blob for an unchanged key so the
      // one-second runtime observer does not rewrite this file forever.
      sanitizedBinding.encryptedCredential = current.binding.encryptedCredential;
    }
    const next: StoredConversationPreferences = {
      binding: sanitizedBinding ?? current?.binding,
      effort: sanitizeEffort(patch.effort) ?? current?.effort,
      model: sanitizeModel(patch.model) ?? current?.model,
      permissionMode: sanitizeMode(patch.permissionMode) ?? current?.permissionMode,
      updatedAt: Date.now(),
    };
    if (!next.binding && !next.effort && !next.model && !next.permissionMode) return;
    const comparableCurrent = current ? { ...current, updatedAt: 0 } : undefined;
    const comparableNext = { ...next, updatedAt: 0 };
    if (comparableCurrent && JSON.stringify(comparableCurrent) === JSON.stringify(comparableNext)) {
      return;
    }
    store.conversations[key] = next;
    this.persist(store);
  }

  public remove(conversationId: string): void {
    if (!isConversationId(conversationId)) return;
    const store = this.load();
    if (!(conversationId.toLowerCase() in store.conversations)) return;
    delete store.conversations[conversationId.toLowerCase()];
    this.persist(store);
  }

  private deflateBinding(
    value: ConversationConnectionBinding,
  ): StoredConversationConnectionBinding | undefined {
    const config = sanitizeBindingConfig(value.config);
    if (!config) return undefined;
    const credential = sanitizeCredential(value.config.credential);
    const subscription = config.preset === 'anthropic' || config.preset === 'chatgpt-subscription';
    const configured =
      subscription || config.authMode === 'existing' || config.authMode === 'none'
        ? false
        : Boolean(credential) || value.credentialConfigured;
    return {
      accountIdentity: sanitizeText(value.accountIdentity, 320),
      apiKeyHelperPolicy: config.apiKeyHelperPolicy === 'inherit' ? 'inherit' : 'prefer-claudedock',
      authMethod: sanitizeText(value.authMethod, 80),
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      connectionName: sanitizeText(value.connectionName, 60),
      credentialConfigured: configured,
      credentialFingerprint: subscription
        ? undefined
        : (credentialFingerprint(credential) ?? sanitizeDigest(value.credentialFingerprint)),
      encryptedCredential: this.encrypt(credential),
      model: config.model,
      modelFast: config.modelFast || config.model,
      preset: config.preset,
      protocol: value.protocol,
      provider: config.provider,
      routerProviderId: config.routerProviderId,
    };
  }

  private inflateBinding(
    value: StoredConversationConnectionBinding,
  ): ConversationConnectionBinding {
    const credential = this.decrypt(value.encryptedCredential);
    return {
      accountIdentity: value.accountIdentity,
      authMethod: value.authMethod,
      config: {
        apiKeyHelperPolicy: value.apiKeyHelperPolicy,
        authMode: value.authMode,
        baseUrl: value.baseUrl,
        credential,
        credentialAction: credential ? 'replace' : 'keep',
        model: value.model,
        modelFast: value.modelFast || value.model,
        preset: value.preset,
        ...(value.protocol === 'anthropic' || value.protocol === 'openai'
          ? { protocol: value.protocol }
          : {}),
        provider: value.provider,
        routerProviderId: value.routerProviderId,
      },
      connectionName: value.connectionName,
      credentialConfigured: value.credentialConfigured,
      credentialFingerprint: value.credentialFingerprint,
      protocol: value.protocol,
    };
  }

  private load(): StoredConversationPreferencesFile {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        conversations?: unknown;
        version?: unknown;
      };
      if (
        (parsed.version !== 1 && parsed.version !== 2) ||
        !parsed.conversations ||
        typeof parsed.conversations !== 'object'
      ) {
        return structuredClone(EMPTY_STORE);
      }
      const conversations: Record<string, StoredConversationPreferences> = {};
      for (const [key, value] of Object.entries(parsed.conversations)) {
        if (!isConversationId(key) || !value || typeof value !== 'object') continue;
        const entry = value as Record<string, unknown>;
        const binding = parsed.version === 2 ? sanitizeStoredBinding(entry.binding) : undefined;
        conversations[key.toLowerCase()] = {
          ...(binding ? { binding } : {}),
          effort: sanitizeEffort(entry.effort),
          model: sanitizeModel(entry.model),
          permissionMode: sanitizeMode(entry.permissionMode),
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        };
      }
      return { conversations, version: 2 };
    } catch {
      return structuredClone(EMPTY_STORE);
    }
  }

  private persist(store: StoredConversationPreferencesFile): void {
    const entries = Object.entries(store.conversations)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ENTRIES);
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ conversations: Object.fromEntries(entries), version: 2 }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, this.storagePath);
  }

  private decrypt(encrypted?: string): string | undefined {
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return undefined;
    }
  }

  private encrypt(credential?: string): string | undefined {
    if (!credential || !safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.encryptString(credential).toString('base64');
  }
}

const sanitizeEffort = (value: unknown): ClaudeEffortRequest | undefined =>
  typeof value === 'string' && CLAUDE_EFFORT_REQUESTS.has(value as ClaudeEffortRequest)
    ? (value as ClaudeEffortRequest)
    : undefined;

const sanitizeModel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return MODEL_PATTERN.test(normalized) ? normalized : undefined;
};

const sanitizeMode = (value: unknown): ClaudePermissionMode | undefined =>
  typeof value === 'string' && PERMISSION_MODES.has(value)
    ? (value as ClaudePermissionMode)
    : undefined;

const sanitizeText = (value: unknown, maximumLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacter(normalized)) {
    return undefined;
  }
  return normalized;
};

const sanitizeCredential = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 4096 && !/[\r\n]/.test(normalized)
    ? normalized
    : undefined;
};

const sanitizeDigest = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;

const sanitizeBindingConfig = (value: unknown): SaveClaudeConfigInput | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<SaveClaudeConfigInput>;
  const model = sanitizeModel(input.model);
  const modelFast = sanitizeModel(input.modelFast) ?? model;
  if (
    !model ||
    !modelFast ||
    typeof input.baseUrl !== 'string' ||
    input.baseUrl.length > 2048 ||
    /[\r\n]/.test(input.baseUrl) ||
    !AUTH_MODES.has(input.authMode as ClaudeAuthMode) ||
    !claudeProviderIdSet.has(input.preset as ClaudePreset) ||
    (input.provider !== 'anthropic' && input.provider !== 'gateway') ||
    (input.protocol !== undefined && !PROTOCOLS.has(input.protocol)) ||
    (input.routerProviderId !== undefined && !sanitizeText(input.routerProviderId, 200))
  )
    return undefined;
  const credential = sanitizeCredential(input.credential);
  return {
    apiKeyHelperPolicy: input.apiKeyHelperPolicy === 'inherit' ? 'inherit' : 'prefer-claudedock',
    authMode: input.authMode as ClaudeAuthMode,
    baseUrl: input.baseUrl.trim(),
    credential,
    credentialAction: credential ? 'replace' : 'keep',
    model,
    modelFast,
    preset: input.preset as ClaudePreset,
    ...(input.protocol === 'anthropic' || input.protocol === 'openai'
      ? { protocol: input.protocol }
      : {}),
    provider: input.provider as ClaudeProvider,
    routerProviderId: sanitizeText(input.routerProviderId, 200),
  };
};

const sanitizeStoredBinding = (value: unknown): StoredConversationConnectionBinding | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const config = sanitizeBindingConfig({
    apiKeyHelperPolicy: record.apiKeyHelperPolicy,
    authMode: record.authMode,
    baseUrl: record.baseUrl,
    credentialAction: 'keep',
    model: record.model,
    modelFast: record.modelFast,
    preset: record.preset,
    protocol: record.protocol,
    provider: record.provider,
    routerProviderId: record.routerProviderId,
  });
  if (!config || !PROTOCOLS.has(record.protocol as ClaudeEndpointProtocol)) return undefined;
  return {
    accountIdentity: sanitizeText(record.accountIdentity, 320),
    apiKeyHelperPolicy: config.apiKeyHelperPolicy,
    authMethod: sanitizeText(record.authMethod, 80),
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    connectionName: sanitizeText(record.connectionName, 60),
    credentialConfigured: record.credentialConfigured === true,
    credentialFingerprint: sanitizeDigest(record.credentialFingerprint),
    encryptedCredential:
      typeof record.encryptedCredential === 'string' ? record.encryptedCredential : undefined,
    model: config.model,
    modelFast: config.modelFast || config.model,
    preset: config.preset,
    protocol: record.protocol as ClaudeEndpointProtocol,
    provider: config.provider,
    routerProviderId: config.routerProviderId,
  };
};
