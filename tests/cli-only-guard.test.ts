import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainDirectory = path.join(__dirname, '..', 'src', 'main');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.ts') ? [candidate] : [];
  });

const mainSources = sourceFiles(mainDirectory)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const proxySources = sourceFiles(path.join(mainDirectory, 'proxy'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const claudeSettingsDiagnostics = readFileSync(
  path.join(mainDirectory, 'claude-gateway-diagnostics.ts'),
  'utf8',
);

describe('CLI-only integration guard', () => {
  it('forbids CCR profile takeover and Claude Desktop configuration access', () => {
    expect(mainSources).not.toMatch(/applyProfile:\s*true/);
    expect(mainSources.toLowerCase()).not.toContain('claude_desktop_config.json');
  });

  it('has no Windows system proxy mutation path', () => {
    expect(mainSources).not.toMatch(/Internet Settings|ProxyEnable|ProxyServer/i);
    expect(proxySources).not.toMatch(
      /(?:execFile|runWindowsCommand|safeExec|spawn)\w*\(\s*['"](?:netsh|reg(?:\.exe)?|setx(?:\.exe)?)/i,
    );
  });

  it('keeps the user Claude settings path read-only', () => {
    expect(claudeSettingsDiagnostics).toContain("path.join(homedir(), '.claude', 'settings.json')");
    expect(claudeSettingsDiagnostics).not.toMatch(
      /\b(?:appendFile|copyFile|rename|rm|unlink|writeFile)(?:Sync)?\s*\(/,
    );
  });
});
