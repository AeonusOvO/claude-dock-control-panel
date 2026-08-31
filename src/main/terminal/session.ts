import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IPty } from '@lydell/node-pty';
import * as pty from '@lydell/node-pty';
import type { PtyGeneration, TerminalStatus } from '../../shared/contracts';
import { DEFAULT_TERMINAL_SIZE } from '../../shared/contracts/terminal';
import {
  ansiBackground,
  ansiForeground,
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEMES,
  type TerminalThemeId,
  type TerminalThemePalette,
} from '../../shared/ui/terminal-themes';
import { normalizeTerminalSize } from '../infra/directory';
import { resolveWindowsSystemExecutable } from '../infra/windows-system-executable';

type DataListener = (ptyGeneration: PtyGeneration, data: string) => void;
type StatusListener = (status: TerminalStatus) => void;
export type TerminalEnvironmentOverrides = Record<string, null | string>;

export const POWERSHELL_STARTUP_COMMAND_ENV = 'CLAUDEDOCK_STARTUP_COMMAND';
export const POWERSHELL_STARTUP_TRIGGER = 'Invoke-ClaudeDockStartup';

/**
 * PID handshake. `@lydell/node-pty` reports `proc.pid === 0` under both ConPTY modes, so the
 * shell announces its real PID as an OSC sequence emitted by the very first startup statement.
 * The session strips the sequence from the renderer stream and records the PID, which restores
 * the runtime process registry's owner filter and enables immediate tree termination on close.
 */
const PTY_PID_OSC_NAME = 'CLAUDEDOCK_PID';
const PTY_PID_OSC_PREFIX = `\x1b]${PTY_PID_OSC_NAME};`;
// eslint-disable-next-line no-control-regex -- the handshake itself is a control sequence
const PTY_PID_OSC_PATTERN = /\x1b\]CLAUDEDOCK_PID;(\d+)(?:\x07|\x1b\\)/g;
const PTY_PID_OSC_BUDGET = 8_192;

/**
 * Returns the length of the trailing slice of `text` that could still grow into the PID
 * handshake (a partial `\x1b]CLAUDEDOCK_PID;<digits>` run). CSI sequences such as `\x1b[?25h`
 * never match — the second character differs — so ordinary VT traffic is not buffered.
 */
const pidMarkerHoldbackLength = (text: string): number => {
  const max = Math.min(text.length, PTY_PID_OSC_PREFIX.length + 10);
  for (let length = max; length > 0; length -= 1) {
    const tail = text.slice(text.length - length);
    if (PTY_PID_OSC_PREFIX.startsWith(tail)) {
      return length;
    }
    if (
      tail.startsWith(PTY_PID_OSC_PREFIX) &&
      /^\d+$/.test(tail.slice(PTY_PID_OSC_PREFIX.length))
    ) {
      return length;
    }
  }
  return 0;
};

const buildEnvironment = (overrides: TerminalEnvironmentOverrides = {}): Record<string, string> => {
  const environment: Record<string, string> = {};
  const normalizedOverrides = new Map(
    Object.entries(overrides).map(([key, value]) => [key.toLowerCase(), { key, value }]),
  );

  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toLowerCase();
    const override = normalizedOverrides.get(normalizedKey);
    // The one-shot script is trusted only when this spawn supplied it explicitly.
    if (
      override?.value === null ||
      (normalizedKey === POWERSHELL_STARTUP_COMMAND_ENV.toLowerCase() && !override)
    ) {
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

const resolvePowerShell = (): string => resolveWindowsSystemExecutable('powershell.exe');

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

const powershellStartupCommandBootstrap = [
  `if (-not [string]::IsNullOrEmpty($env:${POWERSHELL_STARTUP_COMMAND_ENV})) {`,
  `$global:ClaudeDockStartupCommand = $env:${POWERSHELL_STARTUP_COMMAND_ENV};`,
  `Remove-Item Env:${POWERSHELL_STARTUP_COMMAND_ENV} -ErrorAction SilentlyContinue;`,
  `function global:${POWERSHELL_STARTUP_TRIGGER} {`,
  '$command = $global:ClaudeDockStartupCommand;',
  'Remove-Variable ClaudeDockStartupCommand -Scope Global -ErrorAction SilentlyContinue;',
  `Remove-Item Function:${POWERSHELL_STARTUP_TRIGGER} -ErrorAction SilentlyContinue;`,
  'if (-not [string]::IsNullOrEmpty($command)) { & ([ScriptBlock]::Create($command)) }',
  '}',
  '}',
].join(' ');

/**
 * Builds the startup script for one PowerShell spawn. Keeping palette selection at this boundary
 * avoids injecting commands into a live PSReadLine/Claude TUI when the application theme changes.
 */
export const buildPowershellStartup = (palette: TerminalThemePalette): string =>
  [
    // First statement on purpose: the handshake must precede every other terminal output. BEL
    // terminator; PowerShell 5.1 has no `` `e `` escape, hence [char]27 and [char]7.
    `[Console]::Write([string][char]27 + ']${PTY_PID_OSC_NAME};' + $PID + [string][char]7)`,
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
    powershellStartupCommandBootstrap,
  ].join('; ');

/** Backward-compatible default-theme script for existing imports and syntax checks. */
export const powershellStartup = buildPowershellStartup(
  TERMINAL_THEMES[DEFAULT_TERMINAL_THEME].palette,
);

const PTY_SWEEP_TIMEOUT_MS = 8_000;

/**
 * Windows ConPTY's `kill()` only closes the pseudoconsole: a PowerShell hosting a foreground
 * child (Claude Code) stays alive and keeps the pty pipes open, so its process tree leaks and the
 * main process's event loop never drains. Every PowerShell this app spawns embeds the startup
 * trigger in its command line, which makes exactly those trees — children included — safe to
 * force-kill here. Fire-and-forget by design; the quit watchdog bounds the wait if this stalls.
 */
export const terminateSpawnedPowershells = (): void => {
  if (process.platform !== 'win32') return;
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        // $PID excludes the sweeper's own PowerShell, whose command line carries the trigger too.
        'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" |',
        `Where-Object { $_.CommandLine -like '*${POWERSHELL_STARTUP_TRIGGER}*' -and $_.ProcessId -ne $PID } |`,
        'ForEach-Object { taskkill.exe /F /T /PID $_.ProcessId }',
      ].join(' '),
    ],
    { timeout: PTY_SWEEP_TIMEOUT_MS, windowsHide: true },
    () => undefined,
  );
};

const PTY_KILL_TIMEOUT_MS = 3_000;
const PTY_EXIT_WAIT_TIMEOUT_MS = PTY_KILL_TIMEOUT_MS + 1_000;

/**
 * Reliable runtime tree termination for a single session. `kill()` only closes the
 * pseudoconsole — a PowerShell hosting a foreground child survives it — so once the handshake
 * has revealed the shell PID, `taskkill /F /T` takes the whole tree down the moment a session
 * closes instead of waiting for the quit-time sweep. Fire-and-forget: an already-dead tree
 * just errors into the ignored callback. A missing or zero PID keeps the degraded behaviour.
 */
export const killWindowsProcessTree = (pid: number): void => {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return;
  execFile(
    'taskkill.exe',
    ['/F', '/T', '/PID', String(pid)],
    { timeout: PTY_KILL_TIMEOUT_MS, windowsHide: true },
    () => undefined,
  );
};

interface PtyExitWaiter {
  readonly resolve: (exited: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

export class TerminalSession {
  private cols = DEFAULT_TERMINAL_SIZE.cols;
  private generation = 0;
  private pidMarkerBuffer = '';
  private pidMarkerDone = true;
  private readonly exitWaiters = new Map<number, Set<PtyExitWaiter>>();
  private process?: IPty;
  private rows = DEFAULT_TERMINAL_SIZE.rows;
  private status: TerminalStatus;

  public constructor(
    id: string,
    initialCwd: string,
    initialTitle: string,
    private readonly onData: DataListener,
    private readonly onStatus: StatusListener,
    private readonly killTree: (pid: number) => void = killWindowsProcessTree,
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
    return { ...this.status, size: { cols: this.cols, rows: this.rows } };
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
    this.pidMarkerBuffer = '';
    this.pidMarkerDone = false;
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
        if (generation !== this.generation || this.process !== terminalProcess) {
          return;
        }
        const visible = this.consumePidMarker(data);
        if (visible.length > 0) {
          this.onData(generation, visible);
        }
      });
      terminalProcess.onExit(({ exitCode }) => {
        if (generation !== this.generation) return;

        if (this.process === terminalProcess) {
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
        }
        this.resolveExitWaiters(generation, true);
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
    const shellPid = this.status.pid ?? 0;
    this.process = undefined;

    if (terminalProcess) {
      terminalProcess.kill();
    }
    if (shellPid > 0) {
      this.killTree(shellPid);
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

  /**
   * Stops one exact generation and waits for node-pty's exit callback. A timeout is a deliberate
   * failure signal: callers that are about to start another writer must not assume kill() completed.
   */
  public async stopIfGenerationAndWait(
    expectedGeneration: PtyGeneration,
    emitStatus = true,
  ): Promise<TerminalStatus | undefined> {
    if (expectedGeneration !== this.generation) return undefined;
    const terminalProcess = this.process;
    if (!terminalProcess) return this.getStatus();

    const exited = this.waitForExit(expectedGeneration, terminalProcess);
    const status = this.stopIfGeneration(expectedGeneration, emitStatus);
    if (!status) return undefined;
    if (!(await exited)) return undefined;
    return this.getStatus();
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

  /**
   * Strips the PID handshake OSC sequence from the PTY stream before it reaches the renderer
   * and records the shell's real PID. A trailing partial sequence is held back until the next
   * chunk completes it; if the handshake has not arrived within the byte budget the stream is
   * flushed unchanged and the session stays on the degraded pid=0 path (quit-time sweep).
   */
  private consumePidMarker(data: string): string {
    if (this.pidMarkerDone) {
      return data;
    }

    const stream = this.pidMarkerBuffer + data;
    let shellPid = 0;
    const stripped = stream.replace(PTY_PID_OSC_PATTERN, (_match: string, pid: string) => {
      shellPid = Number(pid);
      return '';
    });

    if (shellPid > 0) {
      this.pidMarkerDone = true;
      this.pidMarkerBuffer = '';
      if (this.status.phase === 'running' && this.status.pid !== shellPid) {
        this.setStatus({ ...this.status, pid: shellPid });
      }
      return stripped;
    }

    if (stream.length > PTY_PID_OSC_BUDGET) {
      this.pidMarkerDone = true;
      this.pidMarkerBuffer = '';
      return stream;
    }

    const holdback = pidMarkerHoldbackLength(stripped);
    this.pidMarkerBuffer = holdback > 0 ? stripped.slice(stripped.length - holdback) : '';
    return holdback > 0 ? stripped.slice(0, stripped.length - holdback) : stripped;
  }

  private waitForExit(expectedGeneration: PtyGeneration, terminalProcess: IPty): Promise<boolean> {
    if (expectedGeneration !== this.generation || this.process !== terminalProcess) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.exitWaiters.get(expectedGeneration);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.exitWaiters.delete(expectedGeneration);
        resolve(false);
      }, PTY_EXIT_WAIT_TIMEOUT_MS);
      timer.unref();
      const waiter: PtyExitWaiter = {
        resolve: (exited) => {
          clearTimeout(timer);
          resolve(exited);
        },
        timer,
      };
      const waiters = this.exitWaiters.get(expectedGeneration) ?? new Set<PtyExitWaiter>();
      waiters.add(waiter);
      this.exitWaiters.set(expectedGeneration, waiters);
    });
  }

  private resolveExitWaiters(expectedGeneration: PtyGeneration, exited: boolean): void {
    const waiters = this.exitWaiters.get(expectedGeneration);
    if (!waiters) return;
    this.exitWaiters.delete(expectedGeneration);
    for (const waiter of waiters) waiter.resolve(exited);
  }

  private setStatus(status: TerminalStatus): void {
    this.status = status;
    this.onStatus(this.getStatus());
  }
}
