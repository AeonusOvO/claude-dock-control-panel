import type { ClaudeProviderId } from '../claude/providers';
import type { FailureMetadata } from '../diagnostics/failure';
import type {
  NetworkPreflightAction,
  NetworkPreflightScope,
  NetworkProcessKind,
  NetworkProbeResult,
  NetworkProviderId,
} from './network';
import type { ResourceUsageView } from './resource';
import type { PtyGeneration } from './terminal';
import type { WorkspaceResult } from './workspace';

export type ClaudeAuthMode = 'apiKey' | 'authToken' | 'existing' | 'none';

export type ClaudeApiKeyHelperPolicy = 'inherit' | 'prefer-claudedock';

export type ClaudeCredentialAction = 'clear' | 'keep' | 'replace';

export type ClaudeLaunchMode = 'continue' | 'new' | 'resume';

/**
 * Claude Code's own permission-mode identifiers. `default` is the mode the CLI labels 「手动确认」;
 * `dontAsk` never appears in the Shift+Tab cycle and can only be selected at launch.
 */
export type ClaudePermissionMode =
  'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';

/**
 * Reasoning effort levels Claude Code accepts. `low`…`max` are real model effort levels; `auto`
 * resets to the active model's default, and `ultracode` is a Claude Code setting that sends `xhigh`
 * plus workflow orchestration. Only the five real levels can ever come back from the status line —
 * `auto` resolves to a concrete level, and `ultracode` reports as `xhigh`.
 */
export type ClaudeEffortLevel = 'high' | 'low' | 'max' | 'medium' | 'xhigh';

export type ClaudeEffortRequest = ClaudeEffortLevel | 'auto' | 'ultracode';

export interface ClaudeEffortCompatibility {
  /**
   * Claude Code sent a high effort value while the request had thinking disabled. The current
   * session stays capped until a model switch or relaunch gives the new request path a fresh try.
   */
  maximum: 'high';
  detectedAt: number;
  rejectedLevel: 'max' | 'xhigh';
  recovery: 'failed' | 'pending' | 'recovered';
}

export type ClaudePreset = ClaudeProviderId;

export type ClaudeProvider = 'anthropic' | 'gateway';

export type ClaudeSecurityStatus =
  'blocked-version' | 'not-installed' | 'ready' | 'update-required' | 'unknown';

export type ClaudeConnectionTestTone = 'error' | 'success' | 'warning';

export type ClaudeRouteHealthSource = 'connection-test' | 'router' | 'runtime';

export type ClaudeRouteHealthTone = 'error' | 'success' | 'warning';

export type ClaudeEndpointProtocol = 'anthropic' | 'openai' | 'unknown';

export type GatewayCandidateKind = 'claude-code-router' | 'cliproxyapi' | 'custom' | 'litellm';

export type GatewayCandidateStatus = 'offline' | 'partial' | 'ready';

/** Kept with the Claude types rather than the router types because a saved connection records it. */
export type ClaudeRouterGatewayState = 'error' | 'running' | 'starting' | 'stopped' | 'unknown';

export type ClaudeCodeInstallationKind = 'native' | 'npm' | 'unknown';

export type ModelSpeedMode = 'fast' | 'standard';

export type ModelSpeedMechanism = 'claude-native-fast' | 'gpt-service-tier' | 'none';

export type ModelSpeedAvailability = 'available' | 'unsupported' | 'unverified' | 'update-required';

export type ModelSpeedStatus = 'active' | 'not-active' | 'requested' | 'standard';

export interface ModelSpeedState {
  availability: ModelSpeedAvailability;
  canSelectFast: boolean;
  detail: string;
  mechanism: ModelSpeedMechanism;
  model: string;
  preference: ModelSpeedMode;
  status: ModelSpeedStatus;
}

export interface ClaudeConfigView {
  apiKeyHelperPolicy: ClaudeApiKeyHelperPolicy;
  authMode: ClaudeAuthMode;
  baseUrl: string;
  credentialConfigured: boolean;
  model: string;
  modelFast?: string;
  preset: ClaudePreset;
  protocol: ClaudeEndpointProtocol;
  provider: ClaudeProvider;
  routerProviderId?: string;
  sourceAuthMode?: ClaudeAuthMode;
  sourceBaseUrl?: string;
  sourceCredentialConfigured?: boolean;
  sourceModel?: string;
  sourceModelFast?: string;
}

export interface SaveClaudeConfigInput {
  apiKeyHelperPolicy?: ClaudeApiKeyHelperPolicy;
  authMode: ClaudeAuthMode;
  baseUrl: string;
  credential?: string;
  credentialAction: ClaudeCredentialAction;
  model: string;
  modelFast?: string;
  preset: ClaudePreset;
  protocol?: Exclude<ClaudeEndpointProtocol, 'unknown'>;
  provider: ClaudeProvider;
  routerProviderId?: string;
}

/**
 * A previously saved connection setup, selectable for a confirmed and tested replay. The credential
 * itself never leaves the main process — the renderer only learns whether one is attached.
 */
export interface ClaudeConnectionHistoryEntry {
  apiKeyHelperPolicy: ClaudeApiKeyHelperPolicy;
  authMode: ClaudeAuthMode;
  baseUrl: string;
  credentialConfigured: boolean;
  gatewayEndpoint?: string;
  gatewayState: ClaudeRouterGatewayState;
  id: string;
  model: string;
  modelFast?: string;
  name?: string;
  preset: ClaudePreset;
  protocol: ClaudeEndpointProtocol;
  provider: ClaudeProvider;
  routerProviderId?: string;
  savedAt: number;
  sourceAuthMode?: ClaudeAuthMode;
  sourceBaseUrl?: string;
  sourceCredentialConfigured?: boolean;
  sourceModel?: string;
  sourceModelFast?: string;
}

export interface ClaudeConnectionHistoryResult extends FailureMetadata {
  connectionTest?: ClaudeConnectionTestResult;
  entries: ClaudeConnectionHistoryEntry[];
  error?: string;
  ok: boolean;
  /** Present when applying an entry changed the live configuration. */
  state?: ClaudeProjectState;
}

export interface ClaudeInstallationStatus {
  executable?: string;
  installationKind: ClaudeCodeInstallationKind;
  installed: boolean;
  message: string;
  security: ClaudeSecurityStatus;
  version?: string;
}

export interface ClaudeMetrics {
  capturedAt: number;
  contextWindowSize?: number;
  contextWindowUsed?: number;
  /** Live `effort.level` from the status line; absent when the model has no effort parameter. */
  effortLevel?: ClaudeEffortLevel;
  /** Native Claude Code serving-speed state; unrelated to the alternate small-model route. */
  fastMode?: boolean;
  inputTokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
  modelDisplayName?: string;
  modelId?: string;
  outputTokens?: number;
  rateLimitFiveHour?: number;
  rateLimitFiveHourResetsAt?: number;
  rateLimitSevenDay?: number;
  rateLimitSevenDayResetsAt?: number;
  sessionCostUsd?: number;
  sessionDurationMs?: number;
  sessionId?: string;
  sessionName?: string;
}

export interface ClaudeRouteHealth {
  blocking: boolean;
  checkedAt: number;
  detail: string;
  headline: string;
  source: ClaudeRouteHealthSource;
  tone: ClaudeRouteHealthTone;
}

/** Safe, credential-free identity reported by the installed Claude Code CLI. */
export interface ClaudeOfficialAuthState {
  accountIdentity?: string;
  authMethod?: string;
  available: boolean;
  checkedAt: number;
  loggedIn: boolean;
}

export interface ClaudeProjectState {
  active: boolean;
  /** Whether the next launch arms `bypassPermissions` so Shift+Tab can reach it. */
  allowBypassPermissions: boolean;
  config: ClaudeConfigView;
  cwd: string;
  /**
   * Effort last requested from the status bar this session. Shown until the status line reports the
   * level Claude Code actually applied, which can be lower when the model caps it.
   */
  effortRequest?: ClaudeEffortRequest;
  /** Temporary retry cap installed after Claude Code rejects high effort without thinking. */
  effortCompatibility?: ClaudeEffortCompatibility;
  expectedModel?: string;
  installation: ClaudeInstallationStatus;
  metrics?: ClaudeMetrics;
  modelMatches?: boolean;
  /** Present only for the first-party Claude subscription route. */
  officialAuth?: ClaudeOfficialAuthState;
  /** Parsed from the live Claude Code badge; absent until the badge has been seen once. */
  permissionMode?: ClaudePermissionMode;
  /** Last mode requested through ClaudeDock; the live badge remains the applied truth. */
  permissionModeRequest?: ClaudePermissionMode;
  /** Modes actually observed in this session, in the order Shift+Tab visited them. */
  permissionModeCycle?: ClaudePermissionMode[];
  /** Exact PowerShell/ConPTY generation that owns the active runtime; absent while inactive/unbound. */
  ptyGeneration?: PtyGeneration;
  resourceUsage?: ResourceUsageView;
  routeHealth?: ClaudeRouteHealth;
  sessionId: string;
  /** Monotonic request order used to reject delayed state reads from an older runtime snapshot. */
  stateRevision: number;
  speed: ModelSpeedState;
  warning?: string;
}

export interface ClaudeConfigResult extends FailureMetadata {
  error?: string;
  ok: boolean;
  state: ClaudeProjectState;
}

export interface ClaudeOperationResult extends FailureMetadata {
  error?: string;
  ok: boolean;
  state: ClaudeProjectState;
}

/**
 * Renderer-safe explanation for a Claude launch paused by main-owned network authorization. It is
 * rebuilt from a strict allow-list so the dialog can attribute the exact decision without exposing
 * cwd, credentials, route leases, configuration revisions, or run identities.
 */
export interface ClaudeLaunchPauseDiagnostics {
  action: NetworkPreflightAction;
  checkedAt: number;
  failedItems: ReadonlyArray<{
    checkedAt: number;
    detail: string;
    kind: NetworkProbeResult['kind'];
    label: string;
    process: NetworkProcessKind;
    required: boolean;
    status: 'failed' | 'warning';
    target?: string;
  }>;
  freshness: 'fresh' | 'unknown';
  provider: NetworkProviderId;
  providerLabel: string;
  reasons: readonly string[];
  scope: NetworkPreflightScope;
  status: 'blocked' | 'degraded';
  summary: string;
}

export type ClaudeLaunchOutcome =
  | {
      result: ClaudeOperationResult;
      status: 'completed';
    }
  | {
      decisionId: string;
      diagnostics: ClaudeLaunchPauseDiagnostics;
      status: 'paused';
    };

export interface ClaudeLaunchPreflightDecisionInput {
  choice: 'bypass' | 'cancel' | 'recheck';
  decisionId: string;
}

export type ClaudeLaunchPreflightDecisionOutcome =
  | {
      result: ClaudeOperationResult;
      status: 'completed';
    }
  | {
      decisionId: string;
      diagnostics: ClaudeLaunchPauseDiagnostics;
      status: 'paused';
    }
  | {
      status: 'cancelled' | 'consumed' | 'stale';
    };

export interface ClaudeConnectionTestStage {
  detail: string;
  id: 'authentication' | 'endpoint' | 'model';
  label: string;
  status: 'failed' | 'passed' | 'skipped' | 'warning';
}

export interface ClaudeConnectionTestResult extends FailureMetadata {
  authMode?: ClaudeAuthMode;
  failureKind?:
    'authentication' | 'model' | 'network' | 'not-found' | 'response-shape' | 'timeout' | 'unknown';
  httpStatus?: number;
  latencyMs?: number;
  message: string;
  observedProtocol?: 'anthropic' | 'openai' | 'unknown';
  ok: boolean;
  stages: ClaudeConnectionTestStage[];
  testedAt: number;
  tone: ClaudeConnectionTestTone;
}

/**
 * One switchable model in the status-bar picker. `sameEndpoint` decides the mechanism: same
 * endpoint switches inside the live conversation via `/model`, otherwise the session must relaunch
 * because the base URL and credential are baked into the PTY environment.
 */
export interface ClaudeModelOption {
  /** Present when the option came from connection history; needed to replay that entry. */
  entryId?: string;
  id: string;
  label: string;
  model: string;
  providerLabel: string;
  /** A different connection or serving-speed profile is baked into the PTY and needs a relaunch. */
  requiresRelaunch: boolean;
  relaunchReason?: 'connection' | 'speed-profile';
  sameEndpoint: boolean;
}

export interface ClaudeModelOptions {
  activeModel: string;
  options: ClaudeModelOption[];
}

/**
 * A relaunch request. Both a cross-endpoint model switch and a `dontAsk` mode change need the PTY
 * restarted, so they share one path: optionally compact, apply the new configuration, then
 * relaunch with `--continue` so the conversation is restored.
 */
export interface ClaudeRelaunchInput {
  /** Run `/compact` and wait for the PostCompact signal before restarting. */
  compactFirst: boolean;
  /** Connection-history entry to apply first; omit to keep the current configuration. */
  entryId?: string;
  /** Permission mode to start the new session in; omit to keep the project default. */
  permissionMode?: ClaudePermissionMode;
}

export interface ClaudeGatewayCandidate {
  apiBaseUrl: string;
  authRequired: boolean;
  detail: string;
  detectedBy: string[];
  id: string;
  kind: GatewayCandidateKind;
  label: string;
  managementUrl?: string;
  status: GatewayCandidateStatus;
}

export interface ClaudeConfigurationHint {
  apiKeyHelperConfigured?: boolean;
  authConfigured: boolean;
  baseUrl?: string;
  label: string;
  source: 'environment' | 'project-settings' | 'user-settings';
}

export interface ClaudeGatewayDiagnostics {
  candidates: ClaudeGatewayCandidate[];
  checkedAt: number;
  configurationHints: ClaudeConfigurationHint[];
  message: string;
}

export interface ClaudeProviderModelDiscoveryInput {
  baseUrl: string;
  credential?: string;
}

export interface ClaudeProviderModelDiscoveryResult extends FailureMetadata {
  error?: string;
  message: string;
  models: string[];
  ok: boolean;
}

export interface ClaudeSessionMetadata {
  conversationId: string;
  estimatedCostUsd?: number;
  inputTokens?: number;
  lastActiveAt: number;
  messageCount: number;
  modelId?: string;
  outputTokens?: number;
  sessionId: string;
  sessionName?: string;
}

export type ClaudeConversationModelChoice = 'use-conversation' | 'use-current';

export type ClaudeConversationModelDifference =
  | 'account'
  | 'authentication'
  | 'credential'
  | 'endpoint'
  | 'main-model'
  | 'platform'
  | 'protocol'
  | 'router-provider'
  | 'small-model';

/** Renderer-safe, complete identity of one conversation-bound model connection. */
export interface ClaudeConversationModelIdentity {
  accountDetail: string;
  accountIdentity?: string;
  authModeLabel: string;
  connectionName?: string;
  credentialConfigured: boolean;
  /** Short SHA-256 prefix. It distinguishes keys without disclosing key material. */
  credentialFingerprint?: string;
  endpoint?: string;
  mainModel: string;
  networkPresentation: 'domestic' | 'foreign' | 'local';
  protocolLabel: string;
  providerLabel: string;
  smallModel: string;
  source: 'bound' | 'current' | 'legacy-inferred' | 'legacy-model-only';
}

export interface ClaudeConversationModelResolution {
  conversation: ClaudeConversationModelIdentity;
  current: ClaudeConversationModelIdentity;
  differences: ClaudeConversationModelDifference[];
  mismatch: boolean;
  preference: 'ask' | 'use-conversation' | 'use-current';
  /** False only for an old transcript whose original connection can no longer be reconstructed. */
  restorable: boolean;
}

export interface ClaudeConversationModelApplyResult extends FailureMetadata {
  choice: ClaudeConversationModelChoice;
  connectionTest?: ClaudeConnectionTestResult;
  error?: string;
  ok: boolean;
  state: ClaudeProjectState;
}

export type ClaudeConnectionAdviceTone = 'error' | 'info' | 'success' | 'warning';

export type ClaudeConnectionAdviceAction =
  | 'install-router'
  | 'import-curl'
  | 'open-router-management'
  | 'save-config'
  | 'start-router'
  | 'stop-router'
  | 'switch-to-direct'
  | 'switch-to-router'
  | 'test-connection';

export interface ClaudeConnectionAdvice {
  actions: ClaudeConnectionAdviceAction[];
  detail: string;
  /** When true the renderer greys out every Router control: this project does not need it. */
  routerNeeded: boolean;
  routerRunningButUnused: boolean;
  title: string;
  tone: ClaudeConnectionAdviceTone;
}

export interface ClaudePermissionSuggestionView {
  id: string;
  label: string;
}

export interface ClaudePermissionRequestView {
  description: string;
  expiresAt: number;
  requestId: string;
  sessionId: string;
  suggestions: ClaudePermissionSuggestionView[];
  toolName: string;
}

export type ClaudePermissionDecision =
  | { behavior: 'allow'; suggestionId?: string }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'fallback' };

export interface ClaudeSessionDeleteResult extends WorkspaceResult {
  deleted: boolean;
}
