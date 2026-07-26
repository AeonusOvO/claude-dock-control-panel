import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { powershellStartup } from '../src/main/terminal-session';

describe('PowerShell terminal startup', () => {
  it('keeps UTF-8, multiline input, and multiline Backspace configuration in one session', () => {
    expect(powershellStartup).toContain('[Console]::InputEncoding = $utf8');
    expect(powershellStartup).toContain("Set-PSReadLineKeyHandler -Chord 'Ctrl+j'");
    expect(powershellStartup).toContain("Set-PSReadLineKeyHandler -Chord 'Backspace'");
    expect(powershellStartup).toContain('PSConsoleReadLine]::Replace');
  });

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
