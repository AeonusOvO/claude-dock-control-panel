import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS,
  CLAUDE_EXECUTION_INPUT_SAFETY_BOUNDS_VERSION,
  CLAUDE_EXECUTION_MANAGED_ENV_KEYS,
  assertClaudeExecutionManagedEnvKey,
} from '../../src/shared/contracts/claude-execution-settings';
import {
  CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION,
  CLAUDE_EXECUTION_PROFILES,
  isClaudeExecutionRequestedValues,
  isClaudeToolSearchRequest,
  recommendClaudeExecutionProfile,
  validateClaudeExecutionProfileCatalog,
} from '../../src/shared/claude/execution-profiles';

const GIB = 1024 ** 3;

const expectedProfiles = [
  ['token-saver', '最省 Token', 4, 2, 1, false],
  ['restrained', '节制', 6, 4, 2, 'auto:20'],
  ['balanced', '均衡（推荐）', 10, 8, 3, 'inherit'],
  ['high-throughput', '高吞吐', 16, 16, 3, 'auto:10'],
  ['best-performance', '最佳性能', 24, 20, 4, 'auto'],
] as const;

describe('Claude execution profile catalogue', () => {
  it('contains exactly the five versioned product policies with unique identities', () => {
    expect(CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION).toBe(1);
    expect(
      CLAUDE_EXECUTION_PROFILES.map((profile) => [
        profile.id,
        profile.label,
        profile.values.toolUseConcurrency,
        profile.values.concurrentSubagents,
        profile.values.spawnDepth,
        profile.values.toolSearch,
      ]),
    ).toEqual(expectedProfiles);
    expect(new Set(CLAUDE_EXECUTION_PROFILES.map((profile) => profile.id)).size).toBe(5);
    expect(new Set(CLAUDE_EXECUTION_PROFILES.map((profile) => profile.label)).size).toBe(5);
    expect(CLAUDE_EXECUTION_PROFILES.every(Object.isFrozen)).toBe(true);
    expect(CLAUDE_EXECUTION_PROFILES.every((profile) => Object.isFrozen(profile.values))).toBe(
      true,
    );
  });

  it('validates the catalogue at module-load strength and rejects duplicate identities', () => {
    expect(() => validateClaudeExecutionProfileCatalog(CLAUDE_EXECUTION_PROFILES)).not.toThrow();
    expect(() =>
      validateClaudeExecutionProfileCatalog([
        ...CLAUDE_EXECUTION_PROFILES.slice(0, 4),
        { ...CLAUDE_EXECUTION_PROFILES[4]!, id: 'token-saver' },
      ]),
    ).toThrow(/目录/);
  });

  it('has one exact managed-key allowlist and rejects forbidden or invented aliases', () => {
    expect(CLAUDE_EXECUTION_MANAGED_ENV_KEYS).toEqual([
      'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
      'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
      'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
      'ENABLE_TOOL_SEARCH',
    ]);
    const forbidden = [
      'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
      'CLAUDE_CODE_MAX_CONCURRENT_AGENTS',
      'MAX_CONCURRENT_AGENTS',
      'CLAUDE_CODE_MAX_AGENT_DEPTH',
      'MAX_AGENT_DEPTH',
    ];
    for (const name of forbidden) {
      expect(() => assertClaudeExecutionManagedEnvKey(name)).toThrow(/不管理/);
      expect(CLAUDE_EXECUTION_MANAGED_ENV_KEYS).not.toContain(name);
    }
  });

  it('accepts only canonical tool-search requests including the 0 and 100 boundaries', () => {
    for (const value of [
      'inherit',
      true,
      false,
      'auto',
      'auto:0',
      'auto:1',
      'auto:99',
      'auto:100',
    ]) {
      expect(isClaudeToolSearchRequest(value)).toBe(true);
    }
    for (const value of [
      undefined,
      null,
      0,
      'true',
      'false',
      'AUTO',
      'auto:-1',
      'auto:00',
      'auto:01',
      'auto:100.0',
      'auto:101',
      'auto: 20',
    ]) {
      expect(isClaudeToolSearchRequest(value)).toBe(false);
    }
  });

  it('exports versioned product input bounds independent of profile maxima', () => {
    expect(CLAUDE_EXECUTION_INPUT_SAFETY_BOUNDS_VERSION).toBe(1);
    expect(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS).toEqual({
      concurrentSubagents: { maximum: 128, minimum: 1 },
      spawnDepth: { maximum: 16, minimum: 1 },
      toolUseConcurrency: { maximum: 128, minimum: 1 },
    });
    expect(Object.isFrozen(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS)).toBe(true);
    expect(Object.values(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS).every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ['toolUseConcurrency', 1, 128],
    ['concurrentSubagents', 1, 128],
    ['spawnDepth', 1, 16],
  ] as const)(
    'enforces the %s minimum, maximum, and maximum-plus-one boundaries',
    (field, min, max) => {
      const valid = {
        concurrentSubagents: 8,
        spawnDepth: 3,
        toolSearch: 'inherit',
        toolUseConcurrency: 10,
      };
      expect(isClaudeExecutionRequestedValues({ ...valid, [field]: min })).toBe(true);
      expect(isClaudeExecutionRequestedValues({ ...valid, [field]: max })).toBe(true);
      expect(isClaudeExecutionRequestedValues({ ...valid, [field]: max + 1 })).toBe(false);
    },
  );

  it('rejects non-whole values, zero, unsafe integers, and extra keys', () => {
    const valid = {
      concurrentSubagents: 1,
      spawnDepth: 1,
      toolSearch: 'inherit',
      toolUseConcurrency: 1,
    };
    for (const values of [
      { ...valid, spawnDepth: 0 },
      { ...valid, toolUseConcurrency: 1.5 },
      { ...valid, concurrentSubagents: Number.MAX_SAFE_INTEGER },
      { ...valid, secret: 'must-not-pass' },
    ]) {
      expect(isClaudeExecutionRequestedValues(values)).toBe(false);
    }
  });
});

describe('Claude execution machine recommendation', () => {
  it.each([
    [{ logicalCpuCount: 4, availableMemoryBytes: 4 * GIB }, 'token-saver'],
    [{ logicalCpuCount: 8, availableMemoryBytes: 8 * GIB }, 'restrained'],
    [{ logicalCpuCount: 12, availableMemoryBytes: 16 * GIB }, 'balanced'],
    [
      {
        logicalCpuCount: 16,
        availableMemoryBytes: 16 * GIB,
        benchmark: { stableConcurrentSubagents: 16, stableToolUseConcurrency: 16 },
        rateLimit: { remainingRatio: 0.6 },
      },
      'high-throughput',
    ],
    [
      {
        logicalCpuCount: 24,
        availableMemoryBytes: 32 * GIB,
        benchmark: { stableConcurrentSubagents: 20, stableToolUseConcurrency: 24 },
        rateLimit: { remainingRatio: 0.75 },
      },
      'best-performance',
    ],
  ] as const)('deterministically recommends %s as %s', (input, expected) => {
    const first = recommendClaudeExecutionProfile(input);
    const second = recommendClaudeExecutionProfile(structuredClone(input));
    expect(first.profileId).toBe(expected);
    expect(second).toEqual(first);
    expect(first.reason).toContain('不代表更高智力');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('never selects an aggressive profile without both benchmark and rate-limit evidence', () => {
    const strongMachine = { availableMemoryBytes: 64 * GIB, logicalCpuCount: 64 };
    expect(recommendClaudeExecutionProfile(strongMachine).profileId).toBe('balanced');
    expect(
      recommendClaudeExecutionProfile({
        ...strongMachine,
        benchmark: { stableConcurrentSubagents: 64, stableToolUseConcurrency: 64 },
      }).profileId,
    ).toBe('balanced');
    expect(
      recommendClaudeExecutionProfile({
        ...strongMachine,
        rateLimit: { remainingRatio: 0.1 },
      }).profileId,
    ).toBe('token-saver');
    expect(
      recommendClaudeExecutionProfile({
        ...strongMachine,
        benchmark: { stableConcurrentSubagents: 2, stableToolUseConcurrency: 4 },
        rateLimit: { remainingRatio: 0.9 },
      }).profileId,
    ).toBe('token-saver');
  });
});
