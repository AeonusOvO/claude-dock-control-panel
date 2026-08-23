import { describe, expect, it, vi } from 'vitest';
import {
  CachedClaudeExecutionInstallationProvider,
  claudeExecutionInstallationProvider,
  type ClaudeExecutionInstallationCommandRunner,
} from '../../src/main/claude/execution-settings-installation';

const successfulRunner = (stdout: string): ClaudeExecutionInstallationCommandRunner =>
  vi.fn(async () => ({ stdout }));

describe('Claude execution installation provider', () => {
  it('uses the fixed main-only command and projects only installed/version authority', async () => {
    const runner = successfulRunner('C:\\Tools\\claude.exe\r\n2.1.219 (Claude Code)\r\n');
    const provider = new CachedClaudeExecutionInstallationProvider(runner);

    await expect(provider.getInstallation()).resolves.toEqual({
      installed: true,
      version: '2.1.219',
    });
    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '$command = Get-Command claude -ErrorAction Stop; Write-Output $command.Source; & claude --version',
      ],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    );
    expect(Object.keys(await provider.getInstallation()).sort()).toEqual(['installed', 'version']);
  });

  it('reports an installed command with an unknown version conservatively', async () => {
    const provider = new CachedClaudeExecutionInstallationProvider(
      successfulRunner('C:\\Tools\\claude.cmd\nClaude Code development build\n'),
    );

    await expect(provider.getInstallation()).resolves.toEqual({ installed: true });
  });

  it('reports command failure as not installed without exposing error details', async () => {
    const provider = new CachedClaudeExecutionInstallationProvider(
      vi.fn(async () => {
        throw new Error('secret-bearing process failure');
      }),
    );

    await expect(provider.getInstallation()).resolves.toEqual({ installed: false });
  });

  it('shares cached detection and exposes explicit invalidation/refresh seams', async () => {
    const runner = successfulRunner('C:\\Tools\\claude.exe\n2.1.217\n');
    const provider = new CachedClaudeExecutionInstallationProvider(runner, 60_000);

    const [first, second] = await Promise.all([
      provider.getInstallation(),
      provider.getInstallation(),
    ]);
    expect(first).toEqual(second);
    expect(runner).toHaveBeenCalledTimes(1);

    provider.invalidate();
    await expect(provider.getInstallation()).resolves.toMatchObject({ version: '2.1.217' });
    expect(runner).toHaveBeenCalledTimes(2);

    await expect(provider.refresh()).resolves.toMatchObject({ version: '2.1.217' });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('exports one production provider instance for bootstrap and future runtime reuse', () => {
    expect(claudeExecutionInstallationProvider).toBe(claudeExecutionInstallationProvider);
    expect(typeof claudeExecutionInstallationProvider.getInstallation).toBe('function');
    expect(typeof claudeExecutionInstallationProvider.invalidate).toBe('function');
  });
});
