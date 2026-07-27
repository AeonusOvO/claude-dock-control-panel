import path from 'node:path';
import type { TerminalStatus, TerminalWorkspaceState } from '../shared/contracts';
import { TerminalSession, type TerminalEnvironmentOverrides } from './terminal-session';

export interface ManagedTerminal {
  getStatus: () => TerminalStatus;
  resize: (cols: number, rows: number) => { cols: number; rows: number };
  restart: (cwd?: string, environment?: TerminalEnvironmentOverrides) => TerminalStatus;
  setTitle: (title: string) => TerminalStatus;
  start: (cwd?: string, environment?: TerminalEnvironmentOverrides) => TerminalStatus;
  stop: (emitStatus?: boolean) => TerminalStatus;
  write: (data: string) => void;
}

type TerminalFactory = (
  id: string,
  initialCwd: string,
  initialTitle: string,
  onData: (data: string) => void,
  onStatus: (status: TerminalStatus) => void,
) => ManagedTerminal;

export interface OpenProjectResult {
  reused: boolean;
  state: TerminalWorkspaceState;
}

const defaultFactory: TerminalFactory = (id, initialCwd, initialTitle, onData, onStatus) =>
  new TerminalSession(id, initialCwd, initialTitle, onData, onStatus);

export const sameDirectory = (left: string, right: string): boolean =>
  path.resolve(left).localeCompare(path.resolve(right), undefined, { sensitivity: 'base' }) === 0;

/**
 * A workspace holds only real project conversations. It is legitimately empty — at first launch,
 * and again after the last conversation is closed — because a session always belongs to a folder
 * the user chose. Spawning a PowerShell in the home directory to avoid the empty case would show a
 * project named after the Windows account that the user never opened.
 */
export class TerminalWorkspace {
  private activeSessionId = '';
  private nextSessionNumber = 1;
  private readonly sessions = new Map<string, ManagedTerminal>();

  public constructor(
    private readonly onData: (sessionId: string, data: string) => void,
    private readonly onState: (state: TerminalWorkspaceState) => void,
    private readonly terminalFactory: TerminalFactory = defaultFactory,
  ) {}

  public activate(sessionId: string): TerminalWorkspaceState {
    this.requireSession(sessionId);
    this.activeSessionId = sessionId;
    this.emitState();
    return this.getState();
  }

  public close(sessionId: string): TerminalWorkspaceState {
    const session = this.requireSession(sessionId);
    const sessionIds = [...this.sessions.keys()];
    const closedIndex = sessionIds.indexOf(sessionId);

    session.stop(false);
    this.sessions.delete(sessionId);

    if (this.sessions.size === 0) {
      this.activeSessionId = '';
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

  /** Close every conversation that belongs to one project folder. */
  public closeDirectory(cwd: string): TerminalWorkspaceState {
    const targets = this.sessionIdsForDirectory(cwd);
    if (targets.length === 0) {
      return this.getState();
    }
    for (const sessionId of targets) {
      this.close(sessionId);
    }
    return this.getState();
  }

  /** `undefined` when no conversation is open — the startup state before a project is picked. */
  public getActiveStatus(): TerminalStatus | undefined {
    return this.sessions.get(this.activeSessionId)?.getStatus();
  }

  public getStatus(sessionId: string): TerminalStatus {
    return this.requireSession(sessionId).getStatus();
  }

  public getState(): TerminalWorkspaceState {
    return {
      activeSessionId: this.activeSessionId,
      sessions: [...this.sessions.values()].map((session) => session.getStatus()),
    };
  }

  public hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  public sessionIdsForDirectory(cwd: string): string[] {
    return [...this.sessions.values()]
      .filter((session) => sameDirectory(session.getStatus().cwd, cwd))
      .map((session) => session.getStatus().id);
  }

  /**
   * Focus a folder: reuse its first conversation when it is already open, otherwise
   * create the folder's first one. Use `openConversation` to add a parallel one.
   */
  public openProject(cwd: string): OpenProjectResult {
    const existingId = this.sessionIdsForDirectory(cwd)[0];

    if (existingId) {
      const existing = this.requireSession(existingId);
      const status = existing.getStatus();
      this.activeSessionId = status.id;
      if (status.phase === 'stopped' || status.phase === 'error') {
        existing.start(status.cwd);
      } else {
        this.emitState();
      }
      return { reused: true, state: this.getState() };
    }

    return { reused: false, state: this.openConversation(cwd) };
  }

  /** Always create an additional concurrent conversation for this folder. */
  public openConversation(cwd: string, title?: string): TerminalWorkspaceState {
    const sessionId = this.createSession(cwd, title ?? this.nextConversationTitle(cwd));
    this.activeSessionId = sessionId;
    this.emitState();
    this.requireSession(sessionId).start(cwd);
    return this.getState();
  }

  public renameSession(sessionId: string, title: string): TerminalWorkspaceState {
    const normalized = title.trim();
    if (!normalized || normalized.length > 60 || /[\r\n]/.test(normalized)) {
      throw new Error('对话名称需为 1-60 个字符，且不能换行。');
    }
    this.requireSession(sessionId).setTitle(normalized);
    return this.getState();
  }

  /** Returns the size the PTY actually adopted, which the renderer uses to keep xterm in step. */
  public resize(sessionId: string, cols: number, rows: number): { cols: number; rows: number } {
    return this.requireSession(sessionId).resize(cols, rows);
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

  private nextConversationTitle(cwd: string): string {
    return `对话 ${this.sessionIdsForDirectory(cwd).length + 1}`;
  }

  private createSession(cwd: string, title = '对话 1'): string {
    const sessionId = `session-${this.nextSessionNumber}`;
    this.nextSessionNumber += 1;

    const session = this.terminalFactory(
      sessionId,
      cwd,
      title,
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
