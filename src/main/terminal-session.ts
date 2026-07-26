import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IPty } from '@lydell/node-pty';
import * as pty from '@lydell/node-pty';
import type { TerminalStatus } from '../shared/contracts';
import { normalizeTerminalSize } from './directory';

type DataListener = (data: string) => void;
type StatusListener = (status: TerminalStatus) => void;
export type TerminalEnvironmentOverrides = Record<string, null | string>;

const buildEnvironment = (overrides: TerminalEnvironmentOverrides = {}): Record<string, string> => {
  const environment: Record<string, string> = {};
  const normalizedOverrides = new Map(
    Object.entries(overrides).map(([key, value]) => [key.toLowerCase(), { key, value }]),
  );

  for (const [key, value] of Object.entries(process.env)) {
    const override = normalizedOverrides.get(key.toLowerCase());
    if (override?.value === null) {
      continue;
    }
    if (typeof value === 'string' && !override) {
      environment[key] = value;
    }
  }

  for (const { key, value } of normalizedOverrides.values()) {
    if (value !== null) {
      environment[key] = value;
    }
  }

  environment.COLORTERM = 'truecolor';
  environment.TERM = 'xterm-256color';
  return environment;
};

const resolvePowerShell = (): string => {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const absolutePath = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  return existsSync(absolutePath) ? absolutePath : 'powershell.exe';
};

const powershellStartup = [
  'Import-Module PSReadLine -ErrorAction SilentlyContinue',
  "if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) { Set-PSReadLineKeyHandler -Chord 'Ctrl+j' -Function AddLine }",
].join('; ');

export class TerminalSession {
  private cols = 100;
  private generation = 0;
  private process?: IPty;
  private rows = 30;
  private status: TerminalStatus;

  public constructor(
    id: string,
    initialCwd: string,
    initialTitle: string,
    private readonly onData: DataListener,
    private readonly onStatus: StatusListener,
  ) {
    this.status = {
      cwd: initialCwd,
      id,
      phase: 'stopped',
      shell: 'Windows PowerShell',
      title: initialTitle,
    };
  }

  public getStatus(): TerminalStatus {
    return { ...this.status };
  }

  public setTitle(title: string): TerminalStatus {
    this.setStatus({ ...this.status, title });
    return this.getStatus();
  }

  public resize(cols: number, rows: number): void {
    const normalized = normalizeTerminalSize(cols, rows);
    this.cols = normalized.cols;
    this.rows = normalized.rows;

    if (this.process) {
      this.process.resize(this.cols, this.rows);
    }
  }

  public restart(
    cwd = this.status.cwd,
    environment: TerminalEnvironmentOverrides = {},
  ): TerminalStatus {
    this.stop(false);
    return this.start(cwd, environment);
  }

  public start(
    cwd = this.status.cwd,
    environment: TerminalEnvironmentOverrides = {},
  ): TerminalStatus {
    if (this.process) {
      return this.getStatus();
    }

    this.setStatus({
      cwd,
      id: this.status.id,
      phase: 'starting',
      shell: 'Windows PowerShell',
      title: this.status.title,
    });

    const generation = ++this.generation;

    try {
      const terminalProcess = pty.spawn(
        resolvePowerShell(),
        ['-NoLogo', '-NoExit', '-Command', powershellStartup],
        {
          cols: this.cols,
          cwd,
          env: buildEnvironment(environment),
          name: 'xterm-256color',
          rows: this.rows,
          useConpty: true,
        },
      );

      this.process = terminalProcess;
      terminalProcess.onData((data) => {
        if (generation === this.generation) {
          this.onData(data);
        }
      });
      terminalProcess.onExit(({ exitCode }) => {
        if (generation !== this.generation || this.process !== terminalProcess) {
          return;
        }

        this.process = undefined;
        this.setStatus({
          cwd: this.status.cwd,
          id: this.status.id,
          message: `PowerShell 已退出（代码 ${exitCode}）`,
          phase: 'stopped',
          shell: 'Windows PowerShell',
          title: this.status.title,
        });
      });

      this.setStatus({
        cwd,
        id: this.status.id,
        phase: 'running',
        pid: terminalProcess.pid,
        shell: 'Windows PowerShell',
        title: this.status.title,
      });
    } catch (error) {
      this.process = undefined;
      this.setStatus({
        cwd,
        id: this.status.id,
        message: error instanceof Error ? error.message : '无法启动 PowerShell。',
        phase: 'error',
        shell: 'Windows PowerShell',
        title: this.status.title,
      });
    }

    return this.getStatus();
  }

  public stop(emitStatus = true): TerminalStatus {
    const terminalProcess = this.process;
    this.process = undefined;
    this.generation += 1;

    if (terminalProcess) {
      terminalProcess.kill();
    }

    if (emitStatus) {
      this.setStatus({
        cwd: this.status.cwd,
        id: this.status.id,
        phase: 'stopped',
        shell: 'Windows PowerShell',
        title: this.status.title,
      });
    }

    return this.getStatus();
  }

  public write(data: string): void {
    if (!this.process || this.status.phase !== 'running') {
      return;
    }

    this.process.write(data);
  }

  private setStatus(status: TerminalStatus): void {
    this.status = status;
    this.onStatus(this.getStatus());
  }
}
