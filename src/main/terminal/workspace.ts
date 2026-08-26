import path from 'node:path';
import type {
  DevelopmentRuntime,
  PtyGeneration,
  TerminalStatus,
  TerminalWorkspaceState,
  WorkspaceState,
} from '../../shared/contracts';
import { DEFAULT_TERMINAL_THEME, type TerminalThemeId } from '../../shared/ui/terminal-themes';
import { normalizeClaudeSessionTitle } from '../claude/session-manager';
import { TerminalSession, type TerminalEnvironmentOverrides } from './session';

export interface ManagedTerminal {
  getStatus: () => TerminalStatus;
  resize: (cols: number, rows: number) => { cols: number; rows: number };
  restart: (
    cwd?: string,
    environment?: TerminalEnvironmentOverrides,
    themeId?: TerminalThemeId,
  ) => TerminalStatus;
  setTitle: (title: string) => TerminalStatus;
  start: (
    cwd?: string,
    environment?: TerminalEnvironmentOverrides,
    themeId?: TerminalThemeId,
  ) => TerminalStatus;
  stop: (emitStatus?: boolean) => TerminalStatus;
  stopIfGeneration: (
    expectedGeneration: PtyGeneration,
    emitStatus?: boolean,
  ) => TerminalStatus | undefined;
  write: (expectedGeneration: PtyGeneration, data: string) => boolean;
}

type TerminalFactory = (
  id: string,
  initialCwd: string,
  initialTitle: string,
  onData: (ptyGeneration: PtyGeneration, data: string) => void,
  onStatus: (status: TerminalStatus) => void,
) => ManagedTerminal;

export interface OpenProjectResult {
  reused: boolean;
  state: TerminalWorkspaceState;
}

/**
 * Merges live terminal sessions with the folders remembered on disk into the renderer's workspace
 * view. Declared here so every IPC domain that returns a workspace snapshot injects the same
 * signature instead of restating it.
 */
export type DescribeWorkspace = (state?: TerminalWorkspaceState) => WorkspaceState;

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
  private readonly claudeSessionTitles = new Map<string, string>();
  private currentThemeId: TerminalThemeId;
  private readonly developmentRuntimes = new Map<string, DevelopmentRuntime>();
  private nextSessionNumber = 1;
  private readonly sessions = new Map<string, ManagedTerminal>();
  private beforeActiveSessionChange: () => void = () => undefined;
  private environmentProvider: () => TerminalEnvironmentOverrides = () => ({});

  public constructor(
    private readonly onData: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
      data: string,
    ) => void,
    private readonly onState: (state: TerminalWorkspaceState) => void,
    private readonly terminalFactory: TerminalFactory = defaultFactory,
    initialThemeId: TerminalThemeId = DEFAULT_TERMINAL_THEME,
  ) {
    this.currentThemeId = initialThemeId;
  }

  public activate(sessionId: string): TerminalWorkspaceState {
    this.requireSession(sessionId);
    this.setActiveSession(sessionId);
    this.emitState();
    return this.getState();
  }

  public close(sessionId: string): TerminalWorkspaceState {
    const session = this.requireSession(sessionId);
    const sessionIds = [...this.sessions.keys()];
    const closedIndex = sessionIds.indexOf(sessionId);

    session.stop(false);
    this.sessions.delete(sessionId);
    this.claudeSessionTitles.delete(sessionId);
    this.developmentRuntimes.delete(sessionId);

    if (this.sessions.size === 0) {
      this.setActiveSession('');
    } else if (this.activeSessionId === sessionId) {
      const nextId = sessionIds[closedIndex + 1] ?? sessionIds[closedIndex - 1];
      if (!nextId || !this.sessions.has(nextId)) {
        throw new Error('无法选择下一个项目会话。');
      }
      this.setActiveSession(nextId);
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

  /** Runtime captured when this conversation was created; live siblings may use another engine. */
  public getDevelopmentRuntime(sessionId: string): DevelopmentRuntime {
    this.requireSession(sessionId);
    return this.developmentRuntimes.get(sessionId) ?? 'claude';
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
  public openProject(cwd: string, runtime: DevelopmentRuntime = 'claude'): OpenProjectResult {
    const existingId = this.sessionIdsForDirectory(cwd)[0];

    if (existingId) {
      const existing = this.requireSession(existingId);
      const status = existing.getStatus();
      this.setActiveSession(status.id);
      if (status.phase === 'stopped' || status.phase === 'error') {
        existing.start(status.cwd, this.withDefaultEnvironment(), this.currentThemeId);
      } else {
        this.emitState();
      }
      return { reused: true, state: this.getState() };
    }

    return { reused: false, state: this.openConversation(cwd, undefined, runtime) };
  }

  /** Always create an additional concurrent conversation for this folder. */
  public openConversation(
    cwd: string,
    title?: string,
    runtime: DevelopmentRuntime = 'claude',
  ): TerminalWorkspaceState {
    const sessionId = this.createSession(cwd, title ?? this.nextConversationTitle(cwd), runtime);
    this.setActiveSession(sessionId);
    this.emitState();
    this.requireSession(sessionId).start(cwd, this.withDefaultEnvironment(), this.currentThemeId);
    return this.getState();
  }

  public renameSession(sessionId: string, title: string): TerminalWorkspaceState {
    const normalized = normalizeClaudeSessionTitle(title);
    this.requireSession(sessionId).setTitle(normalized);
    return this.getState();
  }

  /**
   * Mirrors Claude Code's official statusLine.session_name into the workspace label. Remembering
   * the last observed value prevents a repeated, stale status-line tick from undoing a local rename
   * while Claude Code is still processing the matching `/rename` command.
   */
  public syncClaudeSessionTitle(sessionId: string, title: string): boolean {
    const session = this.requireSession(sessionId);
    const normalized = normalizeClaudeSessionTitle(title);
    const previousClaudeTitle = this.claudeSessionTitles.get(sessionId);
    this.claudeSessionTitles.set(sessionId, normalized);

    if (session.getStatus().title === normalized || previousClaudeTitle === normalized) {
      return false;
    }

    session.setTitle(normalized);
    return true;
  }

  /** Returns the size the PTY actually adopted, which the renderer uses to keep xterm in step. */
  public resize(
    sessionId: string,
    expectedGeneration: PtyGeneration,
    cols: number,
    rows: number,
  ): { cols: number; rows: number } | undefined {
    const session = this.requireSession(sessionId);
    return session.getStatus().ptyGeneration === expectedGeneration
      ? session.resize(cols, rows)
      : undefined;
  }

  public restart(
    sessionId: string,
    environment: TerminalEnvironmentOverrides = {},
  ): TerminalStatus {
    return this.requireSession(sessionId).restart(
      undefined,
      this.withDefaultEnvironment(environment),
      this.currentThemeId,
    );
  }

  public setBeforeActiveSessionChange(callback: () => void): void {
    this.beforeActiveSessionChange = callback;
  }

  public setEnvironmentProvider(provider: () => TerminalEnvironmentOverrides): void {
    this.environmentProvider = provider;
  }

  /** Updates the palette used by future starts/restarts without mutating a live PowerShell line. */
  public setTheme(themeId: TerminalThemeId): void {
    this.currentThemeId = themeId;
  }

  public shutdown(): void {
    for (const session of this.sessions.values()) {
      session.stop(false);
    }
  }

  public start(sessionId: string): TerminalStatus {
    return this.requireSession(sessionId).start(
      undefined,
      this.withDefaultEnvironment(),
      this.currentThemeId,
    );
  }

  public stop(sessionId: string): TerminalStatus {
    return this.requireSession(sessionId).stop();
  }

  public stopIfGeneration(
    sessionId: string,
    expectedGeneration: PtyGeneration,
    emitStatus = true,
  ): TerminalStatus | undefined {
    return this.requireSession(sessionId).stopIfGeneration(expectedGeneration, emitStatus);
  }

  public write(sessionId: string, expectedGeneration: PtyGeneration, data: string): boolean {
    return this.requireSession(sessionId).write(expectedGeneration, data);
  }

  private nextConversationTitle(cwd: string): string {
    return `对话 ${this.sessionIdsForDirectory(cwd).length + 1}`;
  }

  private withDefaultEnvironment(
    environment: TerminalEnvironmentOverrides = {},
  ): TerminalEnvironmentOverrides {
    return { ...this.environmentProvider(), ...environment };
  }

  private createSession(
    cwd: string,
    title = '对话 1',
    runtime: DevelopmentRuntime = 'claude',
  ): string {
    const sessionId = `session-${this.nextSessionNumber}`;
    this.nextSessionNumber += 1;

    const session = this.terminalFactory(
      sessionId,
      cwd,
      title,
      (ptyGeneration, data) => {
        this.onData(sessionId, ptyGeneration, data);
      },
      () => {
        this.emitState();
      },
    );
    this.sessions.set(sessionId, session);
    this.developmentRuntimes.set(sessionId, runtime);
    return sessionId;
  }

  private emitState(): void {
    this.onState(this.getState());
  }

  private setActiveSession(sessionId: string): void {
    if (this.activeSessionId === sessionId) return;
    this.beforeActiveSessionChange();
    this.activeSessionId = sessionId;
  }

  private requireSession(sessionId: string): ManagedTerminal {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('项目会话不存在或已关闭。');
    }
    return session;
  }
}
