import { describe, expect, it } from 'vitest';
import type {
  ClaudeExecutionCapabilityContext,
  ClaudeExecutionRequestedValues,
  ClaudeExecutionSettingsRequest,
} from '../../src/shared/contracts/claude-execution-settings';
import {
  materializeClaudeExecutionEnvironments,
  parseExactClaudeVersion,
  resolveClaudeExecutionCapabilities,
} from '../../src/main/claude/execution-settings-capabilities';

const balancedValues: ClaudeExecutionRequestedValues = {
  concurrentSubagents: 8,
  spawnDepth: 3,
  toolSearch: 'inherit',
  toolUseConcurrency: 10,
};

const profileRequest: ClaudeExecutionSettingsRequest = {
  mode: 'profile',
  profileId: 'balanced',
};

const resolve = (
  version: string | undefined,
  values: ClaudeExecutionRequestedValues | undefined = balancedValues,
  context: ClaudeExecutionCapabilityContext = {},
) =>
  resolveClaudeExecutionCapabilities({
    context,
    installation: { installed: true, version },
    requested: values ? profileRequest : { mode: 'claude-default' },
    requestedValues: values,
  });

describe('Claude execution version capability matrix', () => {
  it.each([
    ['2.1.171', 'update-required', 'unavailable', undefined],
    ['2.1.172', 'update-required', 'fixed', 5],
    ['2.1.216', 'update-required', 'fixed', 5],
    ['2.1.217', 'supported', 'supported', 1],
    ['2.1.218', 'supported', 'supported', 1],
    ['2.1.219', 'supported', 'supported', 3],
    ['9.4.2', 'supported', 'supported', 3],
  ] as const)(
    'classifies %s at every documented boundary',
    (version, concurrentStatus, depthStatus, depthDefault) => {
      const result = resolve(version);
      expect(result.effective.concurrentSubagents.status).toBe(concurrentStatus);
      expect(result.effective.spawnDepth.status).toBe(depthStatus);
      expect(result.effective.spawnDepth.defaultValue).toBe(depthDefault);
      if (concurrentStatus === 'supported') {
        expect(result.effective.concurrentSubagents.defaultValue).toBe(20);
        expect(result.operations.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toEqual({
          kind: 'set',
          value: '8',
        });
      } else {
        expect(result.operations.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toEqual({ kind: 'omit' });
      }
    },
  );

  it.each([undefined, '', 'unknown', 'v2.1.219', '2.1', '2.1.219-beta', '2.1.219.0'])(
    'treats unknown or non-exact version %s conservatively',
    (version) => {
      expect(parseExactClaudeVersion(version)).toBeUndefined();
      const result = resolve(version);
      expect(result.effective.concurrentSubagents.status).toBe('unverified');
      expect(result.effective.spawnDepth.status).toBe('unverified');
      expect(result.effective.toolUseConcurrency.status).toBe('unverified');
      expect(result.operations.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toEqual({ kind: 'omit' });
      expect(result.operations.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toEqual({ kind: 'omit' });
      expect(result.operations.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toEqual({ kind: 'omit' });
    },
  );
});

describe('evidence-gated execution overrides', () => {
  it('uses the documented tool-use concurrency contract and evidence-gates older versions', () => {
    const withoutEvidence = resolve('2.1.219');
    expect(withoutEvidence.effective.toolUseConcurrency).toMatchObject({
      defaultValue: 10,
      effectiveValue: 10,
      requestedValue: 10,
      source: { kind: 'version-matrix' },
      status: 'supported',
    });
    expect(withoutEvidence.operations.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toEqual({
      kind: 'set',
      value: '10',
    });

    const mismatched = resolve('2.1.216', balancedValues, {
      evidence: {
        toolUseConcurrency: [
          {
            exactVersion: '2.1.215',
            source: 'local exact-version fixture',
            supported: true,
            verifiedAt: 100,
          },
        ],
      },
      now: 200,
    });
    expect(mismatched.effective.toolUseConcurrency.status).toBe('unverified');

    const supported = resolve('2.1.216', balancedValues, {
      evidence: {
        toolUseConcurrency: [
          {
            exactVersion: '2.1.216',
            source: 'local exact-version fixture',
            supported: true,
            verifiedAt: 100,
          },
        ],
      },
      now: 200,
    });
    expect(supported.effective.toolUseConcurrency).toMatchObject({
      effectiveValue: 10,
      source: { kind: 'verified-evidence', reference: 'local exact-version fixture' },
      status: 'supported',
    });
    expect(supported.operations.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toEqual({
      kind: 'set',
      value: '10',
    });
  });

  it('persists conceptually but omits unmatched, stale, or unknown-version tool-search requests', () => {
    const values = { ...balancedValues, toolSearch: 'auto:10' as const };
    const evidence = {
      toolSearch: [
        {
          expiresAt: 300,
          model: 'claude-opus-5',
          routeId: 'route-a',
          source: 'fresh route-model probe',
          supported: true,
          verifiedAt: 100,
        },
      ],
    };

    for (const context of [
      { evidence, now: 200, route: { model: 'claude-opus-5', routeId: 'route-b' } },
      { evidence, now: 200, route: { model: 'claude-sonnet-5', routeId: 'route-a' } },
      { evidence, now: 301, route: { model: 'claude-opus-5', routeId: 'route-a' } },
    ]) {
      const result = resolve('2.1.219', values, context);
      expect(result.effective.toolSearch).toMatchObject({
        effectiveValue: 'inherit',
        requestedValue: 'auto:10',
        status: 'unverified',
      });
      expect(result.operations.ENABLE_TOOL_SEARCH).toEqual({ kind: 'omit' });
    }

    const unknownVersion = resolve('unknown', values, {
      evidence,
      now: 200,
      route: { model: 'claude-opus-5', routeId: 'route-a' },
    });
    expect(unknownVersion.effective.toolSearch.status).toBe('unverified');
    expect(unknownVersion.operations.ENABLE_TOOL_SEARCH).toEqual({ kind: 'omit' });
  });

  it('applies tool search only for fresh exact route and model evidence', () => {
    const result = resolve(
      '2.1.219',
      { ...balancedValues, toolSearch: true },
      {
        evidence: {
          toolSearch: [
            {
              expiresAt: 300,
              model: 'claude-opus-5',
              routeId: 'route-a',
              source: 'fresh exact route-model probe',
              supported: true,
              verifiedAt: 100,
            },
          ],
        },
        now: 200,
        route: { model: 'claude-opus-5', routeId: 'route-a' },
      },
    );

    expect(result.effective.toolSearch).toMatchObject({
      effectiveValue: true,
      source: {
        expiresAt: 300,
        kind: 'verified-evidence',
        reference: 'fresh exact route-model probe',
        verifiedAt: 100,
      },
      status: 'supported',
    });
    expect(result.operations.ENABLE_TOOL_SEARCH).toEqual({ kind: 'set', value: 'true' });
  });

  it('applies documented tool search directly on a current official Anthropic route', () => {
    const result = resolve(
      '2.1.221',
      { ...balancedValues, toolSearch: 'auto:10' },
      {
        route: {
          model: 'claude-opus-5',
          officialNetworkProvider: 'anthropic-claude',
          routeId: 'official-anthropic-route',
        },
      },
    );

    expect(result.effective.toolSearch).toMatchObject({
      effectiveValue: 'auto:10',
      source: { kind: 'version-matrix' },
      status: 'supported',
    });
    expect(result.operations.ENABLE_TOOL_SEARCH).toEqual({ kind: 'set', value: 'auto:10' });

    const olderVersion = resolve(
      '2.1.220',
      { ...balancedValues, toolSearch: 'auto:10' },
      {
        route: {
          model: 'claude-opus-5',
          officialNetworkProvider: 'anthropic-claude',
          routeId: 'official-anthropic-route',
        },
      },
    );
    expect(olderVersion.effective.toolSearch.status).toBe('unverified');
    expect(olderVersion.operations.ENABLE_TOOL_SEARCH).toEqual({ kind: 'omit' });
  });
});

describe('resolved environment operations', () => {
  it('sets verified requests while unset defaults and explicit inheritance remain omitted', () => {
    const profile = resolve('2.1.219', balancedValues, {
      evidence: {
        toolUseConcurrency: [
          {
            exactVersion: '2.1.219',
            source: 'local support fixture',
            supported: true,
            verifiedAt: 100,
          },
        ],
      },
      now: 200,
    });
    expect(profile.operations).toMatchObject({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: { kind: 'set', value: '8' },
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: { kind: 'set', value: '3' },
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: { kind: 'set', value: '10' },
      ENABLE_TOOL_SEARCH: { kind: 'omit' },
    });

    const defaults = resolveClaudeExecutionCapabilities({
      installation: { installed: true, version: '2.1.219' },
      requested: { mode: 'claude-default' },
    });
    expect(Object.values(defaults.operations).every((operation) => operation.kind === 'omit')).toBe(
      true,
    );

    const explicitRestore = resolveClaudeExecutionCapabilities({
      installation: { installed: true, version: '2.1.219' },
      intent: 'restore-default',
      requested: { mode: 'claude-default' },
    });
    expect(
      Object.values(explicitRestore.operations).every((operation) => operation.kind === 'delete'),
    ).toBe(true);
  });

  it('materializes one operation snapshot consistently while preserving inherited omit values', () => {
    const resolution = resolve('2.1.219', balancedValues, {
      evidence: {
        toolUseConcurrency: [
          {
            exactVersion: '2.1.219',
            source: 'local support fixture',
            supported: true,
            verifiedAt: 100,
          },
        ],
      },
      now: 200,
    });
    const pair = materializeClaudeExecutionEnvironments(
      resolution.operations,
      { ENABLE_TOOL_SEARCH: 'parent', KEEP: 'process' },
      { ENABLE_TOOL_SEARCH: 'settings-parent', KEEP: 'settings' },
    );

    expect(pair.processEnvironment).toMatchObject({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '8',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3',
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '10',
      ENABLE_TOOL_SEARCH: 'parent',
      KEEP: 'process',
    });
    expect(pair.settingsEnvironment.ENABLE_TOOL_SEARCH).toBe('settings-parent');
    expect(Object.isFrozen(pair.processEnvironment)).toBe(true);
    expect(Object.isFrozen(pair.settingsEnvironment)).toBe(true);
  });

  it('materializes set, omit, and delete as distinct environment operations', () => {
    const pair = materializeClaudeExecutionEnvironments(
      {
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: { kind: 'set', value: '8' },
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: { kind: 'delete' },
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: { kind: 'omit' },
        ENABLE_TOOL_SEARCH: { kind: 'omit' },
      },
      {
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: 'legacy-depth',
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: 'legacy-tool',
      },
      {
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: 'settings-depth',
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: 'settings-tool',
      },
    );

    expect(pair.processEnvironment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('8');
    expect(pair.processEnvironment.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBeUndefined();
    expect(pair.settingsEnvironment.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBeUndefined();
    expect(pair.processEnvironment.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toBe('legacy-tool');
    expect(pair.settingsEnvironment.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toBe('settings-tool');
  });

  it('replaces every case-insensitive managed spelling with one canonical set key', () => {
    const pair = materializeClaudeExecutionEnvironments(
      {
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: { kind: 'set', value: '8' },
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: { kind: 'omit' },
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: { kind: 'omit' },
        ENABLE_TOOL_SEARCH: { kind: 'omit' },
      },
      {
        CLAUDE_CODE_MAX_CONCURRENT_AGENTS: 'historical-process-concurrent',
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: 'canonical-process',
        CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: 'historical-process-session',
        Claude_Code_Max_Concurrent_Subagents: 'mixed-process',
        MAX_CONCURRENT_AGENTS: 'historical-process-unprefixed',
        claude_code_max_concurrent_subagents: 'lower-process',
      },
      {
        CLAUDE_CODE_MAX_CONCURRENT_AGENTS: 'historical-settings-concurrent',
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: 'canonical-settings',
        CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: 'historical-settings-session',
        Claude_Code_Max_Concurrent_Subagents: 'mixed-settings',
        MAX_CONCURRENT_AGENTS: 'historical-settings-unprefixed',
        claude_code_max_concurrent_subagents: 'lower-settings',
      },
    );

    for (const environment of [pair.processEnvironment, pair.settingsEnvironment]) {
      expect(
        Object.keys(environment).filter(
          (key) => key.toLowerCase() === 'claude_code_max_concurrent_subagents',
        ),
      ).toEqual(['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS']);
      expect(environment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('8');
    }
    expect(pair.processEnvironment).toMatchObject({
      CLAUDE_CODE_MAX_CONCURRENT_AGENTS: 'historical-process-concurrent',
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: 'historical-process-session',
      MAX_CONCURRENT_AGENTS: 'historical-process-unprefixed',
    });
    expect(pair.settingsEnvironment).toMatchObject({
      CLAUDE_CODE_MAX_CONCURRENT_AGENTS: 'historical-settings-concurrent',
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: 'historical-settings-session',
      MAX_CONCURRENT_AGENTS: 'historical-settings-unprefixed',
    });
  });

  it('deletes every case-insensitive managed spelling without touching historical aliases', () => {
    const pair = materializeClaudeExecutionEnvironments(
      {
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: { kind: 'omit' },
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: { kind: 'delete' },
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: { kind: 'omit' },
        ENABLE_TOOL_SEARCH: { kind: 'omit' },
      },
      {
        CLAUDE_CODE_MAX_AGENT_DEPTH: 'historical-process-prefixed',
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: 'canonical-process',
        Claude_Code_Max_Subagent_Spawn_Depth: 'mixed-process',
        MAX_AGENT_DEPTH: 'historical-process-unprefixed',
        claude_code_max_subagent_spawn_depth: 'lower-process',
      },
      {
        CLAUDE_CODE_MAX_AGENT_DEPTH: 'historical-settings-prefixed',
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: 'canonical-settings',
        Claude_Code_Max_Subagent_Spawn_Depth: 'mixed-settings',
        MAX_AGENT_DEPTH: 'historical-settings-unprefixed',
        claude_code_max_subagent_spawn_depth: 'lower-settings',
      },
    );

    for (const environment of [pair.processEnvironment, pair.settingsEnvironment]) {
      expect(
        Object.keys(environment).filter(
          (key) => key.toLowerCase() === 'claude_code_max_subagent_spawn_depth',
        ),
      ).toEqual([]);
    }
    expect(pair.processEnvironment).toEqual({
      CLAUDE_CODE_MAX_AGENT_DEPTH: 'historical-process-prefixed',
      MAX_AGENT_DEPTH: 'historical-process-unprefixed',
    });
    expect(pair.settingsEnvironment).toEqual({
      CLAUDE_CODE_MAX_AGENT_DEPTH: 'historical-settings-prefixed',
      MAX_AGENT_DEPTH: 'historical-settings-unprefixed',
    });
  });

  it('preserves every captured spelling and value exactly for omitted managed keys', () => {
    const processEnvironment = {
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: 'canonical-process-concurrent',
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: 'canonical-process-tool',
      ENABLE_TOOL_SEARCH: 'canonical-process-search',
      KEEP: 'process',
      Claude_Code_Max_Subagent_Spawn_Depth: 'mixed-process-depth',
      claude_code_max_concurrent_subagents: 'lower-process-concurrent',
      claude_code_max_subagent_spawn_depth: 'lower-process-depth',
      claude_code_max_tool_use_concurrency: 'lower-process-tool',
      enable_tool_search: 'lower-process-search',
    };
    const settingsEnvironment = {
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: 'canonical-settings-concurrent',
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: 'canonical-settings-tool',
      ENABLE_TOOL_SEARCH: 'canonical-settings-search',
      KEEP: 'settings',
      Claude_Code_Max_Subagent_Spawn_Depth: 'mixed-settings-depth',
      claude_code_max_concurrent_subagents: 'lower-settings-concurrent',
      claude_code_max_subagent_spawn_depth: 'lower-settings-depth',
      claude_code_max_tool_use_concurrency: 'lower-settings-tool',
      enable_tool_search: 'lower-settings-search',
    };
    const pair = materializeClaudeExecutionEnvironments(
      {
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: { kind: 'omit' },
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: { kind: 'omit' },
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: { kind: 'omit' },
        ENABLE_TOOL_SEARCH: { kind: 'omit' },
      },
      processEnvironment,
      settingsEnvironment,
    );

    expect(pair.processEnvironment).toEqual(processEnvironment);
    expect(pair.settingsEnvironment).toEqual(settingsEnvironment);
  });
});
