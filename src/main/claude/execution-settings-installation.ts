import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeExecutionInstallationSnapshot } from '../../shared/contracts/claude-execution-settings';
import { AsyncRefreshCache } from '../infra/async-refresh-cache';

const execFileAsync = promisify(execFile);
const INSTALLATION_CACHE_TTL_MS = 30_000;
const CLAUDE_VERSION_PATTERN = /(?:^|\s)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\s|$)/;

const CLAUDE_INSTALLATION_COMMAND = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  '$command = Get-Command claude -ErrorAction Stop; Write-Output $command.Source; & claude --version',
] as const);

export interface ClaudeExecutionInstallationCommandResult {
  stdout: string;
}

export type ClaudeExecutionInstallationCommandRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ encoding: 'utf8'; timeout: number; windowsHide: true }>,
) => Promise<ClaudeExecutionInstallationCommandResult>;

export interface ClaudeExecutionInstallationReader {
  getInstallation():
    ClaudeExecutionInstallationSnapshot | Promise<ClaudeExecutionInstallationSnapshot>;
}

export interface ClaudeExecutionInstallationProvider extends ClaudeExecutionInstallationReader {
  invalidate(): void;
  refresh(): Promise<ClaudeExecutionInstallationSnapshot>;
}

const defaultCommandRunner: ClaudeExecutionInstallationCommandRunner = async (
  executable,
  args,
  options,
) => execFileAsync(executable, [...args], options);

const immutableSnapshot = (
  snapshot: ClaudeExecutionInstallationSnapshot,
): ClaudeExecutionInstallationSnapshot => Object.freeze({ ...snapshot });

const parseVersionOutput = (stdout: string): string | undefined => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  lines.shift();
  const match = CLAUDE_VERSION_PATTERN.exec(lines.join(' '));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
};

/**
 * Main-process-only installation detector. It accepts no renderer/project command and shares one
 * invalidatable cache so runtime wiring can reuse the same authority later.
 */
export class CachedClaudeExecutionInstallationProvider implements ClaudeExecutionInstallationProvider {
  private readonly cache: AsyncRefreshCache<ClaudeExecutionInstallationSnapshot>;

  public constructor(
    private readonly commandRunner: ClaudeExecutionInstallationCommandRunner = defaultCommandRunner,
    cacheTtlMs = INSTALLATION_CACHE_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.cache = new AsyncRefreshCache(cacheTtlMs, now);
  }

  public getInstallation(): Promise<ClaudeExecutionInstallationSnapshot> {
    return this.cache.get(() => this.detect());
  }

  public invalidate(): void {
    this.cache.clear();
  }

  public refresh(): Promise<ClaudeExecutionInstallationSnapshot> {
    this.invalidate();
    return this.getInstallation();
  }

  private async detect(): Promise<ClaudeExecutionInstallationSnapshot> {
    try {
      const result = await this.commandRunner('powershell.exe', CLAUDE_INSTALLATION_COMMAND, {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
      const version = parseVersionOutput(result.stdout);
      return immutableSnapshot({
        installed: true,
        ...(version === undefined ? {} : { version }),
      });
    } catch {
      return immutableSnapshot({ installed: false });
    }
  }
}

/** The one production installation/version authority for execution settings. */
export const claudeExecutionInstallationProvider: ClaudeExecutionInstallationProvider =
  new CachedClaudeExecutionInstallationProvider();
