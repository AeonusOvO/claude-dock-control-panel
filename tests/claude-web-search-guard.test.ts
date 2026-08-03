import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve('assets/runtime/claude-web-search-guard.ps1');
const allowedAgent = 'claudedock-web-research';

const runGuard = (payload: unknown) =>
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-AllowedAgent',
      allowedAgent,
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      timeout: 30_000,
    },
  );

describe('ClaudeDock web-search routing guard', () => {
  it('blocks a direct main-thread web tool and tells Claude which agent to use', () => {
    const result = runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebSearch',
      tool_input: { query: 'current release' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(allowedAgent);
    expect(result.stderr).toContain('Agent tool');
    expect(result.stderr).toContain('Keep the main effort unchanged');
  });

  it('allows WebSearch and WebFetch inside the isolated high-effort agent', () => {
    for (const toolName of ['WebSearch', 'WebFetch']) {
      const result = runGuard({
        agent_id: 'agent-web-1',
        agent_type: allowedAgent,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: {},
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }
  });

  it('fails open when Claude Code supplies malformed hook JSON', () => {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AllowedAgent',
        allowedAgent,
      ],
      { encoding: 'utf8', input: '{broken', timeout: 30_000 },
    );

    expect(result.status).toBe(0);
  });
});
