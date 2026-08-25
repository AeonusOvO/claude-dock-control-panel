import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ClaudeContextWindowMode,
  CloseBehavior,
  ConversationResumePreferences,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
} from '../../shared/contracts';
import { isValidClaudeCustomContextWindow } from '../../shared/claude/context-window';

export interface AppPreferences {
  claudeContextWindowCustomTokens?: number;
  claudeContextWindowMode: ClaudeContextWindowMode;
  closeBehavior: CloseBehavior;
  closeToTrayNoticeShown: boolean;
  conversationResume: ConversationResumePreferences;
  footerResourcePreference: FooterResourcePreference;
  managedChatGptContextWindowMode: ManagedChatGptContextWindowMode;
}

/**
 * `auto` keeps Claude Code's own window judgement. Defaulting to a stated 1M would break official
 * subscriptions that lack the entitlement, so the wider window is opt-in from the status bar.
 */
const DEFAULT_PREFERENCES: AppPreferences = {
  claudeContextWindowMode: 'auto',
  closeBehavior: 'tray',
  closeToTrayNoticeShown: false,
  conversationResume: {
    autoLoadLastConversationModelOnStartup: true,
    autoLoadLastConversationOnStartup: true,
    modelMismatchBehavior: 'ask',
  },
  footerResourcePreference: 'auto',
  managedChatGptContextWindowMode: 'standard',
};

const CLAUDE_CONTEXT_WINDOW_MODES: readonly ClaudeContextWindowMode[] = [
  'auto',
  'custom',
  'extended',
  'standard',
];

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
    return (
      parsed ?? {
        ...DEFAULT_PREFERENCES,
        conversationResume: { ...DEFAULT_PREFERENCES.conversationResume },
      }
    );
  }

  public set(patch: Partial<AppPreferences>): AppPreferences {
    const current = this.get();
    const next = { ...current, ...patch };
    if (
      (next.closeBehavior !== 'exit' && next.closeBehavior !== 'tray') ||
      typeof next.closeToTrayNoticeShown !== 'boolean' ||
      !isConversationResumePreferences(next.conversationResume) ||
      !['auto', 'context', 'quota'].includes(next.footerResourcePreference) ||
      (next.managedChatGptContextWindowMode !== 'standard' &&
        next.managedChatGptContextWindowMode !== 'extended') ||
      !CLAUDE_CONTEXT_WINDOW_MODES.includes(next.claudeContextWindowMode) ||
      (next.claudeContextWindowMode === 'custom' &&
        !isValidClaudeCustomContextWindow(next.claudeContextWindowCustomTokens)) ||
      (next.claudeContextWindowCustomTokens !== undefined &&
        !isValidClaudeCustomContextWindow(next.claudeContextWindowCustomTokens))
    ) {
      throw new Error('应用偏好设置无效。');
    }
    this.ensureDirectory();
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...next, version: 2 }, null, 2)}\n`, {
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
      writeFileSync(this.storagePath, `${JSON.stringify({ ...legacy, version: 2 }, null, 2)}\n`, {
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
        claudeContextWindowCustomTokens?: unknown;
        claudeContextWindowMode?: unknown;
        closeBehavior?: unknown;
        closeToTrayNoticeShown?: unknown;
        conversationResume?: unknown;
        footerResourcePreference?: unknown;
        managedChatGptContextWindowMode?: unknown;
        version?: unknown;
      };
      if (
        (parsed.version === 1 || parsed.version === 2) &&
        (parsed.closeBehavior === 'exit' || parsed.closeBehavior === 'tray') &&
        typeof parsed.closeToTrayNoticeShown === 'boolean'
      ) {
        const claudeContextWindowMode = CLAUDE_CONTEXT_WINDOW_MODES.includes(
          parsed.claudeContextWindowMode as ClaudeContextWindowMode,
        )
          ? (parsed.claudeContextWindowMode as ClaudeContextWindowMode)
          : 'auto';
        const claudeContextWindowCustomTokens = isValidClaudeCustomContextWindow(
          parsed.claudeContextWindowCustomTokens,
        )
          ? parsed.claudeContextWindowCustomTokens
          : undefined;
        return {
          claudeContextWindowCustomTokens,
          // A custom window without a usable token count would inject nothing; fall back to auto.
          claudeContextWindowMode:
            claudeContextWindowMode === 'custom' && claudeContextWindowCustomTokens === undefined
              ? 'auto'
              : claudeContextWindowMode,
          closeBehavior: parsed.closeBehavior,
          closeToTrayNoticeShown: parsed.closeToTrayNoticeShown,
          conversationResume: normalizeConversationResumePreferences(
            parsed.conversationResume,
            parsed.version,
          ),
          footerResourcePreference:
            parsed.footerResourcePreference === 'context' ||
            parsed.footerResourcePreference === 'quota'
              ? parsed.footerResourcePreference
              : 'auto',
          managedChatGptContextWindowMode:
            parsed.managedChatGptContextWindowMode === 'extended' ? 'extended' : 'standard',
        };
      }
    } catch {
      // Missing or malformed preferences use the safe tray default.
    }
    return null;
  }
}

const isConversationResumePreferences = (
  value: unknown,
): value is ConversationResumePreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.modelMismatchBehavior === 'ask' ||
      record.modelMismatchBehavior === 'use-conversation' ||
      record.modelMismatchBehavior === 'use-current') &&
    typeof record.autoLoadLastConversationOnStartup === 'boolean' &&
    typeof record.autoLoadLastConversationModelOnStartup === 'boolean'
  );
};

const normalizeConversationResumePreferences = (
  value: unknown,
  version: unknown,
): ConversationResumePreferences => {
  if (isConversationResumePreferences(value)) {
    return { ...value };
  }
  if (version === 1 && value && typeof value === 'object' && !Array.isArray(value)) {
    const legacy = value as Record<string, unknown>;
    if (
      (legacy.modelMismatchBehavior === 'ask' ||
        legacy.modelMismatchBehavior === 'use-conversation' ||
        legacy.modelMismatchBehavior === 'use-current') &&
      typeof legacy.restoreLastWorkspaceOnStartup === 'boolean'
    ) {
      return {
        autoLoadLastConversationModelOnStartup: legacy.restoreLastWorkspaceOnStartup,
        autoLoadLastConversationOnStartup: legacy.restoreLastWorkspaceOnStartup,
        modelMismatchBehavior: legacy.modelMismatchBehavior,
      };
    }
  }
  return { ...DEFAULT_PREFERENCES.conversationResume };
};
