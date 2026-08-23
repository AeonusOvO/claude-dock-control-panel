import {
  CLAUDE_EXECUTION_MANAGED_ENV_KEYS,
  type ClaudeExecutionCapabilityContext,
  type ClaudeExecutionEffectiveSetting,
  type ClaudeExecutionEffectiveSource,
  type ClaudeExecutionEffectiveView,
  type ClaudeExecutionEnvironmentOperation,
  type ClaudeExecutionInstallationSnapshot,
  type ClaudeExecutionOperations,
  type ClaudeExecutionRequestedValues,
  type ClaudeExecutionSettingsRequest,
  type ClaudeToolSearchEvidence,
  type ClaudeToolSearchRequest,
  type ClaudeToolUseConcurrencyEvidence,
} from '../../shared/contracts/claude-execution-settings';

export const CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT = 10;
export const CLAUDE_CONCURRENT_SUBAGENTS_DEFAULT = 20;

const VERSION_MATRIX_REFERENCE = 'ClaudeDock execution capability matrix v1';
const UNDOCUMENTED_REFERENCE = 'ClaudeDock conservative undocumented-capability policy v1';
const DEFAULT_REFERENCE = 'Claude Code environment default';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type VersionTuple = readonly [number, number, number];

export type ClaudeExecutionResolutionIntent = 'launch' | 'restore-default';

export interface ClaudeExecutionCapabilityResolution {
  effective: ClaudeExecutionEffectiveView;
  operations: ClaudeExecutionOperations;
}

/** Main-only: these complete environment copies may contain credentials and must never cross IPC. */
export interface ClaudeExecutionEnvironmentPair {
  /** Null remains an explicit inherited-process deletion marker at the PTY boundary. */
  processEnvironment: Readonly<Record<string, null | string>>;
  settingsEnvironment: Readonly<Record<string, string>>;
}

export interface ResolveClaudeExecutionCapabilitiesInput {
  context?: ClaudeExecutionCapabilityContext;
  installation: ClaudeExecutionInstallationSnapshot;
  intent?: ClaudeExecutionResolutionIntent;
  requested: ClaudeExecutionSettingsRequest;
  requestedValues?: ClaudeExecutionRequestedValues;
}

export const parseExactClaudeVersion = (value: string | undefined): VersionTuple | undefined => {
  const match = VERSION_PATTERN.exec(value ?? '');
  if (!match) {
    return undefined;
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    return undefined;
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};

const compareVersion = (left: VersionTuple, right: VersionTuple): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const source = (
  kind: ClaudeExecutionEffectiveSource['kind'],
  reference: string,
  verifiedAt?: number,
  expiresAt?: number,
): ClaudeExecutionEffectiveSource =>
  verifiedAt === undefined
    ? { kind, reference }
    : expiresAt === undefined
      ? { kind, reference, verifiedAt }
      : { expiresAt, kind, reference, verifiedAt };

const noOverride = (restoreClaudeDefault: boolean): ClaudeExecutionEnvironmentOperation =>
  restoreClaudeDefault ? { kind: 'delete' } : { kind: 'omit' };

const setNumber = (value: number): ClaudeExecutionEnvironmentOperation => ({
  kind: 'set',
  value: String(value),
});

const unavailableSetting = <T>(
  envKey: ClaudeExecutionEffectiveSetting<T>['envKey'],
  requestedValue: T | undefined,
  resetToDefault: boolean,
  reason: string,
): ClaudeExecutionEffectiveSetting<T> => ({
  envKey,
  operation: noOverride(resetToDefault),
  reason,
  requestedValue,
  source: source('version-matrix', VERSION_MATRIX_REFERENCE),
  status: 'unavailable',
});

const unknownVersionSetting = <T>(
  envKey: ClaudeExecutionEffectiveSetting<T>['envKey'],
  requestedValue: T | undefined,
  resetToDefault: boolean,
  defaults?: { defaultValue: T; effectiveValue: T },
): ClaudeExecutionEffectiveSetting<T> => ({
  ...defaults,
  envKey,
  operation: noOverride(resetToDefault),
  reason: 'Claude Code 版本未知或无法严格解析，保守地不应用此覆盖。',
  requestedValue,
  source: source('undocumented', UNDOCUMENTED_REFERENCE),
  status: 'unverified',
});

const resolveConcurrentSubagents = (
  installed: boolean,
  version: VersionTuple | undefined,
  requestedValue: number | undefined,
  resetToDefault: boolean,
): ClaudeExecutionEffectiveSetting<number> => {
  const envKey = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS' as const;
  if (!installed) {
    return unavailableSetting(envKey, requestedValue, resetToDefault, 'Claude Code 尚未安装。');
  }
  if (!version) {
    return unknownVersionSetting(envKey, requestedValue, resetToDefault);
  }
  if (compareVersion(version, [2, 1, 217]) < 0) {
    return {
      envKey,
      operation: noOverride(resetToDefault),
      reason: '并发子代理覆盖需要 Claude Code 2.1.217 或更高版本。',
      requestedValue,
      source: source('version-matrix', VERSION_MATRIX_REFERENCE),
      status: 'update-required',
    };
  }
  const effectiveValue = requestedValue ?? CLAUDE_CONCURRENT_SUBAGENTS_DEFAULT;
  return {
    defaultValue: CLAUDE_CONCURRENT_SUBAGENTS_DEFAULT,
    effectiveValue,
    envKey,
    operation:
      requestedValue === undefined ? noOverride(resetToDefault) : setNumber(requestedValue),
    reason:
      requestedValue === undefined
        ? '未请求覆盖，使用 Claude Code 的并发子代理默认值 20。'
        : '当前版本支持配置并发子代理；20 是 Claude Code 默认值，不是支持上限。',
    requestedValue,
    source: source('version-matrix', VERSION_MATRIX_REFERENCE),
    status: 'supported',
  };
};

const spawnDefaultFor = (version: VersionTuple): number | undefined => {
  if (compareVersion(version, [2, 1, 172]) < 0) {
    return undefined;
  }
  if (compareVersion(version, [2, 1, 217]) < 0) {
    return 5;
  }
  return compareVersion(version, [2, 1, 219]) < 0 ? 1 : 3;
};

const resolveSpawnDepth = (
  installed: boolean,
  version: VersionTuple | undefined,
  requestedValue: number | undefined,
  resetToDefault: boolean,
): ClaudeExecutionEffectiveSetting<number> => {
  const envKey = 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH' as const;
  if (!installed) {
    return unavailableSetting(envKey, requestedValue, resetToDefault, 'Claude Code 尚未安装。');
  }
  if (!version) {
    return unknownVersionSetting(envKey, requestedValue, resetToDefault);
  }
  const defaultValue = spawnDefaultFor(version);
  if (defaultValue === undefined) {
    return unavailableSetting(
      envKey,
      requestedValue,
      resetToDefault,
      'Claude Code 2.1.172 之前没有可验证的子代理派生深度能力。',
    );
  }
  if (compareVersion(version, [2, 1, 217]) < 0) {
    return {
      defaultValue,
      effectiveValue: defaultValue,
      envKey,
      operation: noOverride(resetToDefault),
      reason: 'Claude Code 2.1.172 至 2.1.216 的子代理派生深度固定为 5，不能覆盖。',
      requestedValue,
      source: source('version-matrix', VERSION_MATRIX_REFERENCE),
      status: 'fixed',
    };
  }
  const effectiveValue = requestedValue ?? defaultValue;
  return {
    defaultValue,
    effectiveValue,
    envKey,
    operation:
      requestedValue === undefined ? noOverride(resetToDefault) : setNumber(requestedValue),
    reason:
      requestedValue === undefined
        ? `未请求覆盖，使用当前版本的派生深度默认值 ${defaultValue}。`
        : `当前版本支持配置派生深度；${defaultValue} 是版本默认值，不是支持上限。`,
    requestedValue,
    source: source('version-matrix', VERSION_MATRIX_REFERENCE),
    status: 'supported',
  };
};

const validEvidenceStamp = (
  evidence: { source: string; verifiedAt: number },
  now: number,
): boolean =>
  evidence.source.trim().length > 0 &&
  evidence.source.length <= 500 &&
  Number.isFinite(evidence.verifiedAt) &&
  evidence.verifiedAt >= 0 &&
  evidence.verifiedAt <= now;

const matchingToolUseEvidence = (
  evidence: readonly ClaudeToolUseConcurrencyEvidence[] | undefined,
  exactVersion: string,
  now: number,
): ClaudeToolUseConcurrencyEvidence | 'conflict' | undefined => {
  const matches =
    evidence?.filter(
      (candidate) => candidate.exactVersion === exactVersion && validEvidenceStamp(candidate, now),
    ) ?? [];
  if (matches.length === 0 || new Set(matches.map((candidate) => candidate.supported)).size > 1) {
    return matches.length === 0 ? undefined : 'conflict';
  }
  return [...matches].sort((left, right) => right.verifiedAt - left.verifiedAt)[0];
};

const resolveToolUseConcurrency = (
  installed: boolean,
  version: VersionTuple | undefined,
  exactVersion: string | undefined,
  requestedValue: number | undefined,
  resetToDefault: boolean,
  evidence: readonly ClaudeToolUseConcurrencyEvidence[] | undefined,
  now: number,
): ClaudeExecutionEffectiveSetting<number> => {
  const envKey = 'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY' as const;
  const common = {
    defaultValue: CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
    effectiveValue: CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
    envKey,
    operation: noOverride(resetToDefault),
    requestedValue,
  };
  if (!installed) {
    return {
      ...common,
      reason: 'Claude Code 尚未安装。',
      source: source('undocumented', UNDOCUMENTED_REFERENCE),
      status: 'unavailable',
    };
  }
  if (!version || !exactVersion) {
    return unknownVersionSetting(envKey, requestedValue, resetToDefault, {
      defaultValue: CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
      effectiveValue: CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
    });
  }
  if (compareVersion(version, [2, 1, 217]) >= 0) {
    return {
      defaultValue: CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
      effectiveValue: requestedValue ?? CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
      envKey,
      operation:
        requestedValue === undefined ? noOverride(resetToDefault) : setNumber(requestedValue),
      reason:
        requestedValue === undefined
          ? '未请求覆盖，使用 Claude Code 官方记录的工具调用并发默认值 10。'
          : 'Claude Code 官方环境变量参考支持工具调用并发覆盖；10 是默认值，不是支持上限。',
      requestedValue,
      source: source('version-matrix', VERSION_MATRIX_REFERENCE),
      status: 'supported',
    };
  }
  const match = matchingToolUseEvidence(evidence, exactVersion, now);
  if (!match || match === 'conflict') {
    return {
      ...common,
      reason:
        match === 'conflict'
          ? '同一精确版本的工具并发证据互相冲突，保守地不应用覆盖。'
          : '工具调用并发的引入版本与上限未公开；缺少当前精确版本的支持证据，未应用覆盖。',
      source: source('undocumented', UNDOCUMENTED_REFERENCE),
      status: 'unverified',
    };
  }
  if (!match.supported) {
    return {
      ...common,
      reason: '当前精确版本的注入证据标记该覆盖不可用。',
      source: source('verified-evidence', match.source, match.verifiedAt),
      status: 'unavailable',
    };
  }
  return {
    defaultValue: CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
    effectiveValue: requestedValue ?? CLAUDE_TOOL_USE_CONCURRENCY_DEFAULT,
    envKey,
    operation:
      requestedValue === undefined ? noOverride(resetToDefault) : setNumber(requestedValue),
    reason:
      requestedValue === undefined
        ? '未请求覆盖，使用 Claude Code 的工具调用并发默认值 10。'
        : '精确版本支持证据允许应用工具调用并发；10 是默认值，不是支持上限。',
    requestedValue,
    source: source('verified-evidence', match.source, match.verifiedAt),
    status: 'supported',
  };
};

const serializeToolSearch = (requestedValue: Exclude<ClaudeToolSearchRequest, 'inherit'>): string =>
  String(requestedValue);

const matchingToolSearchEvidence = (
  evidence: readonly ClaudeToolSearchEvidence[] | undefined,
  routeId: string,
  model: string,
  now: number,
): ClaudeToolSearchEvidence | 'conflict' | undefined => {
  const exactMatches =
    evidence?.filter((candidate) => candidate.routeId === routeId && candidate.model === model) ??
    [];
  const freshMatches = exactMatches.filter(
    (candidate) =>
      validEvidenceStamp(candidate, now) &&
      Number.isFinite(candidate.expiresAt) &&
      candidate.expiresAt >= candidate.verifiedAt &&
      candidate.expiresAt >= now,
  );
  if (freshMatches.length === 0) {
    return undefined;
  }
  if (new Set(freshMatches.map((candidate) => candidate.supported)).size > 1) {
    return 'conflict';
  }
  return [...freshMatches].sort((left, right) => right.verifiedAt - left.verifiedAt)[0];
};

const resolveToolSearch = (
  installed: boolean,
  version: VersionTuple | undefined,
  requestedValue: ClaudeToolSearchRequest | undefined,
  resetToDefault: boolean,
  context: ClaudeExecutionCapabilityContext,
  now: number,
): ClaudeExecutionEffectiveSetting<ClaudeToolSearchRequest> => {
  const envKey = 'ENABLE_TOOL_SEARCH' as const;
  if (!installed) {
    return {
      defaultValue: 'inherit',
      effectiveValue: 'inherit',
      envKey,
      operation: noOverride(resetToDefault),
      reason: 'Claude Code 尚未安装。',
      requestedValue,
      source: source('undocumented', UNDOCUMENTED_REFERENCE),
      status: 'unavailable',
    };
  }
  if (requestedValue === undefined || requestedValue === 'inherit') {
    return {
      defaultValue: 'inherit',
      effectiveValue: 'inherit',
      envKey,
      operation: noOverride(resetToDefault),
      reason:
        requestedValue === undefined
          ? '已移除 ClaudeDock 管理的工具搜索覆盖，交回 Claude Code 默认行为。'
          : '明确继承现有环境，不把继承误解为删除进程变量。',
      requestedValue,
      source:
        requestedValue === undefined
          ? source('claude-default', DEFAULT_REFERENCE)
          : source('requested-inherit', 'Requested ENABLE_TOOL_SEARCH inheritance'),
      status: 'supported',
    };
  }
  if (!version) {
    return unknownVersionSetting<ClaudeToolSearchRequest>(envKey, requestedValue, resetToDefault, {
      defaultValue: 'inherit',
      effectiveValue: 'inherit',
    });
  }
  const route = context.route;
  if (
    route?.officialNetworkProvider === 'anthropic-claude' &&
    compareVersion(version, [2, 1, 221]) >= 0
  ) {
    return {
      defaultValue: 'inherit',
      effectiveValue: requestedValue,
      envKey,
      operation: { kind: 'set', value: serializeToolSearch(requestedValue) },
      reason: '当前为官方 Anthropic 路由，Claude Code 官方环境变量参考支持工具搜索覆盖。',
      requestedValue,
      source: source('version-matrix', VERSION_MATRIX_REFERENCE),
      status: 'supported',
    };
  }
  const match = route
    ? matchingToolSearchEvidence(context.evidence?.toolSearch, route.routeId, route.model, now)
    : undefined;
  if (!match || match === 'conflict') {
    return {
      defaultValue: 'inherit',
      effectiveValue: 'inherit',
      envKey,
      operation: noOverride(resetToDefault),
      reason:
        match === 'conflict'
          ? '当前精确路由与模型的工具搜索证据互相冲突，已保留请求但不应用。'
          : '缺少当前精确路由与模型的有效、新鲜支持证据；已保留请求但不应用。',
      requestedValue,
      source: source('undocumented', UNDOCUMENTED_REFERENCE),
      status: 'unverified',
    };
  }
  if (!match.supported) {
    return {
      defaultValue: 'inherit',
      effectiveValue: 'inherit',
      envKey,
      operation: noOverride(resetToDefault),
      reason: '当前精确路由与模型的有效证据标记工具搜索覆盖不可用。',
      requestedValue,
      source: source('verified-evidence', match.source, match.verifiedAt, match.expiresAt),
      status: 'unavailable',
    };
  }
  return {
    defaultValue: 'inherit',
    effectiveValue: requestedValue,
    envKey,
    operation: { kind: 'set', value: serializeToolSearch(requestedValue) },
    reason: '当前精确路由与模型具有仍在有效期内的支持证据。',
    requestedValue,
    source: source('verified-evidence', match.source, match.verifiedAt, match.expiresAt),
    status: 'supported',
  };
};

const freezeSetting = <T>(
  setting: ClaudeExecutionEffectiveSetting<T>,
): ClaudeExecutionEffectiveSetting<T> =>
  Object.freeze({
    ...setting,
    operation: Object.freeze({ ...setting.operation }),
    source: Object.freeze({ ...setting.source }),
  });

export const resolveClaudeExecutionCapabilities = (
  input: ResolveClaudeExecutionCapabilitiesInput,
): ClaudeExecutionCapabilityResolution => {
  const noRequestedOverride = input.requested.mode === 'claude-default';
  if (noRequestedOverride !== (input.requestedValues === undefined)) {
    throw new Error('Claude 执行请求与已解析档位值不一致。');
  }
  const resetToDefault = input.intent === 'restore-default';
  if (resetToDefault && !noRequestedOverride) {
    throw new Error('只有 Claude 默认请求可以执行显式恢复。');
  }
  const now = input.context?.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error('Claude 执行能力证据时间无效。');
  }
  const exactVersion = input.installation.version;
  const version = parseExactClaudeVersion(exactVersion);
  const values = input.requestedValues;
  const effective = Object.freeze({
    concurrentSubagents: freezeSetting(
      resolveConcurrentSubagents(
        input.installation.installed,
        version,
        values?.concurrentSubagents,
        resetToDefault,
      ),
    ),
    spawnDepth: freezeSetting(
      resolveSpawnDepth(input.installation.installed, version, values?.spawnDepth, resetToDefault),
    ),
    toolSearch: freezeSetting(
      resolveToolSearch(
        input.installation.installed,
        version,
        values?.toolSearch,
        resetToDefault,
        input.context ?? {},
        now,
      ),
    ),
    toolUseConcurrency: freezeSetting(
      resolveToolUseConcurrency(
        input.installation.installed,
        version,
        exactVersion,
        values?.toolUseConcurrency,
        resetToDefault,
        input.context?.evidence?.toolUseConcurrency,
        now,
      ),
    ),
  });
  const operations: ClaudeExecutionOperations = Object.freeze({
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: effective.concurrentSubagents.operation,
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: effective.spawnDepth.operation,
    CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: effective.toolUseConcurrency.operation,
    ENABLE_TOOL_SEARCH: effective.toolSearch.operation,
  });
  return Object.freeze({ effective, operations });
};

const copyProcessEnvironment = (
  environment: Readonly<Record<string, null | string | undefined>>,
): Record<string, null | string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, null | string] =>
        entry[1] === null || typeof entry[1] === 'string',
    ),
  );

const copySettingsEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

const removeCaseInsensitiveKey = (
  environment: Record<string, null | string>,
  canonicalKey: (typeof CLAUDE_EXECUTION_MANAGED_ENV_KEYS)[number],
): void => {
  const normalizedKey = canonicalKey.toLowerCase();
  for (const existingKey of Object.keys(environment)) {
    if (existingKey.toLowerCase() === normalizedKey) {
      delete environment[existingKey];
    }
  }
};

const applyOperations = <Environment extends Record<string, null | string>>(
  environment: Environment,
  operations: ClaudeExecutionOperations,
): Readonly<Environment> => {
  const mutableEnvironment: Record<string, null | string> = environment;
  for (const key of CLAUDE_EXECUTION_MANAGED_ENV_KEYS) {
    const operation = operations[key];
    if (operation.kind === 'omit') {
      continue;
    }
    removeCaseInsensitiveKey(mutableEnvironment, key);
    if (operation.kind === 'set') {
      mutableEnvironment[key] = operation.value;
    }
  }
  return Object.freeze(environment);
};

/** Applies one capability snapshot identically to PTY process env and native settings.env. */
export const materializeClaudeExecutionEnvironments = (
  operations: ClaudeExecutionOperations,
  processEnvironment: Readonly<Record<string, null | string | undefined>>,
  settingsEnvironment: Readonly<Record<string, string | undefined>>,
): ClaudeExecutionEnvironmentPair =>
  Object.freeze({
    processEnvironment: applyOperations(copyProcessEnvironment(processEnvironment), operations),
    settingsEnvironment: applyOperations(copySettingsEnvironment(settingsEnvironment), operations),
  });
