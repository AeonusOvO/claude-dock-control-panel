import { describe, expect, it } from 'vitest';
import {
  CLAUDE_COMMAND_CATALOG,
  CODEX_COMMAND_CATALOG,
  claudeRunnableCommands,
  commandInvocationNames,
  findCliCommand,
} from '../../src/shared/ui/cli-command-catalog';

describe('CLI command catalog', () => {
  it('tracks the complete versioned Claude command table and aliases', () => {
    expect(CLAUDE_COMMAND_CATALOG).toHaveLength(101);
    expect(new Set(commandInvocationNames('claude')).size).toBe(120);
    expect(commandInvocationNames('claude')).not.toContain('/pr-comments');
    expect(commandInvocationNames('claude')).not.toContain('/vim');
    expect(commandInvocationNames('claude')).not.toContain('/ultraplan');
    expect(findCliCommand('claude', '/share')?.command).toBe('/bug');
    expect(findCliCommand('claude', '/proactive')?.command).toBe('/loop');
    expect(findCliCommand('claude', '/add-dir')?.syntax).toBe('/add-dir <path>');
    expect(findCliCommand('claude', '/desktop')?.platforms).toEqual(['windows', 'macos']);
  });

  it('tracks the complete versioned Codex command table and aliases', () => {
    expect(CODEX_COMMAND_CATALOG).toHaveLength(50);
    expect(new Set(commandInvocationNames('codex')).size).toBe(53);
    expect(findCliCommand('codex', '/subagents')?.command).toBe('/agent');
    expect(findCliCommand('codex', '/btw')?.command).toBe('/side');
    expect(findCliCommand('codex', '/pet')?.command).toBe('/pets');
    expect(findCliCommand('codex', '/sandbox-add-read-dir')?.platforms).toEqual(['windows']);
    expect(findCliCommand('codex', '/import')?.requirements).toContain(
      '仅本地空闲 TUI；远程/App Server 会话不可用',
    );
  });

  it('only exposes explicitly safe Claude commands to main-process execution', () => {
    const runnable = claudeRunnableCommands();
    expect(runnable.has('/status')).toBe(true);
    expect(runnable.has('/permissions')).toBe(true);
    expect(runnable.get('/context')).toBe(false);
    expect(runnable.has('/clear')).toBe(false);
    expect(runnable.has('/exit')).toBe(false);
    expect(CLAUDE_COMMAND_CATALOG.find((entry) => entry.command === '/clear')?.risk).toBe(
      'destructive',
    );
    expect(CODEX_COMMAND_CATALOG.every((entry) => entry.action === 'compose')).toBe(true);
  });
});
