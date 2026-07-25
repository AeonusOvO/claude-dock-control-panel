import path from 'node:path';
import type { TerminalStatus, WorkspaceState } from '../shared/contracts';
import { TerminalSession, type TerminalEnvironmentOverrides } from './terminal-session';

export interface ManagedTerminal {
  getStatus: () => TerminalStatus;
  resize: (cols: number, rows: number) => void;
  restart: (cwd?: string, environment?: TerminalEnvironmentOverrides) => TerminalStatus;
  start: (cwd?: string, environment?: TerminalEnvironmentOverrides) => TerminalStatus;
  stop: (emitStatus?: boolean) => TerminalStatus;
  write: (data: string) => void;
}

type TerminalFactory = (
  id: string,
  initialCwd: string,
  onData: (data: string) => void,
  onStatus: (status: TerminalStatus) => void,
) => ManagedTerminal;

export interface OpenProjectResult {
  reused: boolean;
  state: WorkspaceState;
}

const defaultFactory: TerminalFactory = (id, initialCwd, onData, onStatus) =>
  new TerminalSession(id, initialCwd, onData, onStatus);

const sameDirectory = (left: string, right: string): boolean =>
  path.resolve(left).localeCompare(path.resolve(right), undefined, { sensitivity: 'base' }) === 0;

export class TerminalWorkspace {
  private activeSessionId = '';
  private nextSessionNumber = 1;
  private readonly sessions = new Map<string, ManagedTerminal>();

  public constructor(
    private readonly initialCwd: string,
    private readonly onData: (sessionId: string, data: string) => void,
    private readonly onState: (state: WorkspaceState) => void,
    private readonly terminalFactory: TerminalFactory = defaultFactory,
  ) {
    this.activeSessionId = this.createSession(initialCwd);
  }

  public activate(sessionId: string): WorkspaceState {
    this.requireSession(sessionId);
    this.activeSessionId = sessionId;
    this.emitState();
    return this.getState();
  }

  public close(sessionId: string): WorkspaceState {
    const session = this.requireSession(sessionId);
    const sessionIds = [...this.sessions.keys()];
    const closedIndex = sessionIds.indexOf(sessionId);

    session.stop(false);
    this.sessions.delete(sessionId);

    if (this.sessions.size === 0) {
      this.activeSessionId = this.createSession(this.initialCwd);
    } else if (this.activeSessionId === sessionId) {
      const nextId = sessionIds[closedIndex + 1] ?? sessionIds[closedIndex - 1];
      if (!nextId || !this.sessions.has(nextId)) {
        throw new Error('无法选择下一个项目会话。');
      }
      this.activeSessionId = nextId;
    }

    this.emitState();
    return this.getState();
  }

  public getActiveStatus(): TerminalStatus {
    return this.requireSession(this.activeSessionId).getStatus();
  }

  public getStatus(sessionId: string): TerminalStatus {
    return this.requireSession(sessionId).getStatus();
  }

  public getState(): WorkspaceState {
    return {
      activeSessionId: this.activeSessionId,
      sessions: [...this.sessions.values()].map((session) => session.getStatus()),
    };
  }

  public openProject(cwd: string): OpenProjectResult {
    const existing = [...this.sessions.values()].find((session) =>
      sameDirectory(session.getStatus().cwd, cwd),
    );

    if (existing) {
      const status = existing.getStatus();
      this.activeSessionId = status.id;
      if (status.phase === 'stopped' || status.phase === 'error') {
        existing.start(status.cwd);
      } else {
        this.emitState();
      }
      return { reused: true, state: this.getState() };
    }

    const sessionId = this.createSession(cwd);
    this.activeSessionId = sessionId;
    this.emitState();
    this.requireSession(sessionId).start(cwd);
    return { reused: false, state: this.getState() };
  }

  public resize(sessionId: string, cols: number, rows: number): void {
    this.requireSession(sessionId).resize(cols, rows);
  }

  public restart(
    sessionId: string,
    environment: TerminalEnvironmentOverrides = {},
  ): TerminalStatus {
    return this.requireSession(sessionId).restart(undefined, environment);
  }

  public shutdown(): void {
    for (const session of this.sessions.values()) {
      session.stop(false);
    }
  }

  public start(sessionId: string): TerminalStatus {
    return this.requireSession(sessionId).start();
  }

  public stop(sessionId: string): TerminalStatus {
    return this.requireSession(sessionId).stop();
  }

  public write(sessionId: string, data: string): void {
    this.requireSession(sessionId).write(data);
  }

  private createSession(cwd: string): string {
    const sessionId = `session-${this.nextSessionNumber}`;
    this.nextSessionNumber += 1;

    const session = this.terminalFactory(
      sessionId,
      cwd,
      (data) => {
        this.onData(sessionId, data);
      },
      () => {
        this.emitState();
      },
    );
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  private emitState(): void {
    this.onState(this.getState());
  }

  private requireSession(sessionId: string): ManagedTerminal {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('项目会话不存在或已关闭。');
    }
    return session;
  }
}
