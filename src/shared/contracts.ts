import type { TerminalThemeId } from './terminal-themes';
import type { ClaudeProviderId } from './claude-providers';

export type TerminalPhase = 'error' | 'running' | 'starting' | 'stopped';
export type DevelopmentRuntime = 'claude' | 'codex';
export type ClaudeAuthMode = 'apiKey' | 'authToken' | 'existing' | 'none';
export type ClaudeApiKeyHelperPolicy = 'inherit' | 'prefer-claudedock';
export type ClaudeCredentialAction = 'clear' | 'keep' | 'replace';
export type ClaudeLaunchMode = 'continue' | 'new' | 'resume';
export type CodexLaunchMode = ClaudeLaunchMode;
export type CodexLoginMethod = 'browser' | 'device-code';
export type BusyKind =
  'configure' | 'conversation' | 'download' | 'install' | 'proxy' | 'uninstall';
export type BusySeverity = 'blocking' | 'resumable';
export interface BusyLease {
  readonly cancellable: boolean;
  readonly id: string;
  readonly kind: BusyKind;
  readonly label: string;
  readonly severity: BusySeverity;
}
export interface AppQuitRequest {
  hasBlocking: boolean;
  leases: BusyLease[];
}
export type DownloadTaskState =
  'cancelled' | 'completed' | 'failed' | 'paused' | 'progressing' | 'queued' | 'verifying';
export interface DownloadTaskView {
  bytesPerSecond: number;
  canPause: boolean;
  canResume: boolean;
  elapsedMs: number;
  errorMessage?: string;
  id: string;
  label: string;
  percent: number;
  receivedBytes: number;
  remainingMs: number;
  state: DownloadTaskState;
  totalBytes: number;
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
export type GatewayCandidateKind = 'claude-code-router' | 'custom' | 'litellm';
export type GatewayCandidateStatus = 'offline' | 'partial' | 'ready';
export type ClaudeRouterGatewayState = 'error' | 'running' | 'starting' | 'stopped' | 'unknown';
export type ClaudeRouterInstallationKind = 'desktop' | 'mixed' | 'npm' | 'unknown';
export type ClaudeRouterInstallSource = 'github' | 'npm' | 'npmmirror';
export type ClaudeCodeInstallSource = 'native' | 'npm' | 'npmmirror';
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

export interface NetworkPreflightSettings {
  /** Omits third-party public-egress intelligence. Official connectivity checks still run. */
  enhancedPrivacyMode: boolean;
}

export interface NetworkPathView {
  detail: string;
  dnsServers: string[];
  ipv4Available: boolean;
  ipv6Available: boolean;
  process: NetworkProcessKind;
  proxyConfigured: boolean;
  proxyKind: 'direct' | 'environment' | 'pac' | 'socks' | 'system' | 'unknown';
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

export interface NetworkEgressSummary {
  asn?: string;
  countryCode?: string;
  countryName?: string;
  ipv4?: string;
  ipv6?: string;
  organization?: string;
  riskFlags?: string[];
  sourceCount: number;
  sources?: string[];
  sourcesAgree: boolean;
  stability: 'changed' | 'stable' | 'unknown';
}

export interface NetworkPreflightResult {
  cacheExpiresAt?: number;
  checkedAt?: number;
  egress?: NetworkEgressSummary;
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

export interface AppSettingsView {
  advanced: AdvancedSettings;
  artifactNetworkAllowed?: boolean;
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
  inputTokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
  modelDisplayName?: string;
  modelId?: string;
  outputTokens?: number;
  rateLimitFiveHour?: number;
  rateLimitSevenDay?: number;
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
  /** Modes actually observed in this session, in the order Shift+Tab visited them. */
  permissionModeCycle?: ClaudePermissionMode[];
  routeHealth?: ClaudeRouteHealth;
  sessionId: string;
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

export interface TerminalStatus {
  cwd: string;
  id: string;
  message?: string;
  phase: TerminalPhase;
  pid?: number;
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

export interface SoftwareUpdateTarget {
  currentVersion?: string;
  installed: boolean;
  latestVersion?: string;
  message: string;
  updateAvailable: boolean;
}

export interface SoftwareUpdateState {
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
  ok: boolean;
  /** Absent when the workspace has no conversation to report on — e.g. before a project is opened. */
  status?: TerminalStatus;
}

export interface WorkspaceResult {
  error?: string;
  ok: boolean;
  reused?: boolean;
  state: WorkspaceState;
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
  getAppSettings: () => Promise<AppSettingsView>;
  setLaunchAtLogin: (enabled: boolean) => Promise<AppSettingsView>;
  setAdvancedSettings: (settings: AdvancedSettings) => Promise<AppSettingsView>;
  listBusyLeases: () => Promise<BusyLease[]>;
  onBusyChanged: (listener: (leases: BusyLease[]) => void) => Unsubscribe;
  setConversationBusy: (busy: boolean) => Promise<BusyLease[]>;
  cancelDownload: (taskId: string) => Promise<DownloadTaskView>;
  listDownloads: () => Promise<DownloadTaskView[]>;
  onDownloadsChanged: (listener: (tasks: DownloadTaskView[]) => void) => Unsubscribe;
  pauseDownload: (taskId: string) => Promise<DownloadTaskView>;
  resumeDownload: (taskId: string) => Promise<DownloadTaskView>;
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
  getNetworkPreflightSettings: () => Promise<NetworkPreflightSettings>;
  setNetworkPreflightSettings: (
    settings: NetworkPreflightSettings,
  ) => Promise<NetworkPreflightSettings>;
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
  /** Reports the complete mode badge after xterm has applied PTY screen-delta output. */
  observeClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) => void;
  /** Answers a main-process probe with the mode currently visible in xterm's complete screen. */
  reportClaudePermissionModeProbe: (
    sessionId: string,
    probeId: number,
    mode?: ClaudePermissionMode,
  ) => void;
  /** Receives an on-demand request to read the current xterm screen, even if no new PTY data arrived. */
  onClaudePermissionModeProbe: (
    listener: (sessionId: string, probeId: number) => void,
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
  launchClaude: (sessionId: string, mode: ClaudeLaunchMode) => Promise<ClaudeOperationResult>;
  openClaudeRouterManagement: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  /**
   * The main process asks before it quits, so a streaming conversation or a busy terminal can be
   * protected by a themed dialog instead of dying silently. The renderer must answer every request
   * through `confirmQuit`, including the cancelling answer — the quit stays blocked until it does.
   */
  onAppQuitRequested: (listener: (request: AppQuitRequest) => void) => Unsubscribe;
  confirmQuit: (confirmed: boolean) => void;
  onAppWindowRestored: (listener: () => void) => Unsubscribe;
  onClaudeState: (listener: (state: ClaudeProjectState) => void) => Unsubscribe;
  onTerminalData: (listener: (sessionId: string, data: string) => void) => Unsubscribe;
  /**
   * The size the PTY actually adopted after clamping. xterm must follow it: PSReadLine repaints
   * with absolute cursor moves, so a size disagreement leaves the previous screen on top.
   */
  onTerminalSize: (
    listener: (sessionId: string, cols: number, rows: number) => void,
  ) => Unsubscribe;
  onWorkspaceState: (listener: (state: WorkspaceState) => void) => Unsubscribe;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  restartTerminal: (sessionId: string) => Promise<OperationResult>;
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
  startTerminal: (sessionId: string) => Promise<OperationResult>;
  stopTerminal: (sessionId: string) => Promise<OperationResult>;
  writeTerminal: (sessionId: string, data: string) => void;
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
  deleteClaudeSession: (projectPath: string, conversationId: string) => Promise<boolean>;
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
  getSoftwareUpdates: (refresh?: boolean) => Promise<SoftwareUpdateState>;
  installOrUpdateClaudeCode: (
    source: ClaudeCodeInstallSource,
  ) => Promise<SoftwareUpdateOperationResult>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<boolean>;
}
