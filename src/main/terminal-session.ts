import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IPty } from '@lydell/node-pty';
import * as pty from '@lydell/node-pty';
import type { TerminalStatus } from '../shared/contracts';
import {
  ansiBackground,
  ansiForeground,
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEMES,
  type TerminalThemeId,
  type TerminalThemePalette,
} from '../shared/terminal-themes';
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

const quotedAnsiForeground = (hex: string): string => `"${ansiForeground(hex)}"`;
const quotedAnsiBackground = (hex: string): string => `"${ansiBackground(hex)}"`;

/**
 * Builds the startup script for one PowerShell spawn. Keeping palette selection at this boundary
 * avoids injecting commands into a live PSReadLine/Claude TUI when the application theme changes.
 */
export const buildPowershellStartup = (palette: TerminalThemePalette): string =>
  [
    '$utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $global:OutputEncoding = $utf8',
    'Import-Module PSReadLine -ErrorAction SilentlyContinue',
    [
      'if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {',
      "Set-PSReadLineKeyHandler -Chord 'Ctrl+j' -Function AddLine;",
      [
        'Set-PSReadLineOption -Colors @{',
        `Command = ${quotedAnsiForeground(palette.brightCyan)};`,
        `Parameter = ${quotedAnsiForeground(palette.brightBlack)};`,
        `Operator = ${quotedAnsiForeground(palette.magenta)};`,
        `Variable = ${quotedAnsiForeground(palette.yellow)};`,
        `String = ${quotedAnsiForeground(palette.green)};`,
        `Number = ${quotedAnsiForeground(palette.blue)};`,
        `Type = ${quotedAnsiForeground(palette.cyan)};`,
        `Comment = ${quotedAnsiForeground(palette.brightBlack)};`,
        `Default = ${quotedAnsiForeground(palette.foreground)};`,
        `Error = ${quotedAnsiForeground(palette.red)};`,
        `Selection = ${quotedAnsiBackground(palette.selectionBackground)}`,
        '};',
      ].join(' '),
      "Set-PSReadLineKeyHandler -Chord 'Backspace' -ScriptBlock {",
      "$line = ''; $cursor = 0;",
      '[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor);',
      'if ($cursor -gt 0 -and $line[$cursor - 1] -eq "`n") {',
      "[Microsoft.PowerShell.PSConsoleReadLine]::Replace($cursor - 1, 1, '');",
      '[Microsoft.PowerShell.PSConsoleReadLine]::SetCursorPosition($cursor - 1);',
      '} else { [Microsoft.PowerShell.PSConsoleReadLine]::BackwardDeleteChar($null, $null) }',
      '}',
      '}',
    ].join(' '),
  ].join('; ');

/** Backward-compatible default-theme script for existing imports and syntax checks. */
export const powershellStartup = buildPowershellStartup(
  TERMINAL_THEMES[DEFAULT_TERMINAL_THEME].palette,
);

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
      shell: 'Windows 终端',
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

  /**
   * Applies a size and reports the size the PTY actually adopted. The two can differ: sizes are
   * clamped, and PSReadLine repaints its edit buffer with ABSOLUTE cursor moves (pressing Ctrl+C
   * emits e.g. `ESC[10;27H`). If xterm believes it has different dimensions than ConPTY, that
   * repaint lands on the wrong row and the previous screen is left behind — which is what the
   * "two screens stacked on top of each other" bug is. The caller echoes this back so the
   * renderer can force xterm onto the same grid.
   */
  public resize(cols: number, rows: number): { cols: number; rows: number } {
    const normalized = normalizeTerminalSize(cols, rows);
    this.cols = normalized.cols;
    this.rows = normalized.rows;

    if (this.process) {
      this.process.resize(this.cols, this.rows);
    }

    return { cols: this.cols, rows: this.rows };
  }

  public restart(
    cwd = this.status.cwd,
    environment: TerminalEnvironmentOverrides = {},
    themeId: TerminalThemeId = DEFAULT_TERMINAL_THEME,
  ): TerminalStatus {
    this.stop(false);
    return this.start(cwd, environment, themeId);
  }

  public start(
    cwd = this.status.cwd,
    environment: TerminalEnvironmentOverrides = {},
    themeId: TerminalThemeId = DEFAULT_TERMINAL_THEME,
  ): TerminalStatus {
    if (this.process) {
      return this.getStatus();
    }

    this.setStatus({
      cwd,
      id: this.status.id,
      phase: 'starting',
      shell: 'Windows 终端',
      title: this.status.title,
    });

    const generation = ++this.generation;

    try {
      const startup = buildPowershellStartup(TERMINAL_THEMES[themeId].palette);
      const terminalProcess = pty.spawn(
        resolvePowerShell(),
        ['-NoLogo', '-NoExit', '-Command', startup],
        {
          cols: this.cols,
          cwd,
          env: buildEnvironment(environment),
          name: 'xterm-256color',
          rows: this.rows,
          useConpty: true,
          // The bundled conpty.dll (Windows Terminal rearchitecture) preserves soft-wrap
          // continuations across resizes. The inbox ConPTY hard-wraps repainted lines at the old
          // width, which is why resizing left Claude Code output broken at stale column positions.
          useConptyDll: true,
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
          message: `终端已退出（代码 ${exitCode}）`,
          phase: 'stopped',
          shell: 'Windows 终端',
          title: this.status.title,
        });
      });

      this.setStatus({
        cwd,
        id: this.status.id,
        phase: 'running',
        pid: terminalProcess.pid,
        shell: 'Windows 终端',
        title: this.status.title,
      });
    } catch {
      this.process = undefined;
      this.setStatus({
        cwd,
        id: this.status.id,
        message: '无法启动终端；请检查系统命令环境与当前目录。',
        phase: 'error',
        shell: 'Windows 终端',
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
        shell: 'Windows 终端',
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
