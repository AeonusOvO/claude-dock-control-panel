import type { TerminalThemeId } from './terminal-themes';
import type { ClaudeProviderId } from './claude-providers';
import type {
  ConversationInteractionResponse,
  ConversationControlUpdate,
  ConversationSnapshot,
  ConversationSubmitInput,
  NativeAttachmentBytesInput,
  NativeAttachmentImportResult,
  NativeAttachmentView,
  NativeConversationDraftResult,
  NativeConversationLaunchRequest,
  NativeConversationOperationResult,
  NativeConversationStartResult,
  NativeConversationTerminalTransferResult,
  NativeRecoveryView,
} from './native-conversation';

export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';
export type DevelopmentRuntime = 'claude' | 'codex';
export type ClaudeAuthMode = 'apiKey' | 'authToken' | 'existing' | 'none';
export type ClaudeApiKeyHelperPolicy = 'inherit' | 'prefer-claudedock';
export type ClaudeCredentialAction = 'clear' | 'keep' | 'replace';
export type ClaudeLaunchMode = 'continue' | 'new' | 'resume';
export type CodexLaunchMode = ClaudeLaunchMode;
export type CodexLoginMethod = 'browser' | 'device-code';
export type CloseBehavior = 'exit' | 'tray';
export type BusyKind =
  'configure' | 'conversation' | 'download' | 'install' | 'proxy' | 'uninstall';
export type BusySeverity = 'blocking' | 'resumable';
export interface BusyLease {
  readonly action?:
    'configure' | 'disable' | 'enable' | 'install' | 'refresh' | 'remove' | 'uninstall' | 'update';
  readonly cancellable: boolean;
  readonly domain?:
    'claude-code' | 'conversation' | 'gateway' | 'mcp' | 'plugin' | 'router' | 'system';
  readonly id: string;
  readonly kind: BusyKind;
  readonly label: string;
  readonly logTail?: string[];
  readonly queuePosition?: number;
  readonly queueTotal?: number;
  readonly severity: BusySeverity;
  readonly stage?: string;
  readonly startedAt?: number;
  readonly target?: string;
}
export interface AppQuitRequest {
  hasBlocking: boolean;
  leases: BusyLease[];
  /** Cleanup could not prove that every verified PTY descendant stopped; only retry/force are safe. */
  runtimeCleanupFailed?: boolean;
}

export type AppQuitDecision = boolean | 'retry';
export type DownloadTaskState =
  'cancelled' | 'completed' | 'failed' | 'paused' | 'progressing' | 'queued' | 'verifying';
export interface DownloadTaskView {
  bytesPerSecond: number;
  canPause: boolean;
  canResume: boolean;
  elapsedMs: number;
  errorMessage?: string;
  finishedAt?: number;
  id: string;
  label: string;
  percent: number;
  receivedBytes: number;
  remainingMs: number;
  startedAt?: number;
  state: DownloadTaskState;
  totalBytes: number;
}
/**
 * A user-owned proxy that already exists outside ClaudeDock, such as an organisation-managed
 * gateway. ClaudeDock only passes the address to selected application processes and never edits
 * Windows proxy settings.
 */
export type ApplicationProxyProtocol = 'http' | 'socks5';
export interface ApplicationProxyScope {
  application: boolean;
  cli: boolean;
  conversation: boolean;
}
export interface ApplicationProxyView {
  enabled: boolean;
  host: string;
  passwordConfigured: boolean;
  port?: number;
  protocol: ApplicationProxyProtocol;
  scope: ApplicationProxyScope;
  updatedAt?: number;
  username: string;
}
export interface SaveApplicationProxyInput {
  enabled: boolean;
  host: string;
  /** Empty keeps the existing encrypted password; clearing username clears both credentials. */
  password?: string;
  port?: number;
  protocol: ApplicationProxyProtocol;
  scope: ApplicationProxyScope;
  username?: string;
}
export interface ApplicationProxyTestResult {
  checkedAt: number;
  latencyMs?: number;
  message: string;
  ok: boolean;
}
export interface ApplicationProxyState {
  config: ApplicationProxyView;
  test?: ApplicationProxyTestResult;
}
export interface ApplicationProxyCandidate {
  host: string;
  label: string;
  port: number;
  protocol: ApplicationProxyProtocol;
}
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
export type ClaudeRouterGatewayState = 'error' | 'running' | 'starting' | 'stopped' | 'unknown';
export type ClaudeRouterInstallationKind = 'desktop' | 'mixed' | 'npm' | 'unknown';
/** ClaudeDock only manages the CCR command-line package; desktop installers are out of scope. */
export type ClaudeRouterInstallSource = 'npm' | 'npmmirror';
export type ClaudeCodeInstallationKind = 'native' | 'npm' | 'unknown';
export type ClaudeRouterProviderProtocol =
  'anthropic_messages' | 'openai_chat_completions' | 'openai_responses';
export type ChatProtocol = 'anthropic' | 'openai';
export type ChatAuthMode = 'apiKey' | 'bearer' | 'none';
export type ChatIdleTimeoutMinutes = 0 | 5 | 10 | 30;
export type ChatMessageRole = 'assistant' | 'system' | 'user';
export type ChatStreamEventType =
  | 'aborted'
  | 'delta'
  | 'done'
  | 'error'
  | 'idle'
  | 'input-json'
  | 'refusal'
  | 'retrying'
  | 'start'
  | 'thinking';
export type ChatRetryReason = 'http-status' | 'network' | 'stream-incomplete';
export type ChatTokenUsageSource = 'estimated' | 'provider';
export type NetworkProviderId = 'anthropic-claude' | 'openai-api' | 'openai-codex';
export type NetworkPreflightAction =
  'background' | 'cli-launch' | 'cloud-task' | 'first-request' | 'login' | 'provider-switch';
export type NetworkPreflightStatus =
  | 'allowed'
  | 'allowed_with_notice'
  | 'blocked'
  | 'degraded'
  | 'partially_available'
  | 'testing'
  | 'unknown'
  | 'warning';
export type NetworkProbeStatus = 'failed' | 'passed' | 'skipped' | 'unknown' | 'warning';
export type NetworkProcessKind =
  'application' | 'claude-cli' | 'codex-cli' | 'oauth-browser' | 'renderer' | 'terminal';

export interface NetworkPathView {
  detail: string;
  dnsServers: string[];
  globalIpv6Available: boolean;
  ipv4Available: boolean;
  ipv6Available: boolean;
  process: NetworkProcessKind;
  proxyConfigured: boolean;
  proxyKind:
    'application-proxy' | 'direct' | 'environment' | 'pac' | 'socks' | 'system' | 'unknown';
  virtualInterfaces: string[];
}

export interface NetworkProbeResult {
  checkedAt: number;
  detail: string;
  id: string;
  kind: 'api' | 'dns' | 'https' | 'oauth' | 'path' | 'tls' | 'version' | 'websocket';
  label: string;
  process: NetworkProcessKind;
  required: boolean;
  status: NetworkProbeStatus;
  target?: string;
}

export interface NetworkRiskSignal {
  confidence: 'high' | 'low' | 'medium';
  detail: string;
  id: string;
  label: string;
  observedAt: number;
  score: number;
  severity: 'critical' | 'info' | 'notice' | 'warning';
  source: string;
}

export interface NetworkFeatureAccess {
  action: NetworkPreflightAction;
  allowed: boolean;
  reason?: string;
}

export interface NetworkPreflightResult {
  cacheExpiresAt?: number;
  checkedAt?: number;
  featureAccess: NetworkFeatureAccess[];
  paths: NetworkPathView[];
  probes: NetworkProbeResult[];
  provider: NetworkProviderId;
  providerLabel: string;
  reasons: string[];
  riskLevel: 'critical' | 'high' | 'low' | 'medium' | 'unknown';
  riskScore: number;
  signals: NetworkRiskSignal[];
  startedAt: number;
  status: NetworkPreflightStatus;
  summary: string;
}

export interface NetworkPreflightRunInput {
  action: NetworkPreflightAction;
  cwd?: string;
  force?: boolean;
  provider: NetworkProviderId;
}

export interface NetworkPreflightHistoryView {
  entries: NetworkPreflightResult[];
  retentionDays: number;
}

export interface ChatConfigView {
  authMode: ChatAuthMode;
  baseUrl: string;
  credentialConfigured: boolean;
  model: string;
  protocol: ChatProtocol;
}

export interface SaveChatConfigInput {
  authMode: ChatAuthMode;
  baseUrl: string;
  credential?: string;
  credentialAction: ClaudeCredentialAction;
  model: string;
  protocol: ChatProtocol;
}

export type ChatAttachmentSource =
  | { attachmentId: string; type: 'local' }
  | { data: string; type: 'base64' }
  | { fileId: string; type: 'file' };

export type ChatContentBlock =
  | { text: string; type: 'text' }
  | {
      fileName?: string;
      mediaType: string;
      source: ChatAttachmentSource;
      type: 'document' | 'image';
    };

export interface ChatMessage {
  /**
   * Strings are accepted only as the 1.x compatibility/input path. Main-process validation
   * normalizes every newly persisted or transmitted message to content blocks.
   */
  content: ChatContentBlock[] | string;
  role: ChatMessageRole;
}

export interface ChatAttachmentView {
  attachmentId: string;
  fileName: string;
  mediaType: string;
  /** Small renderer-safe image preview. Full attachment bytes never cross IPC. */
  previewDataUrl?: string;
  sizeBytes: number;
  type: 'document' | 'image';
}

export interface ChatAttachmentImportError {
  message: string;
  path: string;
}

export interface ChatAttachmentImportResult {
  attachments: ChatAttachmentView[];
  draftId?: string;
  errors: ChatAttachmentImportError[];
  ok: boolean;
}

export interface ChatAttachmentImportInput {
  draftId?: string;
  paths: string[];
}

/** One clipboard payload. Pasted images arrive as bytes with no path on disk. */
export interface ChatAttachmentBytesInput {
  bytes: ArrayBuffer;
  fileName: string;
}

export interface ChatAttachmentBytesImportInput {
  draftId?: string;
  sources: ChatAttachmentBytesInput[];
}

export interface ChatTokenUsage {
  inputTokens: number;
  outputTokens: number;
  source: ChatTokenUsageSource;
  totalTokens: number;
}

export interface ChatStartInput {
  draftId?: string;
  messages: ChatMessage[];
  requestId: string;
}

export interface ChatPreflightResult {
  messages: ChatMessage[];
  removedAttachmentIds: string[];
  warning?: string;
}

export interface ChatStreamEvent {
  abortReason?: 'local-timeout' | 'manual';
  attempt?: number;
  continuable?: boolean;
  delta?: string;
  detail?: string;
  error?: string;
  idleMs?: number;
  maxAttempts?: number;
  probe?: ChatIdleProbeResult;
  refusal?: string;
  requestId: string;
  retryAfterMs?: number;
  retryReason?: ChatRetryReason;
  stopReason?: string;
  status?: number;
  type: ChatStreamEventType;
  usage?: ChatTokenUsage;
}

export interface ChatIdleProbeResult {
  detail: string;
  ok?: boolean;
}

export interface ArtifactNetworkLogEntry {
  artifactId: string;
  blocked: boolean;
  completedAt?: number;
  error?: string;
  id: string;
  method: string;
  /** Best-effort Content-Length; absent when Chromium cannot report a reliable size. */
  responseBytes?: number;
  startedAt: number;
  status?: number;
  url: string;
}

export interface ArtifactNetworkState {
  allowed: boolean;
  entries: ArtifactNetworkLogEntry[];
}

export interface ArtifactCreateResult {
  artifactId: string;
  url: string;
}

export interface ChatConversationSummary {
  createdAt: number;
  id: string;
  messageCount: number;
  title: string;
  /** True once the user renamed the conversation, which stops the derived title from overwriting it. */
  titleCustom?: boolean;
  updatedAt: number;
  usage: ChatTokenUsage;
}

export interface ChatConversation extends ChatConversationSummary {
  messages: ChatMessage[];
}

export interface SaveChatConversationInput {
  conversationId?: string;
  messages: ChatMessage[];
  usage: ChatTokenUsage;
}

export interface ChatConnectionTestResult {
  detail: string;
  latencyMs: number;
  ok: boolean;
  usage?: ChatTokenUsage;
}

/**
 * Opt-in workarounds for relay-side protocol quirks. Every switch is off by default: a relay that
 * behaves correctly must not carry the cost of a fix it does not need.
 */
export interface AdvancedSettings {
  /** Zero leaves slow conversations running until the user stops them. */
  chatIdleTimeoutMinutes: ChatIdleTimeoutMinutes;
  /**
   * Routes WebSearch and WebFetch through a dedicated subagent instead of the main conversation.
   * Turn this on when the relay refuses web search once the model is raised to high effort.
   */
  webResearchIsolation: boolean;
}

export type FooterResourcePreference = 'auto' | 'context' | 'quota';
export type ManagedChatGptContextWindowMode = 'extended' | 'standard';
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

export interface AppSettingsView {
  advanced: AdvancedSettings;
  artifactNetworkAllowed?: boolean;
  closeBehavior: CloseBehavior;
  footerResourcePreference: FooterResourcePreference;
  managedChatGptContextWindowMode: ManagedChatGptContextWindowMode;
  language: 'zh-CN';
  launchAtLogin: boolean;
  theme: TerminalThemeId;
  version: string;
  /** Windows kernel build passed to xterm's ConPTY compatibility layer. */
  windowsBuildNumber?: number;
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
 * A previously saved connection setup, replayable in one click. The credential itself never leaves
 * the main process — the renderer only learns whether one is attached.
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

export interface ClaudeConnectionHistoryResult {
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

export interface DevelopmentRuntimeState {
  cwd: string;
  runtime: DevelopmentRuntime;
  sessionId: string;
}

export interface CodexInstallationStatus {
  executable?: string;
  installed: boolean;
  latestVersion?: string;
  message: string;
  updateAvailable: boolean;
  version?: string;
}

export interface CodexAccountView {
  email?: string;
  planType?: string;
  type: 'apiKey' | 'chatgpt' | 'other';
}

export interface CodexRateLimitWindow {
  resetsAt?: number;
  usedPercent: number;
  windowDurationMins?: number;
}

export interface CodexRateLimitsView {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

export type ResourceAvailability = 'available' | 'stale' | 'unavailable';
export type ResourceUsageSource =
  | 'claude-statusline'
  | 'codex-app-server'
  | 'deepseek-balance'
  | 'openrouter-key'
  | 'managed-chatgpt-gateway';

export interface ResourceCapabilities {
  balance: boolean;
  context: boolean;
  windows: boolean;
}

export interface ResourceWindow {
  label: string;
  resetsAt?: number;
  usedPercent?: number;
  windowDurationMins?: number;
}

export interface ResourceBalanceEntry {
  amount: number;
  currency: string;
}

export interface ResourceBalance {
  balances?: ResourceBalanceEntry[];
  limit?: number;
  unlimited?: boolean;
  used?: number;
}

export interface ResourceUsageView {
  availability: ResourceAvailability;
  autoCompactAtTokens?: number;
  balance?: ResourceBalance;
  capabilities: ResourceCapabilities;
  checkedAt: number;
  contextUsedPercent?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  detail?: string;
  source: ResourceUsageSource;
  staleAt?: number;
  windows?: ResourceWindow[];
}

export interface CodexLoginView {
  error?: string;
  loginId?: string;
  method?: CodexLoginMethod;
  phase: 'error' | 'idle' | 'starting' | 'waiting';
  userCode?: string;
  verificationUrl?: string;
}

export interface CodexProjectState {
  account?: CodexAccountView;
  active: boolean;
  cwd: string;
  installation: CodexInstallationStatus;
  login: CodexLoginView;
  operationMessage?: string;
  rateLimits?: CodexRateLimitsView;
  resourceUsage?: ResourceUsageView;
  requiresOpenaiAuth: boolean;
  sessionId: string;
  warning?: string;
}

export interface CodexOperationResult {
  error?: string;
  ok: boolean;
  state: CodexProjectState;
}

export interface CodexLoginStartResult extends CodexOperationResult {
  openedBrowser?: boolean;
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

export interface ClaudeConfigResult {
  error?: string;
  ok: boolean;
  state: ClaudeProjectState;
}

export interface ClaudeOperationResult {
  error?: string;
  ok: boolean;
  state: ClaudeProjectState;
}

export interface ClaudeConnectionTestStage {
  detail: string;
  id: 'authentication' | 'endpoint' | 'model';
  label: string;
  status: 'failed' | 'passed' | 'skipped' | 'warning';
}

export interface ClaudeConnectionTestResult {
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

export type ManagedChatGptGatewayPhase =
  'installing' | 'login-required' | 'not-installed' | 'ready' | 'stopped';

/**
 * Public state for the ClaudeDock-owned CLIProxyAPI sidecar. OAuth files and the generated local
 * access key never cross the main/renderer boundary.
 */
export interface ManagedChatGptGatewayState {
  availableModels: string[];
  authenticated: boolean;
  busy: boolean;
  checkedAt: number;
  endpoint: string;
  installed: boolean;
  managementAvailable: boolean;
  message: string;
  phase: ManagedChatGptGatewayPhase;
  running: boolean;
  usageStatisticsEnabled: false;
  version?: string;
}

export interface ManagedChatGptGatewayOperationResult {
  connectionTest?: ClaudeConnectionTestResult;
  error?: string;
  message: string;
  ok: boolean;
  projectState?: ClaudeProjectState;
  state: ManagedChatGptGatewayState;
}

export type ManagedChatGptSetupStage =
  | 'complete'
  | 'detecting'
  | 'discovering-models'
  | 'error'
  | 'installing-claude'
  | 'installing-gateway'
  | 'logging-in'
  | 'saving'
  | 'testing';

export interface ManagedChatGptSetupProgress {
  active: boolean;
  detail: string;
  sessionId: string;
  stage: ManagedChatGptSetupStage;
  step: number;
  totalSteps: number;
}

export interface ClaudeProviderModelDiscoveryInput {
  baseUrl: string;
  credential?: string;
}

export interface ClaudeProviderModelDiscoveryResult {
  error?: string;
  message: string;
  models: string[];
  ok: boolean;
}

export interface ClaudeRouterProviderView {
  baseUrl: string;
  credentialConfigured: boolean;
  id: string;
  models: string[];
  name: string;
  preferred: boolean;
  protocol: ClaudeRouterProviderProtocol;
}

export interface ClaudeRouterManagementState {
  canUninstall: boolean;
  checkedAt: number;
  endpoint: string;
  gatewayState: ClaudeRouterGatewayState;
  installed: boolean;
  installationKind: ClaudeRouterInstallationKind;
  manageable: boolean;
  managementAvailable: boolean;
  message: string;
  providers: ClaudeRouterProviderView[];
  runtimeMismatch?: boolean;
  serviceRunning: boolean;
  version?: string;
}

export type RouterOperationKind = 'configure' | 'install' | 'recover' | 'start' | 'stop';

export type RouterOperationStage =
  | 'checking'
  | 'complete'
  | 'configuring'
  | 'downloading'
  | 'error'
  | 'installing'
  | 'recovering'
  | 'starting'
  | 'stopping'
  | 'verifying';

/** A secret-free, main-process-authored snapshot of a long-running router operation. */
export interface RouterOperationProgress {
  active: boolean;
  detail: string;
  operation: RouterOperationKind;
  stage: RouterOperationStage;
  step: number;
  totalSteps: number;
  updatedAt: number;
}

export type RouterKernelId = 'cc-switch' | 'ccr' | 'none';

export interface CcSwitchInstallationState {
  checkedAt: number;
  executable?: string;
  installed: boolean;
  message: string;
  protocolRegistered: boolean;
  residuals: string[];
  running: boolean;
  uninstallable: boolean;
  version?: string;
}

export interface RouterKernelState {
  active: RouterKernelId;
  ccSwitch: CcSwitchInstallationState;
  checkedAt: number;
  conflict: boolean;
  ccr: ClaudeRouterManagementState;
}

export interface RouterKernelOperationResult {
  error?: string;
  message: string;
  ok: boolean;
  state: RouterKernelState;
}

export interface SaveClaudeRouterProviderInput {
  apiKey?: string;
  baseUrl: string;
  credentialAction: 'clear' | 'keep' | 'replace';
  id?: string;
  makePreferred: boolean;
  models: string[];
  name: string;
  protocol: ClaudeRouterProviderProtocol;
  useForCurrentProject: boolean;
}

export interface ClaudeRouterOperationResult {
  error?: string;
  message: string;
  ok: boolean;
  projectState?: ClaudeProjectState;
  provider?: ClaudeRouterProviderView;
  routerState: ClaudeRouterManagementState;
}

export type PtyGeneration = number;

export interface TerminalStatus {
  cwd: string;
  diagnosticCode?:
    | 'CWD_UNAVAILABLE'
    | 'NATIVE_BACKEND_UNAVAILABLE'
    | 'POWERSHELL_UNAVAILABLE'
    | 'PTY_START_FAILED';
  id: string;
  message?: string;
  phase: TerminalPhase;
  pid?: number;
  ptyGeneration: PtyGeneration;
  shell: string;
  title: string;
}

export interface WorkspaceProject {
  addedAt: number;
  lastActiveAt: number;
  path: string;
}

/** Shape owned by TerminalWorkspace; it knows nothing about persisted projects. */
export interface TerminalWorkspaceState {
  activeSessionId: string;
  sessions: TerminalStatus[];
}

/** A project folder: either currently open (has live conversations) or only remembered. */
export interface WorkspaceProjectView {
  lastActiveAt?: number;
  missing: boolean;
  name: string;
  open: boolean;
  path: string;
  remembered: boolean;
  sessionIds: string[];
}

export interface WorkspaceState extends TerminalWorkspaceState {
  projects: WorkspaceProjectView[];
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

export type ClaudePluginScope = 'local' | 'project' | 'user';

export interface ClaudePluginView {
  description: string;
  enabled: boolean;
  installCount?: number;
  installed: boolean;
  latestVersion?: string;
  marketplaceName: string;
  name: string;
  pluginId: string;
  scope?: ClaudePluginScope;
  sourceLabel: string;
  sourceRevision?: string;
  latestSourceRevision?: string;
  updateAvailable: boolean;
  version?: string;
}

export interface ClaudePluginMarketplaceView {
  installLocation?: string;
  name: string;
  repo?: string;
  source: string;
}

export interface ClaudePluginCatalog {
  available: ClaudePluginView[];
  checkedAt: number;
  cliAvailable: boolean;
  installed: ClaudePluginView[];
  marketplaces: ClaudePluginMarketplaceView[];
  message: string;
  updatesAvailable: number;
}

export interface ClaudePluginOperationResult {
  catalog: ClaudePluginCatalog;
  error?: string;
  message: string;
  ok: boolean;
}

export type McpHealth = 'connected' | 'disabled' | 'failed' | 'unknown';
export type McpScope = 'local' | 'project' | 'user';
export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServerView {
  client: 'claude' | 'codex';
  configPath: string;
  enabled: boolean;
  health: McpHealth;
  healthDetail?: string;
  name: string;
  scope: McpScope;
  toggleSupported: boolean;
  transport: McpTransport;
}

export interface McpCatalogEntry {
  config: Record<string, unknown>;
  description: string;
  featured: boolean;
  id: string;
  name: string;
  officialUrl?: string;
  requiresCredential: boolean;
  transport: McpTransport;
}

export interface McpCatalog {
  available: McpCatalogEntry[];
  checkedAt: number;
  installed: McpServerView[];
  message: string;
  registryAvailable: boolean;
}

export interface McpBackupView {
  createdAt: number;
  id: string;
  path: string;
}

export interface McpInstallInput {
  catalogId: string;
  cwd: string;
  scope: McpScope;
}

export interface McpRemoveInput {
  cwd: string;
  name: string;
  scope: McpScope;
}

export interface McpTogglePreview {
  after: string;
  before: string;
  enabled: boolean;
  id: string;
  name: string;
  targetPath: string;
}

export interface McpOperationResult {
  catalog: McpCatalog;
  error?: string;
  message: string;
  ok: boolean;
}

export interface SoftwareUpdateTarget {
  currentVersion?: string;
  installed: boolean;
  latestVersion?: string;
  message: string;
  updateAvailable: boolean;
}

export interface SoftwareUpdateState {
  application: SoftwareUpdateTarget;
  checkedAt: number;
  claudeCode: SoftwareUpdateTarget;
  router: SoftwareUpdateTarget;
}

export interface SoftwareUpdateOperationResult {
  error?: string;
  message: string;
  ok: boolean;
  state: SoftwareUpdateState;
}

export type ApplicationUpdaterPhase =
  | 'available'
  | 'checking'
  | 'disabled'
  | 'downloaded'
  | 'downloading'
  | 'error'
  | 'idle'
  | 'up-to-date';

export interface ApplicationUpdaterState {
  bytesPerSecond?: number;
  currentVersion: string;
  downloadedBytes?: number;
  latestVersion?: string;
  message: string;
  percent?: number;
  phase: ApplicationUpdaterPhase;
  sourceId?: string;
  sourceLabel?: string;
  sourceThroughputBps?: number;
  totalBytes?: number;
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

export interface OperationResult {
  error?: string;
  message?: string;
  ok: boolean;
  /** Absent when the workspace has no conversation to report on — e.g. before a project is opened. */
  status?: TerminalStatus;
}

export type RuntimeActivityPhase =
  'stopped' | 'cli-idle' | 'foreground-running' | 'waiting-background' | 'resuming' | 'failed';
export type RuntimeTaskKind =
  'subagent' | 'shell' | 'monitor' | 'workflow' | 'teammate' | 'mcp' | 'cron' | 'web';
export type RuntimeTaskStatus =
  'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'orphaned';
export type RuntimeTriState = boolean | 'unknown';

export interface RuntimeTaskView {
  agentType?: string;
  description: string;
  id: string;
  kind: RuntimeTaskKind;
  status: RuntimeTaskStatus;
  tokenUse: 'likely' | 'none' | 'unknown';
  updatedAt: number;
  willWakeParent: RuntimeTriState;
}

export interface RuntimeWebProcessView {
  commandSummary: string;
  exposureWarning?: string;
  name: string;
  pid: number;
  ports: number[];
  processKey: string;
  startedAt: number;
  status: 'running' | 'stopping';
  urls: Array<{ confirmed: boolean; url: string }>;
}

export interface RuntimeActivitySnapshot {
  launchGeneration: number;
  observedAt: number;
  phase: RuntimeActivityPhase;
  ptyGeneration: PtyGeneration;
  sessionId: string;
  subagentCount: number;
  tasks: RuntimeTaskView[];
  webProcesses: RuntimeWebProcessView[];
  willResumeConversation: RuntimeTriState;
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

export interface WorkspaceResult {
  error?: string;
  ok: boolean;
  reused?: boolean;
  state: WorkspaceState;
}

export interface ClaudeSessionDeleteResult extends WorkspaceResult {
  deleted: boolean;
}

export type DirectoryChoiceResult =
  | {
      canceled: true;
      error?: string;
    }
  | {
      canceled: false;
      path: string;
    };

export type Unsubscribe = () => void;

export interface ControlPanelApi {
  startNativeConversation: (
    input: NativeConversationLaunchRequest,
  ) => Promise<NativeConversationStartResult>;
  getNativeConversation: (conversationId: string) => Promise<ConversationSnapshot | undefined>;
  submitNativeConversation: (
    conversationId: string,
    input: ConversationSubmitInput,
  ) => Promise<NativeConversationOperationResult>;
  respondNativeConversation: (
    conversationId: string,
    interactionId: string,
    response: ConversationInteractionResponse,
  ) => Promise<NativeConversationOperationResult>;
  interruptNativeConversation: (
    conversationId: string,
  ) => Promise<NativeConversationOperationResult>;
  stopNativeConversationTask: (
    conversationId: string,
    taskId: string,
  ) => Promise<NativeConversationOperationResult>;
  updateNativeConversationControls: (
    conversationId: string,
    update: ConversationControlUpdate,
  ) => Promise<NativeConversationOperationResult>;
  closeNativeConversation: (conversationId: string) => Promise<NativeConversationOperationResult>;
  renameNativeConversation: (conversationId: string, title: string) => Promise<boolean>;
  transferNativeConversationToTerminal: (
    conversationId: string,
    draft?: ConversationSubmitInput,
  ) => Promise<NativeConversationTerminalTransferResult>;
  listNativeRecoveries: () => Promise<NativeRecoveryView[]>;
  restoreNativeDraft: (
    conversationId: string,
    clientSubmissionId: string,
    projectPath: string,
  ) => Promise<NativeConversationDraftResult>;
  discardNativeRecovery: (conversationId: string, projectPath: string) => Promise<boolean>;
  onNativeConversation: (listener: (snapshot: ConversationSnapshot) => void) => Unsubscribe;
  onConversationOwnerConflict: (
    listener: (conflict: {
      conversationId: string;
      existingOwnerKind: 'native' | 'terminal';
      existingSessionId?: string;
      sessionId: string;
    }) => void,
  ) => Unsubscribe;
  importNativeAttachmentPaths: (
    conversationId: string,
    paths: string[],
  ) => Promise<NativeAttachmentImportResult>;
  importNativeAttachmentBytes: (
    conversationId: string,
    sources: NativeAttachmentBytesInput[],
  ) => Promise<NativeAttachmentImportResult>;
  importNativeClipboardImage: (conversationId: string) => Promise<NativeAttachmentImportResult>;
  readNativeAttachment: (
    conversationId: string,
    attachmentId: string,
  ) => Promise<NativeAttachmentView | undefined>;
  removeNativeAttachment: (conversationId: string, attachmentId: string) => Promise<boolean>;
  getAppSettings: () => Promise<AppSettingsView>;
  setLaunchAtLogin: (enabled: boolean) => Promise<AppSettingsView>;
  setFooterResourcePreference: (preference: FooterResourcePreference) => Promise<AppSettingsView>;
  setManagedChatGptContextWindowMode: (
    mode: ManagedChatGptContextWindowMode,
  ) => Promise<AppSettingsView>;
  setAdvancedSettings: (settings: AdvancedSettings) => Promise<AppSettingsView>;
  setCloseBehavior: (behavior: CloseBehavior) => Promise<AppSettingsView>;
  listBusyLeases: () => Promise<BusyLease[]>;
  onBusyChanged: (listener: (leases: BusyLease[]) => void) => Unsubscribe;
  setConversationBusy: (busy: boolean) => Promise<BusyLease[]>;
  getRuntimeActivity: (sessionId: string) => Promise<RuntimeActivitySnapshot>;
  onRuntimeActivityChanged: (listener: (state: RuntimeActivitySnapshot) => void) => Unsubscribe;
  onClaudePermissionRequest: (
    listener: (request: ClaudePermissionRequestView) => void,
  ) => Unsubscribe;
  respondClaudePermission: (
    requestId: string,
    decision: ClaudePermissionDecision,
  ) => Promise<boolean>;
  terminateRuntimeProcess: (
    sessionId: string,
    processKey: string,
  ) => Promise<RuntimeActivitySnapshot>;
  cancelDownload: (taskId: string) => Promise<DownloadTaskView>;
  clearDownloadHistory: () => Promise<DownloadTaskView[]>;
  deleteDownloadHistory: (taskId: string) => Promise<DownloadTaskView[]>;
  listDownloads: () => Promise<DownloadTaskView[]>;
  onDownloadsChanged: (listener: (tasks: DownloadTaskView[]) => void) => Unsubscribe;
  pauseDownload: (taskId: string) => Promise<DownloadTaskView>;
  resumeDownload: (taskId: string) => Promise<DownloadTaskView>;
  getApplicationProxyState: () => Promise<ApplicationProxyState>;
  saveApplicationProxy: (input: SaveApplicationProxyInput) => Promise<ApplicationProxyState>;
  testApplicationProxy: () => Promise<ApplicationProxyState>;
  detectApplicationProxyCandidates: () => Promise<ApplicationProxyCandidate[]>;
  onApplicationProxyChanged: (listener: (state: ApplicationProxyState) => void) => Unsubscribe;
  createArtifact: (html: string) => Promise<ArtifactCreateResult>;
  destroyArtifact: (artifactId: string) => Promise<boolean>;
  getArtifactNetworkState: () => Promise<ArtifactNetworkState>;
  setArtifactNetworkAllowed: (allowed: boolean) => Promise<ArtifactNetworkState>;
  onArtifactNetworkLog: (listener: (entry: ArtifactNetworkLogEntry) => void) => Unsubscribe;
  getChatConfig: () => Promise<ChatConfigView>;
  saveChatConfig: (input: SaveChatConfigInput) => Promise<ChatConfigView>;
  testChatConnection: (input: SaveChatConfigInput) => Promise<ChatConnectionTestResult>;
  importChatAttachments: (input: ChatAttachmentImportInput) => Promise<ChatAttachmentImportResult>;
  importChatAttachmentBytes: (
    input: ChatAttachmentBytesImportInput,
  ) => Promise<ChatAttachmentImportResult>;
  importChatClipboardImage: (draftId?: string) => Promise<ChatAttachmentImportResult>;
  readChatAttachment: (attachmentId: string) => Promise<ChatAttachmentView | undefined>;
  deleteChatDraftAttachment: (draftId: string, attachmentId: string) => Promise<boolean>;
  releaseChatAttachmentDraft: (draftId: string) => Promise<number>;
  getChatConversations: () => Promise<ChatConversationSummary[]>;
  getChatConversation: (conversationId: string) => Promise<ChatConversation | undefined>;
  saveChatConversation: (input: SaveChatConversationInput) => Promise<ChatConversation>;
  renameChatConversation: (
    conversationId: string,
    title: string,
  ) => Promise<ChatConversation | undefined>;
  deleteChatConversation: (conversationId: string) => Promise<boolean>;
  preflightChat: (input: ChatStartInput) => Promise<ChatPreflightResult>;
  startChat: (input: ChatStartInput) => Promise<ChatPreflightResult>;
  stopChat: (requestId: string) => Promise<void>;
  onChatStream: (listener: (event: ChatStreamEvent) => void) => Unsubscribe;
  getNetworkPreflight: (provider: NetworkProviderId) => Promise<NetworkPreflightResult>;
  runNetworkPreflight: (input: NetworkPreflightRunInput) => Promise<NetworkPreflightResult>;
  invalidateNetworkPreflight: (reason: string) => Promise<void>;
  getNetworkPreflightHistory: () => Promise<NetworkPreflightHistoryView>;
  clearNetworkPreflightHistory: () => Promise<NetworkPreflightHistoryView>;
  onNetworkPreflight: (listener: (result: NetworkPreflightResult) => void) => Unsubscribe;
  openMarkdownExternal: (url: string) => Promise<boolean>;
  activateProject: (sessionId: string) => Promise<WorkspaceResult>;
  addProject: (directoryPath: string) => Promise<WorkspaceResult>;
  chooseDirectory: () => Promise<DirectoryChoiceResult>;
  closeProject: (sessionId: string) => Promise<WorkspaceResult>;
  /** Close every live conversation of a folder but keep the folder remembered. */
  closeProjectFolder: (projectPath: string) => Promise<WorkspaceResult>;
  /** Open one more concurrent conversation inside an already-open folder. */
  openConversation: (projectPath: string) => Promise<WorkspaceResult>;
  /** Open a remembered folder's history entry as a live conversation. */
  openStoredConversation: (projectPath: string, conversationId: string) => Promise<WorkspaceResult>;
  renameConversation: (sessionId: string, title: string) => Promise<WorkspaceResult>;
  /** Forget a folder entirely: closes its conversations and drops it from disk. */
  forgetProject: (projectPath: string) => Promise<WorkspaceResult>;
  getClaudeProjectState: (sessionId: string) => Promise<ClaudeProjectState>;
  getClaudeGatewayDiagnostics: (sessionId: string) => Promise<ClaudeGatewayDiagnostics>;
  getClaudeRouterManagementState: (sessionId: string) => Promise<ClaudeRouterManagementState>;
  getClaudeConnectionAdvice: (sessionId: string) => Promise<ClaudeConnectionAdvice>;
  getClaudeConnectionHistory: (sessionId: string) => Promise<ClaudeConnectionHistoryEntry[]>;
  getClaudeModelOptions: (sessionId: string) => Promise<ClaudeModelOptions>;
  /** Switches inside the live conversation with `/model`; only valid for same-endpoint options. */
  switchClaudeModel: (sessionId: string, optionId: string) => Promise<ClaudeOperationResult>;
  /**
   * Relaunches the PTY so a new base URL, credential or permission mode takes effect, then
   * reattaches the same conversation with `--continue`.
   */
  relaunchClaudeSession: (
    sessionId: string,
    input: ClaudeRelaunchInput,
  ) => Promise<ClaudeOperationResult>;
  /** Walks the Shift+Tab cycle until the live badge reports the requested mode. */
  setClaudePermissionMode: (
    sessionId: string,
    mode: ClaudePermissionMode,
  ) => Promise<ClaudeOperationResult>;
  /** Applies a reasoning effort level to the live conversation with `/effort`. */
  setClaudeEffortLevel: (
    sessionId: string,
    effort: ClaudeEffortRequest,
  ) => Promise<ClaudeOperationResult>;
  /** Persists a per-model serving-speed preference and relaunches the exact live conversation if needed. */
  setClaudeModelSpeed: (sessionId: string, mode: ModelSpeedMode) => Promise<ClaudeOperationResult>;
  /** Reports the complete mode badge after xterm has applied PTY screen-delta output. */
  observeClaudePermissionMode: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    mode: ClaudePermissionMode,
  ) => void;
  /** Answers a main-process probe with the mode currently visible in xterm's complete screen. */
  reportClaudePermissionModeProbe: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    probeId: number,
    mode?: ClaudePermissionMode,
  ) => void;
  /** Receives an on-demand request to read the current xterm screen, even if no new PTY data arrived. */
  onClaudePermissionModeProbe: (
    listener: (sessionId: string, ptyGeneration: PtyGeneration, probeId: number) => void,
  ) => Unsubscribe;
  setClaudeAllowBypassPermissions: (
    sessionId: string,
    allowed: boolean,
  ) => Promise<ClaudeOperationResult>;
  applyClaudeConnectionHistory: (
    sessionId: string,
    entryId: string,
  ) => Promise<ClaudeConnectionHistoryResult>;
  deleteClaudeConnectionHistory: (
    sessionId: string,
    entryId: string,
  ) => Promise<ClaudeConnectionHistoryResult>;
  renameClaudeConnectionHistory: (
    sessionId: string,
    entryId: string,
    name: string,
  ) => Promise<ClaudeConnectionHistoryResult>;
  getDroppedPath: (file: File) => string;
  getWorkspace: () => Promise<WorkspaceState>;
  getDevelopmentRuntime: (sessionId: string) => Promise<DevelopmentRuntimeState>;
  setDevelopmentRuntime: (
    sessionId: string,
    runtime: DevelopmentRuntime,
  ) => Promise<DevelopmentRuntimeState>;
  getCodexProjectState: (sessionId: string) => Promise<CodexProjectState>;
  installOrUpdateCodex: (sessionId: string) => Promise<CodexOperationResult>;
  startCodexLogin: (sessionId: string, method: CodexLoginMethod) => Promise<CodexLoginStartResult>;
  cancelCodexLogin: (sessionId: string) => Promise<CodexOperationResult>;
  logoutCodex: (sessionId: string) => Promise<CodexOperationResult>;
  launchCodex: (sessionId: string, mode: CodexLaunchMode) => Promise<CodexOperationResult>;
  onCodexState: (listener: (state: CodexProjectState) => void) => Unsubscribe;
  deleteClaudeRouterProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<ClaudeRouterOperationResult>;
  installClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  installClaudeRouterFromSource: (
    sessionId: string,
    source: ClaudeRouterInstallSource,
  ) => Promise<ClaudeRouterOperationResult>;
  uninstallClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  getRouterKernelState: (sessionId: string) => Promise<RouterKernelState>;
  getManagedChatGptGatewayState: () => Promise<ManagedChatGptGatewayState>;
  openManagedChatGptGatewayManagement: () => Promise<OperationResult>;
  onManagedChatGptSetupProgress: (
    listener: (progress: ManagedChatGptSetupProgress) => void,
  ) => Unsubscribe;
  onRouterOperationProgress: (listener: (progress: RouterOperationProgress) => void) => Unsubscribe;
  discoverClaudeProviderModels: (
    input: ClaudeProviderModelDiscoveryInput,
  ) => Promise<ClaudeProviderModelDiscoveryResult>;
  setManagedChatGptGatewayModel: (
    sessionId: string,
    model: string,
  ) => Promise<ManagedChatGptGatewayOperationResult>;
  setupManagedChatGptGateway: (
    sessionId: string,
    forceLogin?: boolean,
  ) => Promise<ManagedChatGptGatewayOperationResult>;
  installCcSwitch: (sessionId: string) => Promise<RouterKernelOperationResult>;
  uninstallCcSwitch: (sessionId: string) => Promise<RouterKernelOperationResult>;
  exportCurrentProviderToCcSwitch: (sessionId: string) => Promise<RouterKernelOperationResult>;
  launchClaude: (sessionId: string, mode: ClaudeLaunchMode) => Promise<ClaudeOperationResult>;
  openClaudeRouterManagement: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  /**
   * The main process asks before it quits, so a streaming conversation or a busy terminal can be
   * protected by a themed dialog instead of dying silently. The renderer must answer every request
   * through `confirmQuit`, including the cancelling answer — the quit stays blocked until it does.
   */
  onAppQuitRequested: (listener: (request: AppQuitRequest) => void) => Unsubscribe;
  confirmQuit: (decision: AppQuitDecision) => void;
  minimizeToTray: () => void;
  onOpenDownloadCenterRequested: (listener: () => void) => Unsubscribe;
  onAppWindowRestored: (listener: () => void) => Unsubscribe;
  onClaudeState: (listener: (state: ClaudeProjectState) => void) => Unsubscribe;
  onTerminalData: (
    listener: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => void,
  ) => Unsubscribe;
  /** Application-normalized size echo; resizeRevision prevents an older echo winning a later fit. */
  onTerminalSize: (
    listener: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
      resizeRevision: number,
      cols: number,
      rows: number,
    ) => void,
  ) => Unsubscribe;
  onWorkspaceState: (listener: (state: WorkspaceState) => void) => Unsubscribe;
  resizeTerminal: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    resizeRevision: number,
    cols: number,
    rows: number,
  ) => void;
  restartTerminal: (
    sessionId: string,
    expectedGeneration: PtyGeneration,
  ) => Promise<OperationResult>;
  runClaudeCommand: (
    sessionId: string,
    command: string,
    argument?: string,
  ) => Promise<ClaudeOperationResult>;
  saveClaudeConfig: (
    sessionId: string,
    input: SaveClaudeConfigInput,
  ) => Promise<ClaudeConfigResult>;
  saveClaudeRouterProvider: (
    sessionId: string,
    input: SaveClaudeRouterProviderInput,
  ) => Promise<ClaudeRouterOperationResult>;
  repairClaudeRouterFromProject: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  startClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  stopClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  testClaudeConnection: (
    sessionId: string,
    input: SaveClaudeConfigInput,
  ) => Promise<ClaudeConnectionTestResult>;
  openExternal: (url: string) => Promise<boolean>;
  startTerminal: (sessionId: string, expectedGeneration: PtyGeneration) => Promise<OperationResult>;
  stopTerminal: (sessionId: string, expectedGeneration: PtyGeneration) => Promise<OperationResult>;
  writeTerminal: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => void;
  getStoredProjects: () => Promise<WorkspaceProject[]>;
  removeStoredProject: (projectPath: string) => Promise<void>;
  /** Repaints the native frame and remembers the choice for the next cold start. */
  setAppTheme: (themeId: TerminalThemeId) => Promise<void>;
  getClaudeSessions: (sessionId: string) => Promise<ClaudeSessionMetadata[]>;
  getClaudeSessionsForPath: (projectPath: string) => Promise<ClaudeSessionMetadata[]>;
  renameClaudeSession: (
    projectPath: string,
    conversationId: string,
    title: string,
  ) => Promise<boolean>;
  deleteClaudeSession: (
    projectPath: string,
    conversationId: string,
  ) => Promise<ClaudeSessionDeleteResult>;
  launchClaudeWithSession: (
    sessionId: string,
    conversationId: string,
  ) => Promise<ClaudeOperationResult>;
  getClaudePlugins: (refresh?: boolean) => Promise<ClaudePluginCatalog>;
  installClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  uninstallClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  setClaudePluginEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<ClaudePluginOperationResult>;
  updateClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  addClaudePluginMarketplace: (source: string) => Promise<ClaudePluginOperationResult>;
  removeClaudePluginMarketplace: (name: string) => Promise<ClaudePluginOperationResult>;
  refreshClaudePluginMarketplaces: () => Promise<ClaudePluginOperationResult>;
  updateAllClaudePlugins: () => Promise<ClaudePluginOperationResult>;
  getMcpCatalog: (cwd: string, refresh?: boolean) => Promise<McpCatalog>;
  installMcpServer: (input: McpInstallInput) => Promise<McpOperationResult>;
  removeMcpServer: (input: McpRemoveInput) => Promise<McpOperationResult>;
  previewMcpToggle: (cwd: string, name: string, enabled: boolean) => Promise<McpTogglePreview>;
  applyMcpToggle: (previewId: string, cwd: string) => Promise<McpOperationResult>;
  getMcpBackups: () => Promise<McpBackupView[]>;
  restoreMcpBackup: (backupId: string, cwd: string) => Promise<McpOperationResult>;
  getSoftwareUpdates: (refresh?: boolean) => Promise<SoftwareUpdateState>;
  installOrUpdateClaudeCode: () => Promise<SoftwareUpdateOperationResult>;
  getApplicationUpdaterState: () => Promise<ApplicationUpdaterState>;
  downloadApplicationUpdate: () => Promise<ApplicationUpdaterState>;
  installApplicationUpdate: () => Promise<void>;
  onApplicationUpdaterChanged: (listener: (state: ApplicationUpdaterState) => void) => () => void;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<boolean>;
}
