import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeEffortRequest, ClaudePermissionMode } from '../shared/contracts';
import { CLAUDE_EFFORT_REQUESTS } from '../shared/claude-effort';

const PERMISSION_MODES: ReadonlySet<string> = new Set<ClaudePermissionMode>([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

export interface ConversationPreferences {
  effort?: ClaudeEffortRequest;
  model?: string;
  permissionMode?: ClaudePermissionMode;
  updatedAt: number;
}

interface StoredConversationPreferences {
  conversations: Record<string, ConversationPreferences>;
  version: 1;
}

const EMPTY_STORE: StoredConversationPreferences = {
  conversations: {},
  version: 1,
};

/**
 * Claude Code conversation ids are UUIDs. Anything else is either a display slug or an attacker
 * controlled string, and neither belongs in a filename-adjacent key.
 */
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same shape the launch command already accepts, so a restored model can never inject arguments. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Keeping the newest few hundred conversations is far more than anyone scrolls back through. */
const MAX_ENTRIES = 400;

export const isConversationId = (value: string): boolean => CONVERSATION_ID_PATTERN.test(value);

/**
 * Remembers what each conversation was last running with, so reopening it from the history list
 * restores its own model, permission mode and thinking effort instead of the project defaults.
 */
export class ConversationPreferencesStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'conversation-preferences.json');
  }

  public get(conversationId: string): ConversationPreferences | undefined {
    if (!isConversationId(conversationId)) {
      return undefined;
    }
    return this.load().conversations[conversationId.toLowerCase()];
  }

  /**
   * Merges a partial observation into the stored record. Callers report whatever the runtime knows
   * at that moment, so an unknown field must never erase a value captured earlier in the session.
   */
  public record(
    conversationId: string,
    patch: Omit<Partial<ConversationPreferences>, 'updatedAt'>,
  ): void {
    if (!isConversationId(conversationId)) {
      return;
    }
    const key = conversationId.toLowerCase();
    const store = this.load();
    const current = store.conversations[key];
    const next: ConversationPreferences = {
      effort: sanitizeEffort(patch.effort) ?? current?.effort,
      model: sanitizeModel(patch.model) ?? current?.model,
      permissionMode: sanitizeMode(patch.permissionMode) ?? current?.permissionMode,
      updatedAt: Date.now(),
    };
    if (!next.effort && !next.model && !next.permissionMode) {
      // Nothing survived validation, so there is no state worth remembering for this conversation.
      return;
    }
    if (
      current &&
      current.effort === next.effort &&
      current.model === next.model &&
      current.permissionMode === next.permissionMode
    ) {
      return;
    }
    store.conversations[key] = next;
    this.persist(store);
  }

  public remove(conversationId: string): void {
    if (!isConversationId(conversationId)) {
      return;
    }
    const store = this.load();
    if (!(conversationId.toLowerCase() in store.conversations)) {
      return;
    }
    delete store.conversations[conversationId.toLowerCase()];
    this.persist(store);
  }

  private load(): StoredConversationPreferences {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        conversations?: unknown;
        version?: unknown;
      };
      if (
        parsed.version !== 1 ||
        !parsed.conversations ||
        typeof parsed.conversations !== 'object'
      ) {
        return structuredClone(EMPTY_STORE);
      }
      const conversations: Record<string, ConversationPreferences> = {};
      for (const [key, value] of Object.entries(parsed.conversations)) {
        if (!isConversationId(key) || !value || typeof value !== 'object') {
          continue;
        }
        const entry = value as Partial<ConversationPreferences>;
        const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
        conversations[key.toLowerCase()] = {
          effort: sanitizeEffort(entry.effort),
          model: sanitizeModel(entry.model),
          permissionMode: sanitizeMode(entry.permissionMode),
          updatedAt,
        };
      }
      return { conversations, version: 1 };
    } catch {
      return structuredClone(EMPTY_STORE);
    }
  }

  private persist(store: StoredConversationPreferences): void {
    const entries = Object.entries(store.conversations)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ENTRIES);
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ conversations: Object.fromEntries(entries), version: 1 }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, this.storagePath);
  }
}

const sanitizeEffort = (value: unknown): ClaudeEffortRequest | undefined =>
  typeof value === 'string' && CLAUDE_EFFORT_REQUESTS.has(value as ClaudeEffortRequest)
    ? (value as ClaudeEffortRequest)
    : undefined;

const sanitizeModel = (value: unknown): string | undefined =>
  typeof value === 'string' && MODEL_PATTERN.test(value) ? value : undefined;

const sanitizeMode = (value: unknown): ClaudePermissionMode | undefined =>
  typeof value === 'string' && PERMISSION_MODES.has(value)
    ? (value as ClaudePermissionMode)
    : undefined;
