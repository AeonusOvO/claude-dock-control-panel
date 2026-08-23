import { describe, expect, it } from 'vitest';
import type { ClaudeExecutionSettingsView } from '../../src/shared/contracts/claude-execution-settings';
import { toClaudeExecutionSettingsDto } from '../../src/main/claude/execution-settings-dto';

const setting = (envKey: string, secret: string) => ({
  defaultValue: 10,
  effectiveValue: 8,
  envKey,
  operation: { kind: 'set' as const, value: secret },
  reason: '当前版本支持此设置。',
  requestedValue: 8,
  source: { kind: 'verified-evidence' as const, reference: secret, verifiedAt: 100 },
  status: 'supported' as const,
});

describe('Claude execution settings IPC DTO', () => {
  it('whitelist-projects safe request and effective status fields only', () => {
    const secret = 'credential-and-endpoint-must-stay-main-only';
    const view = {
      catalogVersion: 1,
      effective: {
        concurrentSubagents: setting('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', secret),
        spawnDepth: setting('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', secret),
        toolSearch: {
          ...setting('ENABLE_TOOL_SEARCH', secret),
          defaultValue: 'inherit' as const,
          effectiveValue: 'inherit' as const,
          requestedValue: 'auto:20' as const,
        },
        toolUseConcurrency: setting('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY', secret),
      },
      installation: { installed: true, version: '2.1.219' },
      requested: { mode: 'profile' as const, profileId: 'balanced' as const },
      version: 1,
      environment: { ANTHROPIC_AUTH_TOKEN: secret },
      operations: { secret },
    } as unknown as ClaudeExecutionSettingsView;

    const dto = toClaudeExecutionSettingsDto(view);
    expect(dto.requested).toEqual({ mode: 'profile', profileId: 'balanced' });
    expect(dto.profiles).toHaveLength(5);
    expect(dto.effective.concurrentSubagents).toEqual({
      defaultValue: 10,
      effectiveValue: 8,
      reason: '当前版本支持此设置。',
      requestedValue: 8,
      source: { kind: 'verified-evidence', verifiedAt: 100 },
      status: 'supported',
    });

    const serialized = JSON.stringify(dto);
    for (const forbidden of [
      secret,
      'ANTHROPIC_AUTH_TOKEN',
      'environment',
      'operations',
      'envKey',
      'operation',
      'reference',
      'endpoint',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.profiles[0]?.values)).toBe(true);
  });
});
