import path from 'node:path';
import type { ClaudeLaunchMode } from '../shared/contracts';

interface ConversationResumeIntent {
  conversationId?: string;
  cwdKey: string;
  finished: boolean;
  generation: number;
  sessionId: string;
  superseded: boolean;
}

interface ConversationDeletionIntent {
  conversationId: string;
  cwdKey: string;
  finished: boolean;
  generation: number;
  key: string;
  pendingResumeSessionIds: readonly string[];
}

const directoryKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();
const conversationKey = (cwdKey: string, conversationId: string): string =>
  `${cwdKey}\0${conversationId.toLocaleLowerCase()}`;

export class ClaudeConversationResumeOwnership {
  public constructor(
    private readonly coordinator: ClaudeConversationLifecycleCoordinator,
    private readonly intent: ConversationResumeIntent,
  ) {}

  public assertCurrent(): void {
    if (!this.coordinator.ownsResume(this.intent)) {
      throw new Error('这次历史对话恢复已被永久删除操作取消。');
    }
  }
}

export class ClaudeConversationDeletionOwnership {
  public constructor(
    private readonly coordinator: ClaudeConversationLifecycleCoordinator,
    private readonly intent: ConversationDeletionIntent,
  ) {}

  public assertCurrent(): void {
    if (!this.coordinator.ownsDeletion(this.intent)) {
      throw new Error('这次历史对话删除已失去执行所有权。');
    }
  }

  public pendingResumeSessionIds(): string[] {
    return [...this.intent.pendingResumeSessionIds];
  }
}

/**
 * Owns persisted-conversation resume and deletion above renderer metrics. Deletion is absorbing for its
 * exact project/conversation while active, cancels older matching resumes, and blocks ambiguous
 * continue/resume launches in that project until the transcript commit has finished.
 */
export class ClaudeConversationLifecycleCoordinator {
  private readonly deletions = new Map<string, ConversationDeletionIntent>();
  private readonly deletionsByDirectory = new Map<string, Set<ConversationDeletionIntent>>();
  private nextGeneration = 0;
  private readonly resumesByDirectory = new Map<string, Set<ConversationResumeIntent>>();

  public assertLaunchAllowed(cwd: string, mode: ClaudeLaunchMode, conversationId?: string): void {
    if (mode === 'new') {
      return;
    }
    const cwdKey = directoryKey(cwd);
    const blocked = conversationId
      ? this.deletions.has(conversationKey(cwdKey, conversationId))
      : (this.deletionsByDirectory.get(cwdKey)?.size ?? 0) > 0;
    if (blocked) {
      throw new Error('这个历史对话正在永久删除，请等待删除完成后再恢复。');
    }
  }

  public runDeletion<T>(
    cwd: string,
    conversationId: string,
    operation: (ownership: ClaudeConversationDeletionOwnership) => Promise<T>,
  ): Promise<T> {
    const intent = this.reserveDeletion(cwd, conversationId);
    return this.executeDeletion(intent, operation);
  }

  public runResume<T>(
    cwd: string,
    conversationId: string | undefined,
    sessionId: string,
    operation: (ownership: ClaudeConversationResumeOwnership) => Promise<T>,
  ): Promise<T> {
    const intent = this.reserveResume(cwd, conversationId, sessionId);
    return this.executeResume(intent, operation);
  }

  public ownsDeletion(intent: ConversationDeletionIntent): boolean {
    return !intent.finished && this.deletions.get(intent.key) === intent;
  }

  public ownsResume(intent: ConversationResumeIntent): boolean {
    return (
      !intent.finished &&
      !intent.superseded &&
      this.resumesByDirectory.get(intent.cwdKey)?.has(intent) === true
    );
  }

  private async executeDeletion<T>(
    intent: ConversationDeletionIntent,
    operation: (ownership: ClaudeConversationDeletionOwnership) => Promise<T>,
  ): Promise<T> {
    const ownership = new ClaudeConversationDeletionOwnership(this, intent);
    try {
      return await operation(ownership);
    } finally {
      this.finishDeletion(intent);
    }
  }

  private async executeResume<T>(
    intent: ConversationResumeIntent,
    operation: (ownership: ClaudeConversationResumeOwnership) => Promise<T>,
  ): Promise<T> {
    const ownership = new ClaudeConversationResumeOwnership(this, intent);
    try {
      return await operation(ownership);
    } finally {
      this.finishResume(intent);
    }
  }

  private finishDeletion(intent: ConversationDeletionIntent): void {
    if (intent.finished) {
      return;
    }
    intent.finished = true;
    if (this.deletions.get(intent.key) === intent) {
      this.deletions.delete(intent.key);
    }
    const directoryDeletions = this.deletionsByDirectory.get(intent.cwdKey);
    directoryDeletions?.delete(intent);
    if (directoryDeletions?.size === 0) {
      this.deletionsByDirectory.delete(intent.cwdKey);
    }
  }

  private finishResume(intent: ConversationResumeIntent): void {
    if (intent.finished) {
      return;
    }
    intent.finished = true;
    const resumes = this.resumesByDirectory.get(intent.cwdKey);
    resumes?.delete(intent);
    if (resumes?.size === 0) {
      this.resumesByDirectory.delete(intent.cwdKey);
    }
  }

  private reserveDeletion(cwd: string, conversationId: string): ConversationDeletionIntent {
    const cwdKey = directoryKey(cwd);
    const key = conversationKey(cwdKey, conversationId);
    if (this.deletions.has(key)) {
      throw new Error('这个历史对话已经在删除中。');
    }

    const pendingResumeSessionIds = new Set<string>();
    for (const resume of this.resumesByDirectory.get(cwdKey) ?? []) {
      if (
        resume.conversationId === undefined ||
        resume.conversationId.toLocaleLowerCase() === conversationId.toLocaleLowerCase()
      ) {
        resume.superseded = true;
        pendingResumeSessionIds.add(resume.sessionId);
      }
    }

    const intent: ConversationDeletionIntent = {
      conversationId,
      cwdKey,
      finished: false,
      generation: ++this.nextGeneration,
      key,
      pendingResumeSessionIds: [...pendingResumeSessionIds],
    };
    this.deletions.set(key, intent);
    const directoryDeletions =
      this.deletionsByDirectory.get(cwdKey) ?? new Set<ConversationDeletionIntent>();
    directoryDeletions.add(intent);
    this.deletionsByDirectory.set(cwdKey, directoryDeletions);
    return intent;
  }

  private reserveResume(
    cwd: string,
    conversationId: string | undefined,
    sessionId: string,
  ): ConversationResumeIntent {
    this.assertLaunchAllowed(cwd, conversationId ? 'resume' : 'continue', conversationId);
    const cwdKey = directoryKey(cwd);
    const intent: ConversationResumeIntent = {
      conversationId,
      cwdKey,
      finished: false,
      generation: ++this.nextGeneration,
      sessionId,
      superseded: false,
    };
    const resumes = this.resumesByDirectory.get(cwdKey) ?? new Set<ConversationResumeIntent>();
    resumes.add(intent);
    this.resumesByDirectory.set(cwdKey, resumes);
    return intent;
  }
}

export interface OwnedClaudeConversationDeletionOptions<TState> {
  closeRuntimeSession: (sessionId: string) => void;
  closeWorkspaceSession: (sessionId: string) => void;
  conversationId: string;
  coordinator: ClaudeConversationLifecycleCoordinator;
  cwd: string;
  deleteTranscript: () => boolean;
  invalidateAndWait: (sessionId: string) => Promise<void>;
  isSessionInDirectory: (sessionId: string, cwd: string) => boolean;
  readState: () => TState;
  removePreferences: () => void;
  sessionIdsForConversation: () => readonly string[];
}

export interface OwnedClaudeConversationDeletionResult<TState> {
  deleted: boolean;
  state: TState;
}

/** Stops every authoritative or pending owner before unlinking the transcript and its preferences. */
export const runOwnedClaudeConversationDeletion = <TState>(
  options: OwnedClaudeConversationDeletionOptions<TState>,
): Promise<OwnedClaudeConversationDeletionResult<TState>> =>
  options.coordinator.runDeletion(options.cwd, options.conversationId, async (ownership) => {
    const sessionIds = new Set([
      ...ownership.pendingResumeSessionIds(),
      ...options.sessionIdsForConversation(),
    ]);
    await Promise.all([...sessionIds].map(options.invalidateAndWait));
    ownership.assertCurrent();

    // A cancelled resume can bind its runtime immediately before observing cancellation. Re-snapshot
    // after unwind; the deletion reservation blocks every new matching resume until commit finishes.
    const newlyBoundSessionIds = options
      .sessionIdsForConversation()
      .filter((sessionId) => !sessionIds.has(sessionId));
    if (newlyBoundSessionIds.length > 0) {
      newlyBoundSessionIds.forEach((sessionId) => sessionIds.add(sessionId));
      await Promise.all(newlyBoundSessionIds.map(options.invalidateAndWait));
      ownership.assertCurrent();
    }

    for (const sessionId of sessionIds) {
      ownership.assertCurrent();
      options.closeRuntimeSession(sessionId);
    }
    for (const sessionId of sessionIds) {
      ownership.assertCurrent();
      if (options.isSessionInDirectory(sessionId, options.cwd)) {
        options.closeWorkspaceSession(sessionId);
      }
    }

    ownership.assertCurrent();
    const deleted = options.deleteTranscript();
    if (deleted) {
      options.removePreferences();
    }
    return { deleted, state: options.readState() };
  });
