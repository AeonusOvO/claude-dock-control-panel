import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DevelopmentRuntime, PtyGeneration } from '../shared/contracts';

const directoryKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();

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
  private readonly tail = new Map<string, ConfigTransactionIntent>();

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
      intent.resolveCompleted();
    }
  }

  private reserve(sessionId: string, cwd: string): ConfigTransactionIntent {
    const key = directoryKey(cwd);
    const previous = this.tail.get(key);
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const intent: ConfigTransactionIntent = {
      completed,
      finished: false,
      generation: ++this.nextGeneration,
      key,
      predecessor: previous?.completed ?? Promise.resolve(),
      resolveCompleted,
      sessionId,
    };
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

export interface OwnedConfigTransactionOptions<TSnapshot, TState> {
  assertOperationOwnership: () => void;
  assertRollbackOwnership?: () => void;
  coordinator: SessionConfigTransactionCoordinator;
  createSnapshot: () => TSnapshot;
  cwd: string;
  publishRestoredState?: (state: TState) => void;
  readState: () => Promise<TState>;
  restoreSnapshot: (snapshot: TSnapshot) => void;
  resume?: (savedState: TState) => Promise<TState>;
  save: () => Promise<TState>;
  sessionId: string;
}

/**
 * Runs the persistence/resume half of a cutover as one generation-owned transaction. The snapshot is
 * taken synchronously immediately before `save`; every later failure attempts an ownership-checked
 * restore and reads the resulting state again before reporting the original error.
 */
export const runOwnedConfigTransaction = <TSnapshot, TState>(
  options: OwnedConfigTransactionOptions<TSnapshot, TState>,
): Promise<TState> =>
  options.coordinator.run(options.sessionId, options.cwd, async (ownership) => {
    options.assertOperationOwnership();
    const snapshot = options.createSnapshot();
    let savedSnapshot = snapshot;

    try {
      const saving = options.save();
      // ClaudeRuntime persists before its first await; remember exactly what this intent wrote so an
      // unrelated config mutation can also make the eventual rollback stale.
      savedSnapshot = options.createSnapshot();
      let state = await saving;
      ownership.assertCurrent();
      options.assertOperationOwnership();
      if (!isDeepStrictEqual(options.createSnapshot(), savedSnapshot)) {
        throw new Error('项目配置已被更新，本次保存结果不再拥有当前配置。');
      }
      if (options.resume) {
        state = await options.resume(state);
        ownership.assertCurrent();
        options.assertOperationOwnership();
        if (!isDeepStrictEqual(options.createSnapshot(), savedSnapshot)) {
          throw new Error('项目配置已被更新，本次恢复结果不再拥有当前配置。');
        }
      }
      ownership.commit();
      return state;
    } catch (error) {
      let recoveryError: unknown;
      let restored = false;
      let state: TState | undefined;
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
