import type { TerminalPhase, TerminalStatus } from '../../shared/contracts';

export type ClaudeLaunchReleaseReason =
  | 'cancelled'
  | 'claude-exit'
  | 'conversation'
  | 'explicit-failure'
  | 'powershell'
  | 'session-deleted'
  | 'terminal-failure';

type ClaudeLaunchLifecycleEvidenceReason = Extract<
  ClaudeLaunchReleaseReason,
  'claude-exit' | 'conversation' | 'powershell'
>;

export type ClaudeLaunchResultDisposition = 'failure' | 'success';
export type ClaudeLaunchPresentationPhase =
  | 'authorizing-launch'
  | 'awaiting-model-choice'
  | 'awaiting-restart-confirmation'
  | 'checking-model-network'
  | 'inspecting-conversation-model'
  | 'paused'
  | 'preflight'
  | 'preparing-terminal'
  | 'reading-configuration'
  | 'relaunching-conversation'
  | 'restoring-conversation'
  | 'starting'
  | 'switching-model';

export interface ClaudeLaunchAttemptToken {
  generation: number;
  sessionId: string;
}

export interface ClaudeLaunchBaseline {
  active?: boolean;
  conversationId?: string;
  terminalPhase?: TerminalPhase;
  terminalPid?: number;
  terminalPtyGeneration?: TerminalStatus['ptyGeneration'];
}

export interface ClaudeLaunchObservation {
  active: boolean;
  conversationId?: string;
  sessionId: string;
}

export interface ClaudeLaunchRelease {
  reason: ClaudeLaunchReleaseReason;
  token: ClaudeLaunchAttemptToken;
}

export interface ClaudeLaunchResultTombstone extends ClaudeLaunchAttemptToken {
  disposition: ClaudeLaunchResultDisposition;
}

interface ClaudeLaunchAttempt extends ClaudeLaunchAttemptToken {
  acceptedResult?: ClaudeLaunchResultDisposition;
  baselineConversationId?: string;
  baselinePid?: number;
  baselinePtyGeneration?: TerminalStatus['ptyGeneration'];
  latestClaudeActive?: boolean;
  lifecycleEvidenceReason?: ClaudeLaunchLifecycleEvidenceReason;
  presentationPhase: ClaudeLaunchPresentationPhase;
  sawClaudeActive: boolean;
}

/**
 * Owns renderer launch locks without using timeouts. Non-failure lifecycle evidence is retained until
 * the exact IPC result is accepted because the replacement PTY can report running before invoke
 * settlement. Explicit failures remain terminal, and generations make an older settlement harmless
 * after a newer attempt has already started.
 */
export class ClaudeLaunchAttemptRegistry {
  private readonly attempts = new Map<string, ClaudeLaunchAttempt>();
  private nextGeneration = 0;
  private readonly resultTombstones = new Map<string, ClaudeLaunchResultTombstone>();
  private readonly terminalStatuses = new Map<string, TerminalStatus>();

  public begin(sessionId: string, baseline: ClaudeLaunchBaseline): ClaudeLaunchAttemptToken {
    if (this.attempts.has(sessionId)) {
      throw new Error('这个 Claude 会话正在启动。');
    }
    const token = {
      generation: ++this.nextGeneration,
      sessionId,
    };
    this.attempts.set(sessionId, {
      ...token,
      baselineConversationId: baseline.conversationId,
      baselinePid: baseline.terminalPhase === 'running' ? baseline.terminalPid : undefined,
      baselinePtyGeneration: baseline.terminalPtyGeneration,
      latestClaudeActive: baseline.active,
      presentationPhase: 'reading-configuration',
      sawClaudeActive: baseline.active === true,
    });
    return token;
  }

  public current(sessionId: string): ClaudeLaunchAttemptToken | undefined {
    const attempt = this.attempts.get(sessionId);
    return attempt ? { generation: attempt.generation, sessionId: attempt.sessionId } : undefined;
  }

  public presentationPhase(sessionId: string): ClaudeLaunchPresentationPhase | undefined {
    return this.attempts.get(sessionId)?.presentationPhase;
  }

  public setPresentationPhase(
    token: ClaudeLaunchAttemptToken,
    phase: ClaudeLaunchPresentationPhase,
  ): boolean {
    const attempt = this.attempts.get(token.sessionId);
    if (!attempt || attempt.generation !== token.generation) {
      return false;
    }
    attempt.presentationPhase = phase;
    return true;
  }

  public acceptResult(
    token: ClaudeLaunchAttemptToken,
    disposition: ClaudeLaunchResultDisposition,
  ): boolean {
    const attempt = this.attempts.get(token.sessionId);
    if (!attempt || attempt.generation !== token.generation) {
      return false;
    }
    const tombstone = this.resultTombstones.get(token.sessionId);
    if (tombstone?.generation === token.generation) {
      return false;
    }
    this.resultTombstones.set(token.sessionId, { ...token, disposition });
    attempt.acceptedResult = disposition;
    if (attempt.lifecycleEvidenceReason) {
      this.release(token.sessionId, token.generation, attempt.lifecycleEvidenceReason);
    }
    return true;
  }

  public cancel(token: ClaudeLaunchAttemptToken): ClaudeLaunchRelease | undefined {
    return this.release(token.sessionId, token.generation, 'cancelled');
  }

  public fail(token: ClaudeLaunchAttemptToken): ClaudeLaunchRelease | undefined {
    return this.release(token.sessionId, token.generation, 'explicit-failure');
  }

  public invalidate(
    sessionId: string,
    reason: ClaudeLaunchReleaseReason = 'explicit-failure',
  ): ClaudeLaunchRelease | undefined {
    const attempt = this.attempts.get(sessionId);
    return attempt ? this.release(sessionId, attempt.generation, reason) : undefined;
  }

  public hydrateClaude(
    token: ClaudeLaunchAttemptToken,
    observation: ClaudeLaunchObservation,
  ): boolean {
    const attempt = this.attempts.get(token.sessionId);
    if (
      !attempt ||
      attempt.generation !== token.generation ||
      observation.sessionId !== token.sessionId
    ) {
      return false;
    }
    if (!attempt.baselineConversationId && observation.conversationId) {
      attempt.baselineConversationId = observation.conversationId;
    }
    attempt.latestClaudeActive = observation.active;
    if (observation.active) {
      attempt.sawClaudeActive = true;
    }
    return true;
  }

  public isBusy(sessionId: string): boolean {
    return this.attempts.has(sessionId);
  }

  public isCurrent(token: ClaudeLaunchAttemptToken): boolean {
    return this.attempts.get(token.sessionId)?.generation === token.generation;
  }

  public observeClaude(observation: ClaudeLaunchObservation): ClaudeLaunchRelease | undefined {
    const attempt = this.attempts.get(observation.sessionId);
    if (!attempt) {
      return undefined;
    }
    attempt.latestClaudeActive = observation.active;
    if (observation.active) {
      attempt.sawClaudeActive = true;
    }
    if (observation.conversationId) {
      if (!attempt.baselineConversationId) {
        attempt.baselineConversationId = observation.conversationId;
      } else if (observation.conversationId !== attempt.baselineConversationId) {
        return this.observeLifecycleEvidence(attempt, 'conversation');
      }
    }
    const terminal = this.terminalStatuses.get(observation.sessionId);
    if (!observation.active && attempt.sawClaudeActive && terminal?.phase === 'running') {
      return this.observeLifecycleEvidence(attempt, 'claude-exit');
    }
    return undefined;
  }

  public observeTerminal(status: TerminalStatus): ClaudeLaunchRelease | undefined {
    this.terminalStatuses.set(status.id, status);
    const attempt = this.attempts.get(status.id);
    if (!attempt) {
      return undefined;
    }
    if (
      status.phase === 'starting' &&
      ![
        'authorizing-launch',
        'awaiting-model-choice',
        'awaiting-restart-confirmation',
        'checking-model-network',
        'inspecting-conversation-model',
        'paused',
        'preflight',
        'preparing-terminal',
        'relaunching-conversation',
        'restoring-conversation',
        'switching-model',
      ].includes(attempt.presentationPhase)
    ) {
      attempt.presentationPhase = 'starting';
    }
    if (status.phase === 'error' || status.phase === 'stopped') {
      return this.release(status.id, attempt.generation, 'terminal-failure');
    }
    if (
      status.phase === 'running' &&
      ((attempt.baselinePtyGeneration !== undefined &&
        status.ptyGeneration !== attempt.baselinePtyGeneration) ||
        (status.pid !== undefined && status.pid !== attempt.baselinePid))
    ) {
      return this.observeLifecycleEvidence(attempt, 'powershell');
    }
    if (
      status.phase === 'running' &&
      attempt.sawClaudeActive &&
      attempt.latestClaudeActive === false
    ) {
      return this.observeLifecycleEvidence(attempt, 'claude-exit');
    }
    return undefined;
  }

  public prune(validSessionIds: ReadonlySet<string>): ClaudeLaunchRelease[] {
    const released: ClaudeLaunchRelease[] = [];
    for (const sessionId of this.terminalStatuses.keys()) {
      if (!validSessionIds.has(sessionId)) {
        this.terminalStatuses.delete(sessionId);
      }
    }
    for (const sessionId of this.resultTombstones.keys()) {
      if (!validSessionIds.has(sessionId)) {
        this.resultTombstones.delete(sessionId);
      }
    }
    for (const [sessionId, attempt] of this.attempts) {
      if (!validSessionIds.has(sessionId)) {
        const release = this.release(sessionId, attempt.generation, 'session-deleted');
        if (release) {
          released.push(release);
        }
      }
    }
    return released;
  }

  private observeLifecycleEvidence(
    attempt: ClaudeLaunchAttempt,
    reason: ClaudeLaunchLifecycleEvidenceReason,
  ): ClaudeLaunchRelease | undefined {
    attempt.lifecycleEvidenceReason ??= reason;
    return attempt.acceptedResult
      ? this.release(attempt.sessionId, attempt.generation, attempt.lifecycleEvidenceReason)
      : undefined;
  }

  private release(
    sessionId: string,
    generation: number,
    reason: ClaudeLaunchReleaseReason,
  ): ClaudeLaunchRelease | undefined {
    const attempt = this.attempts.get(sessionId);
    if (!attempt || attempt.generation !== generation) {
      return undefined;
    }
    this.attempts.delete(sessionId);
    return {
      reason,
      token: { generation, sessionId },
    };
  }
}

export type ClaudeLaunchAttemptOutcome<TResult> =
  | { status: 'cancelled' | 'stale' }
  | { error: unknown; status: 'rejected' }
  | { result: TResult; status: 'resolved' };

export interface ClaudeLaunchAttemptOrchestration<TResult> {
  applyResult: (result: TResult) => boolean;
  confirmation?: () => Promise<boolean>;
  onRelease?: (release: ClaudeLaunchRelease) => void;
  prepare?: () => Promise<void> | void;
  registry: ClaudeLaunchAttemptRegistry;
  start: () => Promise<TResult>;
  token: ClaudeLaunchAttemptToken;
}

/**
 * Runs every asynchronous continuation under one exact launch token. A late confirmation or IPC
 * settlement can observe that its token is stale, but it cannot release, report, or apply state to
 * the replacement attempt.
 */
export const orchestrateClaudeLaunchAttempt = async <TResult>({
  applyResult,
  confirmation,
  onRelease,
  prepare,
  registry,
  start,
  token,
}: ClaudeLaunchAttemptOrchestration<TResult>): Promise<ClaudeLaunchAttemptOutcome<TResult>> => {
  try {
    if (confirmation) {
      const confirmed = await confirmation();
      if (!registry.isCurrent(token)) {
        return { status: 'stale' };
      }
      if (!confirmed) {
        const release = registry.cancel(token);
        if (!release) {
          return { status: 'stale' };
        }
        onRelease?.(release);
        return { status: 'cancelled' };
      }
    }

    if (!registry.isCurrent(token)) {
      return { status: 'stale' };
    }
    await prepare?.();
    if (!registry.isCurrent(token)) {
      return { status: 'stale' };
    }
    const result = await start();
    if (!registry.isCurrent(token) || !applyResult(result)) {
      return { status: 'stale' };
    }
    return { result, status: 'resolved' };
  } catch (error) {
    const release = registry.fail(token);
    if (!release) {
      return { status: 'stale' };
    }
    onRelease?.(release);
    return { error, status: 'rejected' };
  }
};
