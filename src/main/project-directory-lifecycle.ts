import path from 'node:path';

export type ProjectDirectoryClosureKind = 'close' | 'forget';

type ProjectDirectoryLifecycleKind = 'open' | ProjectDirectoryClosureKind;

interface ProjectDirectoryLifecycleIntent {
  finished: boolean;
  generation: number;
  key: string;
  kind: ProjectDirectoryLifecycleKind;
  superseded: boolean;
}

interface ProjectDirectoryLifecycleState {
  closeIntent?: ProjectDirectoryLifecycleIntent;
  openIntents: Set<ProjectDirectoryLifecycleIntent>;
}

const directoryKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();

export class ProjectDirectoryLifecycleOwnership {
  public constructor(
    private readonly coordinator: ProjectDirectoryLifecycleCoordinator,
    private readonly intent: ProjectDirectoryLifecycleIntent,
  ) {}

  public assertCurrent(): void {
    if (!this.coordinator.owns(this.intent)) {
      throw new Error(
        this.intent.kind === 'open'
          ? '这次打开项目操作已被更新的文件夹操作取代。'
          : '这次关闭项目操作已被更新的文件夹操作取代。',
      );
    }
  }
}

/**
 * Owns folder open/close/forget intent above individual PTY generations. Concurrent opens are allowed,
 * but a later close invalidates every open that has not committed yet, and a later open invalidates a
 * pending close before it can remove newly reopened sessions or persistence.
 */
export class ProjectDirectoryLifecycleCoordinator {
  private nextGeneration = 0;
  private readonly states = new Map<string, ProjectDirectoryLifecycleState>();

  public runOpen<T>(
    cwd: string,
    operation: (ownership: ProjectDirectoryLifecycleOwnership) => Promise<T>,
  ): Promise<T> {
    const intent = this.reserveOpen(cwd);
    return this.execute(intent, operation);
  }

  public runOpenSync<T>(
    cwd: string,
    operation: (ownership: ProjectDirectoryLifecycleOwnership) => T,
  ): T {
    const intent = this.reserveOpen(cwd);
    const ownership = new ProjectDirectoryLifecycleOwnership(this, intent);
    try {
      return operation(ownership);
    } finally {
      this.finish(intent);
    }
  }

  public runClosure<T>(
    cwd: string,
    kind: ProjectDirectoryClosureKind,
    operation: (ownership: ProjectDirectoryLifecycleOwnership) => Promise<T>,
  ): Promise<T> {
    const intent = this.reserveClosure(cwd, kind);
    return this.execute(intent, operation);
  }

  public owns(intent: ProjectDirectoryLifecycleIntent): boolean {
    if (intent.finished || intent.superseded) {
      return false;
    }
    const state = this.states.get(intent.key);
    return intent.kind === 'open'
      ? state?.openIntents.has(intent) === true
      : state?.closeIntent === intent;
  }

  private async execute<T>(
    intent: ProjectDirectoryLifecycleIntent,
    operation: (ownership: ProjectDirectoryLifecycleOwnership) => Promise<T>,
  ): Promise<T> {
    const ownership = new ProjectDirectoryLifecycleOwnership(this, intent);
    try {
      return await operation(ownership);
    } finally {
      this.finish(intent);
    }
  }

  private finish(intent: ProjectDirectoryLifecycleIntent): void {
    if (intent.finished) {
      return;
    }
    intent.finished = true;
    const state = this.states.get(intent.key);
    if (!state) {
      return;
    }
    if (intent.kind === 'open') {
      state.openIntents.delete(intent);
    } else if (state.closeIntent === intent) {
      state.closeIntent = undefined;
    }
    if (!state.closeIntent && state.openIntents.size === 0) {
      this.states.delete(intent.key);
    }
  }

  private reserveOpen(cwd: string): ProjectDirectoryLifecycleIntent {
    const key = directoryKey(cwd);
    const state = this.states.get(key) ?? { openIntents: new Set() };
    if (state.closeIntent) {
      state.closeIntent.superseded = true;
      state.closeIntent = undefined;
    }
    const intent: ProjectDirectoryLifecycleIntent = {
      finished: false,
      generation: ++this.nextGeneration,
      key,
      kind: 'open',
      superseded: false,
    };
    state.openIntents.add(intent);
    this.states.set(key, state);
    return intent;
  }

  private reserveClosure(
    cwd: string,
    kind: ProjectDirectoryClosureKind,
  ): ProjectDirectoryLifecycleIntent {
    const key = directoryKey(cwd);
    const state = this.states.get(key) ?? { openIntents: new Set() };
    if (state.closeIntent) {
      state.closeIntent.superseded = true;
    }
    for (const openIntent of state.openIntents) {
      openIntent.superseded = true;
    }
    state.openIntents.clear();
    const intent: ProjectDirectoryLifecycleIntent = {
      finished: false,
      generation: ++this.nextGeneration,
      key,
      kind,
      superseded: false,
    };
    state.closeIntent = intent;
    this.states.set(key, state);
    return intent;
  }
}

export interface OwnedProjectDirectoryClosureOptions<TState> {
  captureSessionIds: () => readonly string[];
  closeRuntimeSession: (sessionId: string) => void;
  closeWorkspaceSession: (sessionId: string) => void;
  commit?: () => void;
  coordinator: ProjectDirectoryLifecycleCoordinator;
  cwd: string;
  invalidateAndWait: (sessionId: string) => Promise<void>;
  isSessionInDirectory: (sessionId: string, cwd: string) => boolean;
  kind: ProjectDirectoryClosureKind;
  readState: () => TState;
}

/**
 * Closes exactly the sessions captured by the accepted directory intent. Every captured operation must
 * unwind before its runtime and PTY are removed; a newer reopen makes the destructive commit stale.
 */
export const runOwnedProjectDirectoryClosure = <TState>(
  options: OwnedProjectDirectoryClosureOptions<TState>,
): Promise<TState> =>
  options.coordinator.runClosure(options.cwd, options.kind, async (ownership) => {
    const sessionIds = [...new Set(options.captureSessionIds())];
    await Promise.all(sessionIds.map(options.invalidateAndWait));
    ownership.assertCurrent();

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
    options.commit?.();
    return options.readState();
  });
