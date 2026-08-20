import type { PtyGeneration, TerminalStatus } from '../../shared/contracts';
import type { ManagedTerminal } from './workspace';

/**
 * A process-free terminal used by isolated visual and integration profiles. It behaves like a
 * running workspace slot so the renderer can exercise project-scoped UI, but it never imports or
 * starts node-pty, PowerShell, Claude Code or Codex.
 */
export class IsolatedTerminal implements ManagedTerminal {
  private status: TerminalStatus;

  public constructor(
    id: string,
    initialCwd: string,
    initialTitle: string,
    private readonly onStatus: (status: TerminalStatus) => void,
  ) {
    this.status = {
      cwd: initialCwd,
      id,
      phase: 'stopped',
      ptyGeneration: 0,
      shell: 'Isolated fixture',
      title: initialTitle,
    };
  }

  public getStatus(): TerminalStatus {
    return { ...this.status };
  }

  public resize(cols: number, rows: number): { cols: number; rows: number } {
    return { cols, rows };
  }

  public restart(cwd?: string): TerminalStatus {
    this.stop(false);
    return this.start(cwd);
  }

  public setTitle(title: string): TerminalStatus {
    return this.update({ ...this.status, title });
  }

  public start(cwd?: string): TerminalStatus {
    if (this.status.phase === 'running') return this.getStatus();
    return this.update({
      ...this.status,
      cwd: cwd ?? this.status.cwd,
      phase: 'running',
      ptyGeneration: this.status.ptyGeneration + 1,
    });
  }

  public stop(emitStatus = true): TerminalStatus {
    const next = { ...this.status, phase: 'stopped' as const };
    if (!emitStatus) {
      this.status = next;
      return this.getStatus();
    }
    return this.update(next);
  }

  public stopIfGeneration(
    expectedGeneration: PtyGeneration,
    emitStatus = true,
  ): TerminalStatus | undefined {
    return expectedGeneration === this.status.ptyGeneration ? this.stop(emitStatus) : undefined;
  }

  public write(_expectedGeneration: PtyGeneration, _data: string): boolean {
    return false;
  }

  private update(status: TerminalStatus): TerminalStatus {
    this.status = status;
    const copy = this.getStatus();
    this.onStatus(copy);
    return copy;
  }
}
