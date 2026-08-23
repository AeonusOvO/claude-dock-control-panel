import type { NetworkProviderId } from './network';

/** Schema for ClaudeDock's independent Claude Code execution-settings store. */
export const CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION = 1 as const;

/** Version of ClaudeDock's custom numeric input-safety policy. */
export const CLAUDE_EXECUTION_INPUT_SAFETY_BOUNDS_VERSION = 1 as const;

const freezeNumericBounds = (minimum: number, maximum: number) =>
  Object.freeze({ maximum, minimum });

/**
 * ClaudeDock input-safety guardrails for custom values. These are deliberately generous product
 * limits, not claims about Claude Code's supported maxima and not values inferred from profiles.
 */
export const CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS = Object.freeze({
  concurrentSubagents: freezeNumericBounds(1, 128),
  spawnDepth: freezeNumericBounds(1, 16),
  toolUseConcurrency: freezeNumericBounds(1, 128),
});

/**
 * The complete allowlist owned by this feature. Do not add aliases unless Claude Code itself has an
 * independently verified key with that exact spelling.
 */
export const CLAUDE_EXECUTION_MANAGED_ENV_KEYS = Object.freeze([
  'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
  'ENABLE_TOOL_SEARCH',
] as const);

export type ClaudeExecutionManagedEnvKey = (typeof CLAUDE_EXECUTION_MANAGED_ENV_KEYS)[number];

const managedEnvironmentKeySet: ReadonlySet<string> = new Set(CLAUDE_EXECUTION_MANAGED_ENV_KEYS);

export const isClaudeExecutionManagedEnvKey = (
  value: string,
): value is ClaudeExecutionManagedEnvKey => managedEnvironmentKeySet.has(value);

export const assertClaudeExecutionManagedEnvKey: (
  value: string,
) => asserts value is ClaudeExecutionManagedEnvKey = (value) => {
  if (!isClaudeExecutionManagedEnvKey(value)) {
    throw new Error(`Claude 执行设置不管理环境变量 ${value}。`);
  }
};

export type ClaudeExecutionProfileId =
  'balanced' | 'best-performance' | 'high-throughput' | 'restrained' | 'token-saver';

/** Runtime validation narrows the template member to the canonical auto:0…auto:100 range. */
export type ClaudeToolSearchRequest = 'auto' | `auto:${number}` | 'inherit' | boolean;

export interface ClaudeExecutionRequestedValues {
  concurrentSubagents: number;
  spawnDepth: number;
  toolSearch: ClaudeToolSearchRequest;
  toolUseConcurrency: number;
}

export type ClaudeExecutionSettingsRequest =
  | { mode: 'claude-default' }
  | { mode: 'custom'; values: ClaudeExecutionRequestedValues }
  | { mode: 'profile'; profileId: ClaudeExecutionProfileId };

export interface ClaudeExecutionSettingsSnapshot {
  catalogVersion: number;
  requested: ClaudeExecutionSettingsRequest;
  version: typeof CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION;
}

export interface ClaudeExecutionProfile {
  /**
   * These values are ClaudeDock product recommendations, not claims about Claude Code's supported
   * maxima. Capability evidence still decides whether an environment override may be applied.
   */
  id: ClaudeExecutionProfileId;
  label: string;
  values: ClaudeExecutionRequestedValues;
}

export type ClaudeExecutionCapabilityStatus =
  'fixed' | 'supported' | 'unavailable' | 'unverified' | 'update-required';

export type ClaudeExecutionSourceKind =
  'claude-default' | 'requested-inherit' | 'undocumented' | 'verified-evidence' | 'version-matrix';

export interface ClaudeExecutionEffectiveSource {
  expiresAt?: number;
  kind: ClaudeExecutionSourceKind;
  reference: string;
  verifiedAt?: number;
}

/**
 * `set` writes an override, `omit` leaves the caller's environment untouched (including inherit),
 * and `delete` explicitly removes a key. Unset/inherit must never be collapsed into `delete`.
 */
export type ClaudeExecutionEnvironmentOperation =
  { kind: 'delete' } | { kind: 'omit' } | { kind: 'set'; value: string };

export interface ClaudeExecutionEffectiveSetting<T> {
  defaultValue?: T;
  effectiveValue?: T;
  envKey: ClaudeExecutionManagedEnvKey;
  operation: ClaudeExecutionEnvironmentOperation;
  reason: string;
  requestedValue?: T;
  source: ClaudeExecutionEffectiveSource;
  status: ClaudeExecutionCapabilityStatus;
}

export interface ClaudeExecutionEffectiveView {
  concurrentSubagents: ClaudeExecutionEffectiveSetting<number>;
  spawnDepth: ClaudeExecutionEffectiveSetting<number>;
  toolSearch: ClaudeExecutionEffectiveSetting<ClaudeToolSearchRequest>;
  toolUseConcurrency: ClaudeExecutionEffectiveSetting<number>;
}

export interface ClaudeExecutionInstallationSnapshot {
  installed: boolean;
  version?: string;
}

export interface ClaudeExecutionSettingsView extends ClaudeExecutionSettingsSnapshot {
  effective: ClaudeExecutionEffectiveView;
  installation: ClaudeExecutionInstallationSnapshot;
}

export interface ClaudeExecutionEvidenceStamp {
  source: string;
  verifiedAt: number;
}

export interface ClaudeToolUseConcurrencyEvidence extends ClaudeExecutionEvidenceStamp {
  exactVersion: string;
  supported: boolean;
}

export interface ClaudeToolSearchEvidence extends ClaudeExecutionEvidenceStamp {
  expiresAt: number;
  model: string;
  routeId: string;
  supported: boolean;
}

export interface ClaudeExecutionCapabilityEvidence {
  toolSearch?: readonly ClaudeToolSearchEvidence[];
  toolUseConcurrency?: readonly ClaudeToolUseConcurrencyEvidence[];
}

export interface ClaudeExecutionRouteSnapshot {
  model: string;
  officialNetworkProvider?: NetworkProviderId;
  routeId: string;
}

export interface ClaudeExecutionCapabilityContext {
  evidence?: ClaudeExecutionCapabilityEvidence;
  now?: number;
  route?: ClaudeExecutionRouteSnapshot;
}

export type ClaudeExecutionOperations = Readonly<
  Record<ClaudeExecutionManagedEnvKey, ClaudeExecutionEnvironmentOperation>
>;

/** Safe IPC source metadata. Raw evidence references remain main-process-only. */
export interface ClaudeExecutionEffectiveSourceDto {
  expiresAt?: number;
  kind: ClaudeExecutionSourceKind;
  verifiedAt?: number;
}

/** Safe IPC status for one setting. Environment keys and operations never cross this boundary. */
export interface ClaudeExecutionEffectiveSettingDto<T> {
  defaultValue?: T;
  effectiveValue?: T;
  reason: string;
  requestedValue?: T;
  source: ClaudeExecutionEffectiveSourceDto;
  status: ClaudeExecutionCapabilityStatus;
}

export interface ClaudeExecutionEffectiveViewDto {
  concurrentSubagents: ClaudeExecutionEffectiveSettingDto<number>;
  spawnDepth: ClaudeExecutionEffectiveSettingDto<number>;
  toolSearch: ClaudeExecutionEffectiveSettingDto<ClaudeToolSearchRequest>;
  toolUseConcurrency: ClaudeExecutionEffectiveSettingDto<number>;
}

export interface ClaudeExecutionProfileDto {
  id: ClaudeExecutionProfileId;
  label: string;
  values: ClaudeExecutionRequestedValues;
}

/** Whitelist-projected renderer contract: request choices plus safe effective status only. */
export interface ClaudeExecutionSettingsDto extends ClaudeExecutionSettingsSnapshot {
  effective: ClaudeExecutionEffectiveViewDto;
  installation: ClaudeExecutionInstallationSnapshot;
  profiles: readonly ClaudeExecutionProfileDto[];
}
