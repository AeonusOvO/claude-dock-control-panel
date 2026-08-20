import type {
  PtyGeneration,
  RuntimeActivityPhase,
  RuntimeActivitySnapshot,
  RuntimeTaskKind,
  RuntimeTaskStatus,
  RuntimeTaskView,
  RuntimeWebProcessView,
} from '../../shared/contracts';

export interface ClaudeRuntimeActivityEvent {
  agentId?: string;
  agentType?: string;
  backgroundTasks?: Array<{ description?: string; id?: string; kind?: string }>;
  backgroundTasksPresent?: boolean;
  description?: string;
  event: string;
  eventId: string;
  failureKind?: string;
  launchGeneration: number;
  ptyGeneration: PtyGeneration;
  sessionId: string;
  signaledAt: number;
  taskId?: string;
}

type RuntimeActivityRecord = RuntimeActivitySnapshot;

const COMPLETED_RETENTION_MS = 10 * 60_000;
const COMPLETED_LIMIT = 20;
const UNFINISHED_STALE_MS = 30 * 60_000;
const unfinished = (task: RuntimeTaskView): boolean =>
  task.status === 'queued' || task.status === 'running' || task.status === 'waiting';

const taskKind = (event: ClaudeRuntimeActivityEvent): RuntimeTaskKind => {
  const value = event.agentType?.toLowerCase() ?? '';
  if (value.includes('team')) return 'teammate';
  if (value.includes('subagent') || value.includes('agent')) return 'subagent';
  if (value.includes('mcp')) return 'mcp';
  if (value.includes('cron') || value.includes('schedule')) return 'cron';
  if (value.includes('shell') || value.includes('bash') || value.includes('process'))
    return 'shell';
  if (value.includes('web') || value.includes('server')) return 'web';
  if (value.includes('monitor') || value.includes('watch')) return 'monitor';
  if (event.event.startsWith('Subagent')) return 'subagent';
  return 'workflow';
};

const tokenUse = (kind: RuntimeTaskKind): RuntimeTaskView['tokenUse'] =>
  kind === 'subagent' || kind === 'teammate'
    ? 'likely'
    : kind === 'shell' || kind === 'web'
      ? 'none'
      : 'unknown';

export class RuntimeActivityRegistry {
  private readonly records = new Map<string, RuntimeActivityRecord>();
  private readonly waitingOwnerBySession = new Map<string, string>();

  public constructor(
    private readonly onChange: (state: RuntimeActivitySnapshot) => void = () => {},
  ) {}

  public beginLaunch(
    sessionId: string,
    launchGeneration: number,
    ptyGeneration: PtyGeneration,
  ): RuntimeActivitySnapshot {
    this.waitingOwnerBySession.delete(sessionId);
    const record: RuntimeActivityRecord = {
      launchGeneration,
      observedAt: Date.now(),
      phase: 'cli-idle',
      ptyGeneration,
      sessionId,
      subagentCount: 0,
      tasks: [],
      webProcesses: [],
      willResumeConversation: false,
    };
    this.records.set(sessionId, record);
    return this.publish(record);
  }

  public consume(event: ClaudeRuntimeActivityEvent): RuntimeActivitySnapshot {
    let record = this.records.get(event.sessionId);
    if (
      record &&
      (event.launchGeneration < record.launchGeneration ||
        (event.launchGeneration === record.launchGeneration &&
          event.ptyGeneration < record.ptyGeneration))
    ) {
      return this.clone(record);
    }
    if (
      !record ||
      record.launchGeneration !== event.launchGeneration ||
      record.ptyGeneration !== event.ptyGeneration
    ) {
      this.beginLaunch(event.sessionId, event.launchGeneration, event.ptyGeneration);
      record = this.records.get(event.sessionId)!;
    }
    record.observedAt = event.signaledAt;

    switch (event.event) {
      case 'UserPromptSubmit':
        this.waitingOwnerBySession.delete(event.sessionId);
        record.phase = 'foreground-running';
        record.willResumeConversation = false;
        break;
      case 'SubagentStart':
      case 'TaskCreated':
        this.upsertTask(record, event, event.event === 'TaskCreated' ? 'queued' : 'running');
        if (this.parentIsWaiting(record)) {
          record.phase = 'waiting-background';
          record.willResumeConversation = true;
        } else {
          record.phase = 'foreground-running';
        }
        break;
      case 'SubagentStop':
      case 'TaskCompleted':
        this.finishTask(record, event, 'completed');
        if (this.parentIsWaiting(record)) {
          record.phase = record.tasks.some(unfinished) ? 'waiting-background' : 'resuming';
          record.willResumeConversation = true;
        }
        break;
      case 'Stop': {
        if (event.backgroundTasksPresent) {
          const authoritativeIds = new Set(
            (event.backgroundTasks ?? []).map((task) => task.id).filter(Boolean),
          );
          for (const task of record.tasks) {
            if (unfinished(task) && !authoritativeIds.has(task.id)) {
              task.status = 'orphaned';
              task.updatedAt = event.signaledAt;
            }
          }
        }
        for (const background of event.backgroundTasks ?? []) {
          this.upsertTask(
            record,
            {
              ...event,
              agentType: background.kind ?? event.agentType,
              description: background.description,
              taskId: background.id,
            },
            'waiting',
          );
        }
        const waiting = record.tasks.some(unfinished);
        record.phase = waiting ? 'waiting-background' : 'cli-idle';
        record.willResumeConversation = waiting;
        if (waiting) {
          this.waitingOwnerBySession.set(event.sessionId, this.ownerKey(record));
        } else {
          this.waitingOwnerBySession.delete(event.sessionId);
        }
        break;
      }
      case 'StopFailure':
        this.waitingOwnerBySession.delete(event.sessionId);
        record.phase = 'failed';
        record.willResumeConversation = false;
        break;
      case 'SessionEnd':
        this.waitingOwnerBySession.delete(event.sessionId);
        for (const task of record.tasks) {
          if (unfinished(task)) task.status = 'orphaned';
        }
        record.phase = 'stopped';
        record.willResumeConversation = false;
        break;
    }

    this.prune(record);
    return this.publish(record);
  }

  public get(sessionId: string): RuntimeActivitySnapshot {
    const record = this.records.get(sessionId);
    if (record) {
      this.prune(record);
      return this.clone(record);
    }
    return this.clone({
      launchGeneration: 0,
      observedAt: Date.now(),
      phase: 'stopped',
      ptyGeneration: 0,
      sessionId,
      subagentCount: 0,
      tasks: [],
      webProcesses: [],
      willResumeConversation: false,
    });
  }

  public list(sessionId?: string): RuntimeActivitySnapshot[] {
    if (sessionId) {
      const record = this.records.get(sessionId);
      if (!record) return [];
      this.prune(record);
      return [this.clone(record)];
    }
    return [...this.records.values()]
      .map((record) => {
        this.prune(record);
        return this.clone(record);
      })
      .sort((left, right) => right.observedAt - left.observedAt);
  }

  public setPhase(sessionId: string, phase: RuntimeActivityPhase): RuntimeActivitySnapshot {
    const record = this.records.get(sessionId);
    if (!record) return this.get(sessionId);
    record.phase = phase;
    record.observedAt = Date.now();
    if (phase === 'stopped' || phase === 'failed') {
      this.waitingOwnerBySession.delete(sessionId);
      record.willResumeConversation = false;
    }
    return this.publish(record);
  }

  public setWebProcesses(
    sessionId: string,
    processes: RuntimeWebProcessView[],
  ): RuntimeActivitySnapshot {
    const record = this.records.get(sessionId);
    if (!record) return this.get(sessionId);
    this.prune(record);
    record.webProcesses = processes.map((process) => ({
      ...process,
      ports: [...process.ports],
      urls: process.urls.map((url) => ({ ...url })),
    }));
    record.observedAt = Date.now();
    return this.publish(record);
  }

  public stopSession(sessionId: string): RuntimeActivitySnapshot {
    return this.setPhase(sessionId, 'stopped');
  }

  private upsertTask(
    record: RuntimeActivityRecord,
    event: ClaudeRuntimeActivityEvent,
    status: RuntimeTaskStatus,
  ): void {
    const id = event.taskId || event.agentId || event.eventId;
    const existing = record.tasks.find((task) => task.id === id);
    const kind = taskKind(event);
    const next: RuntimeTaskView = {
      agentType: event.agentType,
      description:
        event.description ||
        (kind === 'subagent'
          ? `${event.agentType || 'Claude'} 子代理正在运行`
          : '后台任务正在运行'),
      id,
      kind,
      status,
      tokenUse: tokenUse(kind),
      updatedAt: event.signaledAt,
      willWakeParent: kind === 'subagent' || status === 'waiting' ? true : 'unknown',
    };
    if (existing) Object.assign(existing, next);
    else record.tasks.unshift(next);
    record.subagentCount = record.tasks.filter(
      (task) => (task.kind === 'subagent' || task.kind === 'teammate') && unfinished(task),
    ).length;
  }

  private finishTask(
    record: RuntimeActivityRecord,
    event: ClaudeRuntimeActivityEvent,
    status: RuntimeTaskStatus,
  ): void {
    const id = event.taskId || event.agentId;
    const existing = id
      ? record.tasks.find((task) => task.id === id)
      : record.tasks.find(unfinished);
    if (existing) {
      existing.status = status;
      existing.updatedAt = event.signaledAt;
    } else {
      this.upsertTask(record, event, status);
    }
    record.subagentCount = record.tasks.filter(
      (task) => (task.kind === 'subagent' || task.kind === 'teammate') && unfinished(task),
    ).length;
  }

  private prune(record: RuntimeActivityRecord): void {
    const now = Date.now();
    for (const task of record.tasks) {
      if (unfinished(task) && now - task.updatedAt > UNFINISHED_STALE_MS) {
        task.status = 'orphaned';
        task.updatedAt = now;
      }
    }
    const active = record.tasks.filter(unfinished);
    const completed = record.tasks
      .filter((task) => !unfinished(task) && now - task.updatedAt <= COMPLETED_RETENTION_MS)
      .slice(0, COMPLETED_LIMIT);
    record.tasks = [...active, ...completed];
    record.subagentCount = active.filter(
      (task) => task.kind === 'subagent' || task.kind === 'teammate',
    ).length;
  }

  private publish(record: RuntimeActivityRecord): RuntimeActivitySnapshot {
    const snapshot = this.clone(record);
    this.onChange(snapshot);
    return snapshot;
  }

  private ownerKey(record: RuntimeActivityRecord): string {
    return `${record.launchGeneration}:${record.ptyGeneration}`;
  }

  private parentIsWaiting(record: RuntimeActivityRecord): boolean {
    return this.waitingOwnerBySession.get(record.sessionId) === this.ownerKey(record);
  }

  private clone(record: RuntimeActivityRecord): RuntimeActivitySnapshot {
    return {
      ...record,
      tasks: record.tasks.map((task) => ({ ...task })),
      webProcesses: record.webProcesses.map((process) => ({
        ...process,
        ports: [...process.ports],
        urls: process.urls.map((url) => ({ ...url })),
      })),
    };
  }
}
