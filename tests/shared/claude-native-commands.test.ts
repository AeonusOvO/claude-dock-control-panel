import { describe, expect, it } from 'vitest';
import {
  mergeRuntimeClaudeCommands,
  nativeCommandCoverage,
  resolveClaudeNativeCommand,
} from '../../src/shared/claude/native-commands';

describe('Claude native command registry', () => {
  it('has an explicit native mapping for every catalogued command and alias', () => {
    expect(nativeCommandCoverage()).toMatchObject({ missing: [] });
    expect(resolveClaudeNativeCommand('/settings')?.name).toBe('/config');
    expect(resolveClaudeNativeCommand('/bg 调研')?.name).toBe('/background');
  });

  it('keeps TUI-only commands explicit instead of sending them as a prompt', () => {
    expect(resolveClaudeNativeCommand('/tui')?.mapping).toBe('terminal-only');
    expect(resolveClaudeNativeCommand('/voice')?.mapping).toBe('terminal-only');
  });

  it('blocks newly discovered commands until a mapping is added', () => {
    const commands = mergeRuntimeClaudeCommands([
      { name: 'status', description: 'known' },
      { name: 'future-command', description: 'new upstream capability' },
    ]);
    expect(commands.find(({ name }) => name === '/future-command')).toMatchObject({
      mapping: 'unknown',
    });
  });
});
