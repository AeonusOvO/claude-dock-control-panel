import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DevelopmentRuntime, PtyGeneration } from '../shared/contracts';

const directoryKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase('en-US');

export interface RuntimeSwitchSessionSnapshot {
  cwd: string;
  id: string;
  ptyGeneration: PtyGeneration;
}

export interface ProjectRuntimeSwitchDependencies {
  cleanupBeforeCommit: (cwd: string, selected: DevelopmentRuntime) => Promise<void>;
  commitRuntime: (cwd: string, selected: DevelopmentRuntime) => void;
  getCurrentRuntime: (cwd: string) => DevelopmentRuntime;
  getSession: (sessionId: string) => RuntimeSwitchSessionSnapshot | undefined;
  hasActiveRuntime: (sessionId: string) => boolean;
  invalidateAndWait: (sessionId: string) => Promise<void>;
  prepareProvider: (cwd: string, selected: DevelopmentRuntime) => Promise<void>;
  sessionsForDirectory: (cwd: string) => RuntimeSwitchSessionSnapshot[];
}

interface DirectorySwitchIntent {
  completed: Promise<void>;
  cwd: string;
  expectedRuntime: DevelopmentRuntime;
  initialSessions: RuntimeSwitchSessionSnapshot[];
  key: string;
  predecessor: Promise<void>;
  resolveCompleted: () => void;
  selected: DevelopmentRuntime;
  sessionId: string;
  superseded: boolean;
}

const orderedSessions = (
  sessions: readonly RuntimeSwitchSessionSnapshot[],
): RuntimeSwitchSessionSnapshot[] =>
  [...sessions].sort((left, right) =>
    left.id === right.id
      ? left.ptyGeneration - right.ptyGeneration
      : left.id.localeCompare(right.id),
  );

const sameSessionSnapshot = (
  left: readonly RuntimeSwitchSessionSnapshot[],
  right: readonly RuntimeSwitchSessionSnapshot[],
): boolean =>
  left.length === right.length &&
  left.every(
    (session, index) =>
      session.id === right[index]?.id &&
      session.ptyGeneration === right[index]?.ptyGeneration &&
      directoryKey(session.cwd) === directoryKey(right[index]?.cwd ?? ''),
  );

/**
 * Owns project-runtime switches by resolved directory. Reserving is synchronous, while same-folder
 * switches form a latest-intent queue. The reservation remains visible while an older intent unwinds,
 * so a newly opened session cannot start development work in the gap between the two switches.
 */
export class ProjectRuntimeSwitchCoordinator {
  private readonly currentByDirectory = new Map<string, DirectorySwitchIntent>();

  public constructor(private readonly dependencies: ProjectRuntimeSwitchDependencies) {}

  public assertDevelopmentOperationAllowed(cwd: string): void {
    if (this.currentByDirectory.has(directoryKey(cwd))) {
      throw new Error('当前项目正在切换开发引擎，请等待切换完成。');
    }
  }

  public switchRuntime(
    sessionId: string,
    cwd: string,
    selected: DevelopmentRuntime,
  ): Promise<DevelopmentRuntime> {
    const intent = this.reserve(sessionId, cwd, selected);
    return this.execute(intent);
  }

  private assertCurrent(intent: DirectorySwitchIntent): void {
    if (intent.superseded || this.currentByDirectory.get(intent.key) !== intent) {
      throw new Error('这次开发引擎切换已被同一项目的更新选择取代。');
    }
  }

  private assertStable(
    intent: DirectorySwitchIntent,
    requireInactive: boolean,
  ): RuntimeSwitchSessionSnapshot[] {
    this.assertCurrent(intent);
    const initiatingSession = this.dependencies.getSession(intent.sessionId);
    if (!initiatingSession || directoryKey(initiatingSession.cwd) !== intent.key) {
      throw new Error('发起切换的开发会话已关闭或不再属于原项目。');
    }

    const currentSessions = orderedSessions(this.dependencies.sessionsForDirectory(intent.cwd));
    if (
      currentSessions.some((session) => directoryKey(session.cwd) !== intent.key) ||
      !sameSessionSnapshot(intent.initialSessions, currentSessions)
    ) {
      throw new Error('项目会话在开发引擎切换期间发生变化，本次切换已取消。');
    }
    if (this.dependencies.getCurrentRuntime(intent.cwd) !== intent.expectedRuntime) {
      throw new Error('项目开发引擎已被其他操作更新，本次切换已取消。');
    }
    if (
      requireInactive &&
      currentSessions.some((session) => this.dependencies.hasActiveRuntime(session.id))
    ) {
      throw new Error('请先结束当前开发会话，再切换开发引擎。');
    }
    return currentSessions;
  }

  private async execute(intent: DirectorySwitchIntent): Promise<DevelopmentRuntime> {
    try {
      await intent.predecessor;
      const sessions = this.assertStable(intent, false);
      if (intent.expectedRuntime === intent.selected) {
        return intent.selected;
      }

      await Promise.all(sessions.map((session) => this.dependencies.invalidateAndWait(session.id)));
      this.assertStable(intent, true);

      await this.dependencies.prepareProvider(intent.cwd, intent.selected);
      this.assertStable(intent, true);

      await this.dependencies.cleanupBeforeCommit(intent.cwd, intent.selected);
      this.assertStable(intent, true);

      // Persistence is deliberately the final synchronous commit. Nothing may await after this line.
      this.dependencies.commitRuntime(intent.cwd, intent.selected);
      return intent.selected;
    } finally {
      if (this.currentByDirectory.get(intent.key) === intent) {
        this.currentByDirectory.delete(intent.key);
      }
      intent.resolveCompleted();
    }
  }

  private reserve(
    sessionId: string,
    cwd: string,
    selected: DevelopmentRuntime,
  ): DirectorySwitchIntent {
    const key = directoryKey(cwd);
    const initiatingSession = this.dependencies.getSession(sessionId);
    if (!initiatingSession || directoryKey(initiatingSession.cwd) !== key) {
      throw new Error('发起切换的开发会话已关闭或不再属于原项目。');
    }
    const initialSessions = orderedSessions(this.dependencies.sessionsForDirectory(cwd));
    if (
      !initialSessions.some((session) => session.id === sessionId) ||
      initialSessions.some((session) => directoryKey(session.cwd) !== key)
    ) {
      throw new Error('无法确认当前项目的全部开发会话。');
    }

    const previous = this.currentByDirectory.get(key);
    if (previous) {
      previous.superseded = true;
    }
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const intent: DirectorySwitchIntent = {
      completed,
      cwd,
      expectedRuntime: this.dependencies.getCurrentRuntime(cwd),
      initialSessions,
      key,
      predecessor: previous?.completed ?? Promise.resolve(),
      resolveCompleted,
      selected,
      sessionId,
      superseded: false,
    };
    this.currentByDirectory.set(key, intent);
    return intent;
  }
}

interface ConfigTransactionIntent {
  completed: Promise<void>;
  finished: boolean;
  generation: number;
  isolationAcquired: boolean;
  key: string;
  predecessor: Promise<void>;
  resolveCompleted: () => void;
  sessionId: string;
}

class ConfigTransactionOwnership {
  public constructor(
    private readonly coordinator: SessionConfigTransactionCoordinator,
    private readonly intent: ConfigTransactionIntent,
  ) {}

  public assertCurrent(): void {
    if (!this.coordinator.owns(this.intent)) {
      throw new Error('这次配置事务已失去当前项目的执行所有权。');
    }
  }

  public commit(): void {
    this.assertCurrent();
    this.finish();
  }

  public finish(): void {
    this.intent.finished = true;
  }
}

/**
 * Serializes project-config persistence by resolved directory. Separate workspace sessions for the
 * same folder share one FIFO because they mutate the same on-disk profile; unrelated folders retain
 * independent queues.
 */
export class SessionConfigTransactionCoordinator {
  private readonly active = new Map<string, ConfigTransactionIntent>();
  private nextGeneration = 0;
  private readonly reservations = new Map<string, Set<ConfigTransactionIntent>>();
  private readonly tail = new Map<string, ConfigTransactionIntent>();

  /** Blocks sibling launches while a same-folder transaction exposes tentative persisted config. */
  public assertDevelopmentOperationAllowed(cwd: string, sessionId?: string): void {
    const key = directoryKey(cwd);
    const active = this.active.get(key);
    if (active) {
      if (active.sessionId === sessionId) {
        return;
      }
      throw new Error('当前项目正在保存并验证接入配置，请等待操作完成。');
    }

    if (this.tail.has(key)) {
      throw new Error('当前项目正在等待接入配置事务，请等待操作完成。');
    }
  }

  /**
   * Cancels same-folder development work that predates the active transaction. Transactions already
   * queued behind this one are safe to leave running because their callbacks cannot execute until the
   * active transaction releases its barrier.
   */
  public async acquireDevelopmentIsolation(
    sessionId: string,
    cwd: string,
    siblingSessionIds: readonly string[],
    invalidateAndWait: (sessionId: string) => Promise<void>,
  ): Promise<void> {
    const key = directoryKey(cwd);
    const intent = this.active.get(key);
    if (!intent || intent.sessionId !== sessionId || !this.owns(intent)) {
      throw new Error('当前配置事务无法取得项目开发会话隔离。');
    }

    // Mark isolation synchronously before cancellation begins. A raced sibling that already passed the
    // renderer/main guard can no longer reserve a new config transaction and wait on this intent.
    intent.isolationAcquired = true;
    const reservedSessionIds = new Set(
      [...(this.reservations.get(key) ?? [])]
        .filter((candidate) => candidate !== intent)
        .map((candidate) => candidate.sessionId),
    );
    const sessionsToInvalidate = [...new Set(siblingSessionIds)].filter(
      (candidate) => candidate !== sessionId && !reservedSessionIds.has(candidate),
    );
    await Promise.all(sessionsToInvalidate.map(invalidateAndWait));
    if (!this.owns(intent)) {
      throw new Error('配置事务在等待项目开发会话退出时失去所有权。');
    }
  }

  public run<T>(
    sessionId: string,
    cwd: string,
    operation: (ownership: ConfigTransactionOwnership) => Promise<T>,
  ): Promise<T> {
    const intent = this.reserve(sessionId, cwd);
    return this.execute(intent, operation);
  }

  public owns(intent: ConfigTransactionIntent): boolean {
    const current = this.active.get(intent.key);
    return !intent.finished && current === intent && current.generation === intent.generation;
  }

  private async execute<T>(
    intent: ConfigTransactionIntent,
    operation: (ownership: ConfigTransactionOwnership) => Promise<T>,
  ): Promise<T> {
    await intent.predecessor;
    this.active.set(intent.key, intent);
    const ownership = new ConfigTransactionOwnership(this, intent);
    try {
      return await operation(ownership);
    } finally {
      ownership.finish();
      if (this.active.get(intent.key) === intent) {
        this.active.delete(intent.key);
      }
      if (this.tail.get(intent.key) === intent) {
        this.tail.delete(intent.key);
      }
      const reservations = this.reservations.get(intent.key);
      reservations?.delete(intent);
      if (reservations?.size === 0) {
        this.reservations.delete(intent.key);
      }
      intent.resolveCompleted();
    }
  }

  private reserve(sessionId: string, cwd: string): ConfigTransactionIntent {
    const key = directoryKey(cwd);
    if (this.active.get(key)?.isolationAcquired) {
      throw new Error('当前项目配置事务已进入隔离保存阶段，请等待操作完成后重试。');
    }
    const previous = this.tail.get(key);
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const intent: ConfigTransactionIntent = {
      completed,
      finished: false,
      generation: ++this.nextGeneration,
      isolationAcquired: false,
      key,
      predecessor: previous?.completed ?? Promise.resolve(),
      resolveCompleted,
      sessionId,
    };
    const reservations = this.reservations.get(key) ?? new Set<ConfigTransactionIntent>();
    reservations.add(intent);
    this.reservations.set(key, reservations);
    this.tail.set(key, intent);
    return intent;
  }
}

export class OwnedConfigTransactionError<TState> extends Error {
  public constructor(
    public readonly originalError: unknown,
    public readonly state: TState | undefined,
    public readonly restored: boolean,
    public readonly recoveryError?: unknown,
  ) {
    super(originalError instanceof Error ? originalError.message : '配置事务失败。');
    this.name = 'OwnedConfigTransactionError';
  }
}

export interface OwnedConfigTransactionOptions<TSnapshot, TPrepared, TState> {
  acquireIsolation?: () => Promise<void>;
  assertOperationOwnership: () => void;
  assertRollbackOwnership?: () => void;
  commit: (prepared: TPrepared) => void;
  complete: (prepared: TPrepared) => Promise<TState>;
  coordinator: SessionConfigTransactionCoordinator;
  createSnapshot: () => TSnapshot;
  cwd: string;
  prepare: () => Promise<TPrepared> | TPrepared;
  publishRestoredState?: (state: TState) => void;
  readState: () => Promise<TState>;
  restoreSnapshot: (snapshot: TSnapshot) => void;
  sessionId: string;
}

/**
 * Runs one project-profile mutation as a generation-owned transaction. Potentially slow provider or
 * history preparation happens while the original snapshot is still persisted. The commit callback is
 * deliberately synchronous; only after its exact result is captured may validation, route preparation,
 * state reads, or terminal replacement await. Every later failure performs an ownership-checked restore.
 */
export const runOwnedConfigTransaction = <TSnapshot, TPrepared, TState>(
  options: OwnedConfigTransactionOptions<TSnapshot, TPrepared, TState>,
): Promise<TState> =>
  options.coordinator.run(options.sessionId, options.cwd, async (ownership) => {
    options.assertOperationOwnership();
    if (options.acquireIsolation) {
      await options.acquireIsolation();
      ownership.assertCurrent();
      options.assertOperationOwnership();
    }

    const snapshot = options.createSnapshot();
    let commitAttempted = false;
    let savedSnapshot = snapshot;

    try {
      const prepared = await options.prepare();
      ownership.assertCurrent();
      options.assertOperationOwnership();
      if (!isDeepStrictEqual(options.createSnapshot(), snapshot)) {
        throw new Error('项目配置在异步准备期间已被更新，本次保存已取消。');
      }

      commitAttempted = true;
      try {
        options.commit(prepared);
      } finally {
        // The commit is synchronous, so this is the exact profile left by either success or a partial
        // throwing write. It is the only profile this intent is allowed to roll back later.
        savedSnapshot = options.createSnapshot();
      }
      ownership.assertCurrent();
      options.assertOperationOwnership();
      if (!isDeepStrictEqual(options.createSnapshot(), savedSnapshot)) {
        throw new Error('项目配置已被更新，本次保存结果不再拥有当前配置。');
      }

      const state = await options.complete(prepared);
      ownership.assertCurrent();
      options.assertOperationOwnership();
      if (!isDeepStrictEqual(options.createSnapshot(), savedSnapshot)) {
        throw new Error('项目配置已被更新，本次完成结果不再拥有当前配置。');
      }
      ownership.commit();
      return state;
    } catch (error) {
      let recoveryError: unknown;
      let restored = false;
      let state: TState | undefined;
      if (commitAttempted) {
        try {
          ownership.assertCurrent();
          (options.assertRollbackOwnership ?? options.assertOperationOwnership)();
          if (!isDeepStrictEqual(options.createSnapshot(), savedSnapshot)) {
            throw new Error('项目配置已被更新，本次失败操作不会覆盖较新的保存结果。', {
              cause: error,
            });
          }
          options.restoreSnapshot(snapshot);
          restored = true;
        } catch (rollbackError) {
          recoveryError = rollbackError;
        }
      }

      try {
        state = await options.readState();
        if (restored) {
          ownership.assertCurrent();
          (options.assertRollbackOwnership ?? options.assertOperationOwnership)();
          options.publishRestoredState?.(state);
        }
      } catch (stateError) {
        recoveryError ??= stateError;
      } finally {
        ownership.finish();
      }

      throw new OwnedConfigTransactionError(error, state, restored, recoveryError);
    }
  });
