import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeCodeThemeForTerminalTheme } from '../src/main/claude-runtime';

const runtimeSource = readFileSync(
  new URL('../src/main/claude-runtime.ts', import.meta.url),
  'utf8',
);

describe('Claude runtime terminal theme', () => {
  it('maps application appearances to explicit Claude Code themes', () => {
    expect(claudeCodeThemeForTerminalTheme('claude')).toBe('light');
    expect(claudeCodeThemeForTerminalTheme('telegram')).toBe('light');
    expect(claudeCodeThemeForTerminalTheme('graphite')).toBe('dark');
    expect(claudeCodeThemeForTerminalTheme('midnight')).toBe('dark');
  });

  it('writes the current application theme into the owned per-session settings', () => {
    expect(runtimeSource).toContain('theme: claudeCodeThemeForTerminalTheme(this.currentThemeId),');
    expect(runtimeSource).toContain('public setTheme(themeId: TerminalThemeId): void {');
    expect(runtimeSource).toContain('this.currentThemeId = themeId;');
  });
});
