import {
  CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS,
  type ClaudeExecutionProfile,
  type ClaudeExecutionProfileId,
  type ClaudeExecutionRequestedValues,
  type ClaudeToolSearchRequest,
} from '../contracts/claude-execution-settings';

export const CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION = 1 as const;

const CANONICAL_TOOL_SEARCH_AUTO = /^auto:(?:0|[1-9]\d?|100)$/;

export const isClaudeToolSearchRequest = (value: unknown): value is ClaudeToolSearchRequest =>
  value === true ||
  value === false ||
  value === 'inherit' ||
  value === 'auto' ||
  (typeof value === 'string' && CANONICAL_TOOL_SEARCH_AUTO.test(value));

const isPositiveWholeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isWholeNumberWithin = (
  value: unknown,
  bounds: Readonly<{ maximum: number; minimum: number }>,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= bounds.minimum &&
  value <= bounds.maximum;

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
};

export const isClaudeExecutionRequestedValues = (
  value: unknown,
): value is ClaudeExecutionRequestedValues => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    exactKeys(record, ['concurrentSubagents', 'spawnDepth', 'toolSearch', 'toolUseConcurrency']) &&
    isWholeNumberWithin(
      record.toolUseConcurrency,
      CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.toolUseConcurrency,
    ) &&
    isWholeNumberWithin(
      record.concurrentSubagents,
      CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.concurrentSubagents,
    ) &&
    isWholeNumberWithin(record.spawnDepth, CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.spawnDepth) &&
    isClaudeToolSearchRequest(record.toolSearch)
  );
};

export const assertClaudeExecutionRequestedValues: (
  value: unknown,
) => asserts value is ClaudeExecutionRequestedValues = (value) => {
  if (!isClaudeExecutionRequestedValues(value)) {
    throw new Error(
      'Claude 自定义执行设置无效：工具并发和子代理并发必须为 1-128，派生深度必须为 1-16，工具搜索必须为 inherit、true、false、auto 或 auto:0-100。',
    );
  }
};

const freezeProfile = (profile: ClaudeExecutionProfile): ClaudeExecutionProfile =>
  Object.freeze({ ...profile, values: Object.freeze({ ...profile.values }) });

/**
 * Product recommendation policy only. The numeric caps below are deliberately explicit and
 * conservative; they are not documented or inferred Claude Code support maxima.
 */
export const CLAUDE_EXECUTION_PROFILES: readonly ClaudeExecutionProfile[] = Object.freeze([
  freezeProfile({
    id: 'token-saver',
    label: '最省 Token',
    values: {
      concurrentSubagents: 2,
      spawnDepth: 1,
      toolSearch: false,
      toolUseConcurrency: 4,
    },
  }),
  freezeProfile({
    id: 'restrained',
    label: '节制',
    values: {
      concurrentSubagents: 4,
      spawnDepth: 2,
      toolSearch: 'auto:20',
      toolUseConcurrency: 6,
    },
  }),
  freezeProfile({
    id: 'balanced',
    label: '均衡（推荐）',
    values: {
      concurrentSubagents: 8,
      spawnDepth: 3,
      toolSearch: 'inherit',
      toolUseConcurrency: 10,
    },
  }),
  freezeProfile({
    id: 'high-throughput',
    label: '高吞吐',
    values: {
      concurrentSubagents: 16,
      spawnDepth: 3,
      toolSearch: 'auto:10',
      toolUseConcurrency: 16,
    },
  }),
  freezeProfile({
    id: 'best-performance',
    label: '最佳性能',
    values: {
      concurrentSubagents: 20,
      spawnDepth: 4,
      toolSearch: 'auto',
      toolUseConcurrency: 24,
    },
  }),
]);

const EXPECTED_PROFILE_IDENTITIES = [
  ['token-saver', '最省 Token'],
  ['restrained', '节制'],
  ['balanced', '均衡（推荐）'],
  ['high-throughput', '高吞吐'],
  ['best-performance', '最佳性能'],
] as const satisfies readonly (readonly [ClaudeExecutionProfileId, string])[];

export const validateClaudeExecutionProfileCatalog = (
  profiles: readonly ClaudeExecutionProfile[],
): void => {
  if (CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION !== 1 || profiles.length !== 5) {
    throw new Error('Claude 执行档位目录版本或数量无效。');
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    const expected = EXPECTED_PROFILE_IDENTITIES[index];
    if (
      !expected ||
      profile.id !== expected[0] ||
      profile.label !== expected[1] ||
      ids.has(profile.id) ||
      labels.has(profile.label) ||
      !isClaudeExecutionRequestedValues(profile.values)
    ) {
      throw new Error(`Claude 执行档位目录第 ${index + 1} 项无效。`);
    }
    ids.add(profile.id);
    labels.add(profile.label);
  }
};

validateClaudeExecutionProfileCatalog(CLAUDE_EXECUTION_PROFILES);

export const getClaudeExecutionProfile = (
  profileId: ClaudeExecutionProfileId,
): ClaudeExecutionProfile | undefined =>
  CLAUDE_EXECUTION_PROFILES.find((profile) => profile.id === profileId);

export interface ClaudeExecutionBenchmarkEvidence {
  stableConcurrentSubagents: number;
  stableToolUseConcurrency: number;
}

export interface ClaudeExecutionRateLimitEvidence {
  /** Fraction of the relevant rate-limit budget still available, from 0 through 1. */
  remainingRatio: number;
}

export interface ClaudeExecutionRecommendationInput {
  availableMemoryBytes: number;
  benchmark?: ClaudeExecutionBenchmarkEvidence;
  logicalCpuCount: number;
  rateLimit?: ClaudeExecutionRateLimitEvidence;
}

export interface ClaudeExecutionRecommendation {
  profileId: ClaudeExecutionProfileId;
  reason: string;
}

const GIB = 1024 ** 3;
const PROFILE_ORDER: readonly ClaudeExecutionProfileId[] = [
  'token-saver',
  'restrained',
  'balanced',
  'high-throughput',
  'best-performance',
];

const lowerProfile = (
  left: ClaudeExecutionProfileId,
  right: ClaudeExecutionProfileId,
): ClaudeExecutionProfileId =>
  PROFILE_ORDER[Math.min(PROFILE_ORDER.indexOf(left), PROFILE_ORDER.indexOf(right))] ??
  'token-saver';

const machineBaseline = (
  logicalCpuCount: number,
  availableMemoryBytes: number,
): ClaudeExecutionProfileId => {
  if (logicalCpuCount < 6 || availableMemoryBytes < 6 * GIB) {
    return 'token-saver';
  }
  if (logicalCpuCount < 10 || availableMemoryBytes < 10 * GIB) {
    return 'restrained';
  }
  return 'balanced';
};

const benchmarkCeiling = (
  benchmark: ClaudeExecutionBenchmarkEvidence,
): ClaudeExecutionProfileId => {
  if (benchmark.stableToolUseConcurrency >= 24 && benchmark.stableConcurrentSubagents >= 20) {
    return 'best-performance';
  }
  if (benchmark.stableToolUseConcurrency >= 16 && benchmark.stableConcurrentSubagents >= 16) {
    return 'high-throughput';
  }
  if (benchmark.stableToolUseConcurrency >= 10 && benchmark.stableConcurrentSubagents >= 8) {
    return 'balanced';
  }
  if (benchmark.stableToolUseConcurrency >= 6 && benchmark.stableConcurrentSubagents >= 4) {
    return 'restrained';
  }
  return 'token-saver';
};

const assertRecommendationInput = (input: ClaudeExecutionRecommendationInput): void => {
  if (
    !Number.isSafeInteger(input.logicalCpuCount) ||
    input.logicalCpuCount <= 0 ||
    !Number.isSafeInteger(input.availableMemoryBytes) ||
    input.availableMemoryBytes <= 0 ||
    (input.benchmark !== undefined &&
      (!isPositiveWholeNumber(input.benchmark.stableConcurrentSubagents) ||
        !isPositiveWholeNumber(input.benchmark.stableToolUseConcurrency))) ||
    (input.rateLimit !== undefined &&
      (!Number.isFinite(input.rateLimit.remainingRatio) ||
        input.rateLimit.remainingRatio < 0 ||
        input.rateLimit.remainingRatio > 1))
  ) {
    throw new Error('机器与证据数据无效，无法推荐 Claude 执行档位。');
  }
};

/**
 * Selects a throughput policy from local machine and observed headroom only. Higher concurrency can
 * improve throughput for parallel work; it does not make Claude smarter or improve answer quality.
 */
export const recommendClaudeExecutionProfile = (
  input: ClaudeExecutionRecommendationInput,
): ClaudeExecutionRecommendation => {
  assertRecommendationInput(input);
  let selected = machineBaseline(input.logicalCpuCount, input.availableMemoryBytes);
  const benchmark = input.benchmark;
  const remainingRatio = input.rateLimit?.remainingRatio;
  if (benchmark) {
    selected = lowerProfile(selected, benchmarkCeiling(benchmark));
  }

  // The two aggressive profiles require both observed machine stability and rate-limit headroom.
  if (benchmark && remainingRatio !== undefined) {
    if (
      input.logicalCpuCount >= 24 &&
      input.availableMemoryBytes >= 32 * GIB &&
      benchmark.stableToolUseConcurrency >= 24 &&
      benchmark.stableConcurrentSubagents >= 20 &&
      remainingRatio >= 0.75
    ) {
      selected = 'best-performance';
    } else if (
      input.logicalCpuCount >= 16 &&
      input.availableMemoryBytes >= 16 * GIB &&
      benchmark.stableToolUseConcurrency >= 16 &&
      benchmark.stableConcurrentSubagents >= 16 &&
      remainingRatio >= 0.6
    ) {
      selected = 'high-throughput';
    }
  }

  if (remainingRatio !== undefined && remainingRatio < 0.25) {
    selected = lowerProfile(selected, 'token-saver');
  } else if (remainingRatio !== undefined && remainingRatio < 0.5) {
    selected = lowerProfile(selected, 'restrained');
  }

  return Object.freeze({
    profileId: selected,
    reason:
      benchmark && remainingRatio !== undefined
        ? '依据逻辑 CPU、可用内存、稳定并发基准与速率额度余量选择；并发只影响吞吐，不代表更高智力。'
        : '缺少完整基准或速率额度证据，保守限制在均衡或更低档位；并发只影响吞吐，不代表更高智力。',
  });
};
