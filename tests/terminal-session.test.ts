import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildPowershellStartup,
  powershellStartup,
  POWERSHELL_STARTUP_COMMAND_ENV,
  POWERSHELL_STARTUP_TRIGGER,
} from '../src/main/terminal-session';
import { ansiBackground, ansiForeground, TERMINAL_THEMES } from '../src/shared/terminal-themes';

describe('PowerShell terminal startup', () => {
  it('keeps UTF-8, multiline input, and the one-shot launch handoff in one session', () => {
    expect(powershellStartup).toContain('[Console]::InputEncoding = $utf8');
    expect(powershellStartup).toContain("Set-PSReadLineKeyHandler -Chord 'Ctrl+j'");
    expect(powershellStartup).toContain("Set-PSReadLineKeyHandler -Chord 'Backspace'");
    expect(powershellStartup).toContain('PSConsoleReadLine]::Replace');
    expect(powershellStartup).toContain(`$env:${POWERSHELL_STARTUP_COMMAND_ENV}`);
    expect(powershellStartup).toContain(`function global:${POWERSHELL_STARTUP_TRIGGER}`);
    expect(powershellStartup).toContain(
      `Remove-Item Env:${POWERSHELL_STARTUP_COMMAND_ENV} -ErrorAction SilentlyContinue`,
    );
    expect(powershellStartup).toContain(
      `Remove-Item Function:${POWERSHELL_STARTUP_TRIGGER} -ErrorAction SilentlyContinue`,
    );
  });

  it('maps every PSReadLine role to the requested 24-bit palette', () => {
    const palette = TERMINAL_THEMES.telegram.palette;
    const startup = buildPowershellStartup(palette);
    const foregroundCases = {
      Command: palette.brightCyan,
      Parameter: palette.brightBlack,
      Operator: palette.magenta,
      Variable: palette.yellow,
      String: palette.green,
      Number: palette.blue,
      Type: palette.cyan,
      Comment: palette.brightBlack,
      Default: palette.foreground,
      Error: palette.red,
    };

    for (const [role, colour] of Object.entries(foregroundCases)) {
      expect(startup).toContain(`${role} = "${ansiForeground(colour)}"`);
    }
    expect(startup).toContain(`Selection = "${ansiBackground(palette.selectionBackground)}"`);
    expect(startup).not.toContain('[ConsoleColor]');
  });

  it('keeps the compatibility export on the default Claude palette', () => {
    expect(powershellStartup).toBe(buildPowershellStartup(TERMINAL_THEMES.claude.palette));
  });

  it.runIf(process.platform === 'win32')(
    'executes the captured launch once after removing its environment handoff',
    () => {
      const launchCommand = `[Console]::Write(('handoff:' + [string]::IsNullOrEmpty($env:${POWERSHELL_STARTUP_COMMAND_ENV})))`;
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-Command',
          `${powershellStartup}; ${POWERSHELL_STARTUP_TRIGGER}`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, [POWERSHELL_STARTUP_COMMAND_ENV]: launchCommand },
          timeout: 10_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('handoff:True');
    },
  );

  it.runIf(process.platform === 'win32')('is valid PowerShell syntax', () => {
    const encodedStartup = Buffer.from(powershellStartup, 'utf16le').toString('base64');
    const parseOnly = [
      `$source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedStartup}'))`,
      '[ScriptBlock]::Create($source) | Out-Null',
    ].join('; ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parseOnly],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
