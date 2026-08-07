import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IPty } from '@lydell/node-pty';
import * as pty from '@lydell/node-pty';
import type { PtyGeneration, TerminalStatus } from '../shared/contracts';
import {
  ansiBackground,
  ansiForeground,
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEMES,
  type TerminalThemeId,
  type TerminalThemePalette,
} from '../shared/terminal-themes';
import { normalizeTerminalSize } from './directory';

type DataListener = (ptyGeneration: PtyGeneration, data: string) => void;
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

const terminalFailure = (
  error: unknown,
  cwd: string,
): Pick<NonNullable<TerminalStatus>, 'diagnosticCode' | 'message'> => {
  if (!existsSync(cwd)) {
    return {
      diagnosticCode: 'CWD_UNAVAILABLE',
      message: '项目目录当前不可访问，请检查磁盘或重新选择目录。',
    };
  }
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const detail = `${String(record.code ?? '')} ${String(record.message ?? '')}`.toLowerCase();
  if (detail.includes('powershell') || detail.includes('enoent')) {
    return {
      diagnosticCode: 'POWERSHELL_UNAVAILABLE',
      message: '未能启动本机 PowerShell，请运行诊断后重试。',
    };
  }
  if (detail.includes('conpty') || detail.includes('node-pty') || detail.includes('.dll')) {
    return {
      diagnosticCode: 'NATIVE_BACKEND_UNAVAILABLE',
      message: '终端组件未能加载，请运行诊断或重新安装当前版本。',
    };
  }
  return {
    diagnosticCode: 'PTY_START_FAILED',
    message: '项目终端启动失败，请运行诊断后重试。',
  };
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
      ptyGeneration: this.generation,
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

  /** Applies the normalized application size and suppresses duplicate ConPTY redraw signals. */
  public resize(cols: number, rows: number): { cols: number; rows: number } {
    const normalized = normalizeTerminalSize(cols, rows);
    if (this.cols === normalized.cols && this.rows === normalized.rows) {
      return { cols: this.cols, rows: this.rows };
    }
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

    const generation = ++this.generation;
    this.setStatus({
      cwd,
      id: this.status.id,
      phase: 'starting',
      ptyGeneration: generation,
      shell: 'Windows 终端',
      title: this.status.title,
    });

    try {
      const startup = buildPowershellStartup(TERMINAL_THEMES[themeId].palette);
      const terminalProcess = pty.spawn(
        resolvePowerShell(),
        ['-NoLogo', '-NoProfile', '-NoExit', '-Command', startup],
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
        if (generation === this.generation && this.process === terminalProcess) {
          this.onData(generation, data);
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
          ptyGeneration: generation,
          shell: 'Windows 终端',
          title: this.status.title,
        });
      });

      this.setStatus({
        cwd,
        id: this.status.id,
        phase: 'running',
        pid: terminalProcess.pid,
        ptyGeneration: generation,
        shell: 'Windows 终端',
        title: this.status.title,
      });
    } catch (error) {
      this.process = undefined;
      const failure = terminalFailure(error, cwd);
      this.setStatus({
        cwd,
        diagnosticCode: failure.diagnosticCode,
        id: this.status.id,
        message: failure.message,
        phase: 'error',
        ptyGeneration: generation,
        shell: 'Windows 终端',
        title: this.status.title,
      });
    }

    return this.getStatus();
  }

  public stop(emitStatus = true): TerminalStatus {
    const terminalProcess = this.process;
    this.process = undefined;

    if (terminalProcess) {
      terminalProcess.kill();
    }

    if (emitStatus) {
      this.setStatus({
        cwd: this.status.cwd,
        id: this.status.id,
        phase: 'stopped',
        ptyGeneration: this.generation,
        shell: 'Windows 终端',
        title: this.status.title,
      });
    }

    return this.getStatus();
  }

  public stopIfGeneration(
    expectedGeneration: PtyGeneration,
    emitStatus = true,
  ): TerminalStatus | undefined {
    return expectedGeneration === this.generation ? this.stop(emitStatus) : undefined;
  }

  public write(expectedGeneration: PtyGeneration, data: string): boolean {
    if (
      expectedGeneration !== this.generation ||
      !this.process ||
      this.status.phase !== 'running'
    ) {
      return false;
    }

    this.process.write(data);
    return true;
  }

  private setStatus(status: TerminalStatus): void {
    this.status = status;
    this.onStatus(this.getStatus());
  }
}
