import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ClaudeConnectionAdvice,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionTestResult,
  ClaudeEndpointProtocol,
  ClaudeEffortCompatibility,
  ClaudeEffortLevel,
  ClaudeEffortRequest,
  ClaudeGatewayDiagnostics,
  ClaudeInstallationStatus,
  ClaudeContextWindowMode,
  ClaudeLaunchMode,
  ClaudeMetrics,
  ClaudeModelOption,
  ClaudeModelOptions,
  ClaudePermissionMode,
  ClaudeProjectState,
  ClaudeRouteHealth,
  ClaudeRouterManagementState,
  ClaudeRouterProviderProtocol,
  ClaudeRouterInstallSource,
  ManagedChatGptContextWindowMode,
  ModelSpeedMode,
  ModelSpeedState,
  NetworkProviderId,
  PtyGeneration,
  RouterOperationProgress,
  ResourceUsageView,
  SoftwareUpdateState,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
} from '../shared/contracts';
import {
  completeConnectionEndpoint,
  routerProtocolForOpenAiEndpoint,
} from '../shared/connection-endpoint';
import { buildTerminalSubmission, writeTerminalSubmission } from '../shared/composer-input';
import {
  claudeModelIdsMatch,
  resolveClaudeRuntimeModel,
  stripClaudeContextWindowSuffix,
} from '../shared/claude-model-id';
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_EFFORT_REQUESTS,
  isClaudeEffortSafeAfterThinkingDisabledError,
} from '../shared/claude-effort';
import { parseClaudePermissionMode } from '../shared/claude-permission-mode';
import {
  findClaudeProvider,
  officialNetworkProviderForClaudePreset,
} from '../shared/claude-providers';
import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../shared/terminal-themes';
import { AsyncRefreshCache } from './async-refresh-cache';
import { ProviderResourceUsageService } from './provider-resource-usage';
import type { CcSwitchProviderExportInput } from './cc-switch-adapter';
import {
  BackgroundTaskCoordinator,
  type BackgroundTaskPriority,
} from './background-task-coordinator';
import {
  buildClaudeEnvironment,
  buildClaudeLaunchCommand,
  buildClaudePermissionHookCommand,
  buildClaudeSettingsEnvironment,
  buildRuntimeActivityCommand,
  buildClaudeSpeedSettings,
  managedChatGptContextProfile,
  buildRuntimeSignalCommand,
  buildStatusLineCommand,
  buildWebSearchGuardCommand,
  evaluateClaudeInstallation,
  MODEL_NAME_PATTERN,
  normalizeClaudeConfig,
  shouldDisableInheritedApiKeyHelper,
  type ClaudeEnvironmentOverrides,
  type ClaudeServingSpeedProfile,
  type NormalizedClaudeConfig,
} from './claude-configuration';
import type { ClaudeRuntimeActivityEvent } from './runtime-activity-registry';
import { POWERSHELL_STARTUP_COMMAND_ENV, POWERSHELL_STARTUP_TRIGGER } from './terminal-session';
import {
  classifyClaudeStreamFailure,
  type ClaudeStreamFailureKind,
} from './claude-stream-diagnostics-store';
import {
  CLAUDEDOCK_WEB_RESEARCH_AGENTS,
  CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME,
  CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT,
} from './claude-web-research';
import { claudeMessagesEndpoint, testClaudeConnection } from './claude-connection-test';
import { ClaudeConfigStore } from './claude-config-store';
import type {
  ClaudeConfigPresentation,
  ClaudeConfigSnapshot,
  ClaudeLaunchConfigSnapshot,
} from './claude-config-store';
import { ClaudeConnectionHistoryStore } from './claude-connection-history';
import { ClaudeGatewayDetector } from './claude-gateway-diagnostics';
import { ConversationPreferencesStore, isConversationId } from './conversation-preferences-store';
import {
  classifyModelSpeed,
  modelSpeedSignature,
  modelSpeedTargetKey,
  type ModelSpeedCapability,
} from './model-speed-capabilities';
import { ModelSpeedPreferencesStore } from './model-speed-preferences-store';
import { ClaudeRouterManager, type SavedRouterProvider } from './claude-router-manager';
import {
  RouteLifecycleCoordinator,
  type ClaudeRouteKind,
  type RouteReservationToken,
} from './route-lifecycle-coordinator';
import { discoverOpenAiModels } from './provider-model-discovery';
import {
  checkSoftwareUpdates,
  installOrUpdateClaudeCode,
  type SoftwareUpdateProgress,
} from './software-updates';

interface RuntimeSession {
  active: boolean;
  activityEventsPath?: string;
  /** Directory containing only this launch's settings and filesystem side-channel artifacts. */
  artifactDirectory?: string;
  /** Claude Code conversation this PTY is attached to, once the status line has reported it. */
  conversationId?: string;
  /** Generic Claude window selection captured for this launch and reused by live `/model`. */
  claudeContextWindowCustomTokens?: number;
  claudeContextWindowMode?: ClaudeContextWindowMode;
  contextWindowMode?: ManagedChatGptContextWindowMode;
  cwd: string;
  diagnosticBuffer: string;
  /** Temporary retry cap installed after Claude Code combines high effort with disabled thinking. */
  effortCompatibility?: ClaudeEffortCompatibility;
  /** Main-conversation effort restored after one successful compatibility retry finishes. */
  effortRestoreAfterTurn?: ClaudeEffortRequest;
  effortRestoreInProgress: boolean;
  /** Effort last requested from the status bar, until the status line reports what was applied. */
  effortRequest?: ClaudeEffortRequest;
  exitMarker?: string;
  expectedModel?: string;
  lastApiError?: {
    category: 'context-window-exceeded' | 'effort-thinking-disabled' | 'general';
    detectedAt: number;
    detail: string;
  };
  launchedConfigFingerprint?: string;
  launchedAt?: number;
  launchedCliVersion?: string;
  /** Monotonic owner of the settings, hooks, status line, and artifacts for this launch. */
  launchGeneration?: number;
  /** Serving-speed preference baked into this PTY launch, before any manual TUI changes. */
  launchedSpeedPreference?: ModelSpeedMode;
  launchedSpeedSignature?: string;
  launchedSpeedTargetKey?: string;
  markerRemainder: string;
  metrics?: ClaudeMetrics;
  metricsPath?: string;
  /** Model id passed only to Claude Code; persisted identity remains `expectedModel`. */
  runtimeModel?: string;
  /** Depth remembered for the resumed conversation, replayed once its TUI accepts commands. */
  pendingEffortRestore?: ClaudeEffortRequest;
  /** Earliest moment `pendingEffortRestore` may be submitted; a fresh TUI ignores instant input. */
  pendingEffortRestoreAt?: number;
  /** Live mode read off the TUI badge; undefined until the badge has been painted once. */
  permissionMode?: ClaudePermissionMode;
  /** Last ClaudeDock request, kept separate while the TUI still reports the previous mode. */
  permissionModeRequest?: ClaudePermissionMode;
  /** Modes this session has actually shown, in first-seen order. */
  permissionModeCycle: ClaudePermissionMode[];
  /** Exact PowerShell/ConPTY instance this runtime may observe or mutate. */
  ptyGeneration?: PtyGeneration;
  routeKind?: ClaudeRouteKind;
  sessionId: string;
  /** Latest `signaledAt` consumed from signal.json, so each signal is only acted on once. */
  signalSeenAt?: number;
  signalPath?: string;
  settingsPath?: string;
  thinkingEnabledForHighEffort: boolean;
  /** Top-level Stop hook signal; subagent completions are deliberately filtered by the helper. */
  turnStopPath?: string;
  turnStopSeenAt?: number;
  /** Resolved by the next PostCompact signal; lets a relaunch wait for compaction to finish. */
  waitingForCompact?: (signaledAt: number) => void;
}

export interface PreparedNativeClaudeConversation {
  allowBypassPermissions: boolean;
  cliVersion?: string;
  configFingerprint: string;
  endpointIdentity: string;
  environment: ClaudeEnvironmentOverrides;
  model: string;
  runtimeModel: string;
  settingsEnvironment: Record<string, string>;
}

interface ConnectionHistoryMetadata {
  name?: string;
  protocol: ClaudeEndpointProtocol;
  routerProviderId?: string;
  sourceConfig?: SaveClaudeConfigInput;
  sourceCredential?: string;
  sourceCredentialConfigured?: boolean;
}

export interface PreparedClaudeConfigSave {
  historyMetadata?: ConnectionHistoryMetadata;
  input: SaveClaudeConfigInput;
  presentation?: ClaudeConfigPresentation;
}

interface PreparedOpenAiConnection {
  effectiveInput: SaveClaudeConfigInput;
  historyMetadata: ConnectionHistoryMetadata;
  presentation: ClaudeConfigPresentation;
}

export const connectionProtocolForRouterProvider = (
  protocol: ClaudeRouterProviderProtocol,
): Exclude<ClaudeEndpointProtocol, 'unknown'> =>
  protocol === 'anthropic_messages' ? 'anthropic' : 'openai';

export const defaultConnectionProtocolForPreset = (
  preset: SaveClaudeConfigInput['preset'],
): ClaudeEndpointProtocol => (preset === 'gateway' ? 'unknown' : 'anthropic');

/**
 * Terminal writes that drive Claude Code's own UI. `ESC [Z` is the CBT sequence xterm already sends
 * for Shift+Tab, so stepping the mode from the status bar is byte-identical to pressing the key.
 */
const SHIFT_TAB_SEQUENCE = `${String.fromCharCode(27)}[Z`;
/** Upper bound on Shift+Tab presses when hunting for a mode. The real cycle is far shorter. */
const PERMISSION_MODE_MAX_STEPS = 8;
/** How long one press gets to repaint and survive a temporarily busy renderer before it is a no-op. */
const PERMISSION_MODE_STEP_TIMEOUT_MS = 2_000;
/** On-demand xterm snapshots are cheap, but leave enough time for PTY output to traverse both IPC hops. */
const PERMISSION_MODE_PROBE_INTERVAL_MS = 50;
const COMPACT_TIMEOUT_MS = 120_000;
/**
 * How long a resumed conversation gets to paint its TUI before the remembered thinking depth is
 * replayed. A `/effort` written into a terminal that is still booting is simply swallowed.
 */
const EFFORT_RESTORE_DELAY_MS = 2_500;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const COMPACT_INSTRUCTION = '请保留：当前任务目标、已完成的修改、待办的下一步。';

interface ConnectionCheckRecord {
  fingerprint: string;
  result: ClaudeConnectionTestResult;
}

export interface PreparedClaudeLaunch {
  command: string;
  environment: ClaudeEnvironmentOverrides;
  /** Bound PTY replaced by this prepared launch, if one still owned the runtime at commit time. */
  predecessorPtyGeneration?: PtyGeneration;
}

export interface PreparedClaudeSpeedRelaunch extends PreparedClaudeLaunch {
  preference: ModelSpeedMode;
  targetKey: string;
}

interface ResolvedModelSpeed {
  capability: ModelSpeedCapability;
  preference: ModelSpeedMode;
  profile: ClaudeServingSpeedProfile;
  signature: string;
  targetKey: string;
}

interface ClaudeLaunchOverrides {
  model?: string;
  speed?: ModelSpeedMode;
}

const execFileAsync = promisify(execFile);
const INSTALLATION_CACHE_MS = 30_000;
const METRICS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RUNTIME_ARTIFACT_DIRECTORY_PREFIX = 'launch-';
const RUNTIME_ARTIFACT_CLEANUP_SCAN_LIMIT = 16;
const RUNTIME_ARTIFACT_CLEANUP_REMOVE_LIMIT = 4;
const LEGACY_RUNTIME_ARTIFACT_NAMES = [
  'metrics.json',
  'settings.json',
  'signal.json',
  'turn-stop.json',
] as const;
const ROUTER_HEALTH_CACHE_MS = 3_000;
const SOFTWARE_UPDATE_CACHE_MS = 5 * 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const noInstallation = (message: string): ClaudeInstallationStatus => ({
  installationKind: 'unknown',
  installed: false,
  message,
  security: 'not-installed',
});

const optionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 1000 ? value : undefined;

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const optionalEffortLevel = (value: unknown): ClaudeEffortLevel | undefined =>
  typeof value === 'string' && CLAUDE_EFFORT_LEVELS.has(value as ClaudeEffortLevel)
    ? (value as ClaudeEffortLevel)
    : undefined;

const projectKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase('en-US');

const credentialDigest = (credential?: string): string =>
  createHash('sha256')
    .update(credential ?? '')
    .digest('hex');

const connectionFingerprint = (config: NormalizedClaudeConfig, credential?: string): string =>
  JSON.stringify({
    apiKeyHelperPolicy: config.apiKeyHelperPolicy,
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    credentialDigest: credentialDigest(credential),
    model: config.model,
    modelFast: config.modelFast || config.model,
    preset: config.preset,
    provider: config.provider,
  });

export const usesDefaultClaudeRouter = (config: NormalizedClaudeConfig): boolean => {
  if (config.provider !== 'gateway' || !config.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(config.baseUrl);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return (
      parsed.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) &&
      port === 3456
    );
  } catch {
    return false;
  }
};

export const routerRepairInputForProject = (
  config: NormalizedClaudeConfig,
  credential?: string,
): SaveClaudeRouterProviderInput => {
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error('当前项目没有可复制到路由器的远程 Anthropic 接口。');
  }
  if (
    config.provider !== 'gateway' ||
    usesDefaultClaudeRouter(config) ||
    parsed.protocol !== 'https:'
  ) {
    throw new Error('当前项目不是可复制到路由器的 HTTPS 远程接入配置。');
  }
  if (config.authMode !== 'apiKey' || !credential) {
    throw new Error('一键修复要求当前项目已保存接口密钥；持有者令牌或无认证上游请手动添加。');
  }
  const providerSuffix =
    parsed.hostname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 65) || 'current-project';
  return {
    apiKey: credential,
    baseUrl: claudeMessagesEndpoint(config.baseUrl),
    credentialAction: 'replace',
    makePreferred: true,
    models: [config.model],
    name: `claudedock-${providerSuffix}`,
    protocol: 'anthropic_messages',
    useForCurrentProject: false,
  };
};

const normalizedRuntimeError = (value: string): string => {
  const compact = value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
  if (/ConnectionRefused/i.test(compact)) {
    return 'Claude Code 无法连接到当前接口地址。端点可能已停止、被代理拒绝，或保存后的路由已经变化。';
  }
  if (
    /input exceeds the context window|context window of this model|maximum context length|too many input tokens/i.test(
      compact,
    )
  ) {
    return '当前对话已超过模型上下文上限，连压缩请求也无法送达。请新建对话继续；ClaudeDock 已改为按模型与窗口模式设置容量，并在后续托管 ChatGPT 会话中提前自动压缩。';
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid (?:api )?key|authentication/i.test(compact)) {
    return 'Claude Code 的真实会话被接口拒绝认证。请重新核对认证方式与当前保存的密钥。';
  }
  if (/model.+(?:not found|invalid|unsupported|does not exist)|unknown model/i.test(compact)) {
    return `Claude Code 的真实会话未被当前模型接受。供应商原始错误：${compact}`;
  }
  if (/\b404\b|not found/i.test(compact)) {
    return 'Claude Code 没有找到消息接口；请确认当前基址最终提供 /v1/messages。';
  }
  if (
    /output_config\.effort.+(?:xhigh|max).+not supported when thinking is disabled/i.test(compact)
  ) {
    return 'Claude Code 在 thinking 关闭的请求中发送了过高的思考档位；ClaudeDock 正在自动降到“均衡”。';
  }
  return compact
    ? 'Claude Code 的接口请求失败；请检查接入地址、认证方式和模型配置。原始错误已保留在终端输出中。'
    : 'Claude Code 的真实会话请求失败。';
};

const withoutTerminalControls = (value: string): string =>
  value
    .replace(
      // ANSI CSI / OSC control sequences emitted by the terminal renderer.
      // eslint-disable-next-line no-control-regex
      /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g,
      '',
    )
    .replace(/\r/g, '\n');

const latestClaudeRuntimeApiError = (value: string): string | undefined => {
  const withoutAnsi = withoutTerminalControls(value);
  const marker = 'api error:';
  const markerAt = withoutAnsi.toLowerCase().lastIndexOf(marker);
  if (markerAt < 0) {
    return undefined;
  }
  return withoutAnsi
    .slice(markerAt + marker.length, markerAt + marker.length + 800)
    .replace(/\s+/g, ' ')
    .trim();
};

export const parseClaudeEffortThinkingDisabledError = (
  value: string,
): 'max' | 'xhigh' | undefined => {
  const latest = latestClaudeRuntimeApiError(value);
  if (!latest || !/output_config\.effort/i.test(latest) || !/thinking is disabled/i.test(latest)) {
    return undefined;
  }
  const rejected = /output_config\.effort\s*['"]?(xhigh|max)['"]?/i
    .exec(latest)?.[1]
    ?.toLowerCase();
  return rejected === 'max' || rejected === 'xhigh' ? rejected : undefined;
};

export const parseClaudeRuntimeApiError = (value: string): string | undefined => {
  const latest = latestClaudeRuntimeApiError(value);
  return latest ? normalizedRuntimeError(latest) : undefined;
};

export const parseClaudeContextWindowError = (value: string): boolean => {
  const latest = latestClaudeRuntimeApiError(value);
  return Boolean(
    latest &&
    // `prompt is too long` is the canonical Anthropic 400 wording; gateways reword it freely, so
    // match the shortened form some of them emit as well.
    /input exceeds the context window|context window of this model|maximum context length|too many input tokens|prompt is too long|prompt too long/i.test(
      latest,
    ),
  );
};

export const routerBlockingDetail = (
  config: NormalizedClaudeConfig,
  router: ClaudeRouterManagementState,
): string | undefined => {
  if (!usesDefaultClaudeRouter(config)) {
    return undefined;
  }
  if (router.providers.length === 0) {
    return '当前项目指向路由器的 3456 接口，但 CCR 没有任何服务提供方或模型。请先在“接入”页添加服务提供方。';
  }
  if (router.gatewayState !== 'running') {
    return `当前项目指向路由器的 3456 接口，但模型网关未就绪：${router.message}`;
  }
  return undefined;
};

/** A relay ("中转站") is any remote gateway base URL saved in the project configuration. */
export const usesRemoteRelay = (config: NormalizedClaudeConfig): boolean =>
  config.provider === 'gateway' && Boolean(config.baseUrl) && !usesDefaultClaudeRouter(config);

/**
 * Turns the saved config plus live Router state into one plain-language verdict. Computed in the
 * main process so the advice is identical whether or not the user ever pasted a curl command.
 */
export const computeClaudeConnectionAdvice = (
  config: NormalizedClaudeConfig,
  credentialConfigured: boolean,
  router: ClaudeRouterManagementState,
  installation: ClaudeInstallationStatus,
): ClaudeConnectionAdvice => {
  const routerNeeded = usesDefaultClaudeRouter(config);
  const routerGatewayUp = router.gatewayState === 'running' || router.gatewayState === 'starting';
  const routerRunningButUnused = !routerNeeded && routerGatewayUp;
  const credentialMissing =
    (config.authMode === 'apiKey' || config.authMode === 'authToken') && !credentialConfigured;

  if (installation.security !== 'ready') {
    return {
      actions: [],
      detail: installation.message,
      routerNeeded,
      routerRunningButUnused,
      title: 'Claude Code 尚未就绪',
      tone: 'error',
    };
  }

  if (credentialMissing) {
    return {
      actions: ['save-config'],
      detail: '当前接入方式需要密钥，但当前项目还没有保存。填好密钥后点“保存接入配置”即可。',
      routerNeeded,
      routerRunningButUnused,
      title: '还缺一个接口密钥',
      tone: 'warning',
    };
  }

  if (routerNeeded) {
    if (!router.installed) {
      return {
        actions: ['install-router', 'switch-to-direct'],
        detail:
          '当前配置选择了本机路由器 3456，但 CCR 尚未安装。请先安装路由器，或改用可用的 Anthropic 消息兼容接口。',
        routerNeeded,
        routerRunningButUnused: false,
        title: '需要先安装路由器',
        tone: 'error',
      };
    }
    if (router.providers.length === 0) {
      return {
        actions: ['open-router-management', 'switch-to-direct'],
        detail: '路由器已安装但还没有任何服务提供方，模型请求无处可去。请先添加一个服务提供方。',
        routerNeeded,
        routerRunningButUnused: false,
        title: '路由器还没有配置上游',
        tone: 'warning',
      };
    }
    if (!routerGatewayUp) {
      return {
        actions: ['start-router'],
        detail: `当前项目通过路由器连接模型服务，但模型网关没有运行：${router.message}`,
        routerNeeded,
        routerRunningButUnused: false,
        title: '路由器网关未启动',
        tone: 'warning',
      };
    }
    return {
      actions: ['test-connection'],
      detail: `路由器网关运行中，已配置 ${router.providers.length} 个服务提供方，当前项目会经由它访问模型。`,
      routerNeeded,
      routerRunningButUnused: false,
      title: '经路由器接入，一切正常',
      tone: 'success',
    };
  }

  if (usesRemoteRelay(config)) {
    return {
      actions: ['test-connection'],
      detail: `已配置 Anthropic 消息兼容接口 ${config.baseUrl}。建议保存后执行真实连接测试。`,
      routerNeeded: false,
      routerRunningButUnused,
      title: '兼容接口已配置',
      tone: 'success',
    };
  }

  if (config.provider === 'gateway') {
    return {
      actions: ['import-curl', 'save-config'],
      detail:
        '选了“网关/中转站”但还没有填接口地址。可以直接粘贴中转站给的 curl 命令，自动带出地址、密钥和模型。',
      routerNeeded: false,
      routerRunningButUnused,
      title: '还没有填写接口地址',
      tone: 'warning',
    };
  }

  return {
    actions: ['test-connection'],
    detail: 'Claude Code 将使用现有官方登录或已保存的官方凭据。可执行连接测试确认当前状态。',
    routerNeeded: false,
    routerRunningButUnused,
    title: '使用 Anthropic 官方接入',
    tone: 'success',
  };
};

export const claudeResourceUsage = (
  metrics: ClaudeMetrics | undefined,
  config: NormalizedClaudeConfig,
  contextWindowMode: ManagedChatGptContextWindowMode,
): ResourceUsageView => {
  const contextProfile = managedChatGptContextProfile(config, contextWindowMode);
  const checkedAt = metrics?.capturedAt ?? Date.now();
  const autoCompactAtTokens = contextProfile
    ? ((metrics?.contextWindowSize
        ? Math.min(metrics.contextWindowSize, contextProfile.effectiveContextWindowTokens)
        : contextProfile.effectiveContextWindowTokens) *
        contextProfile.autoCompactPercent) /
      100
    : undefined;
  /*
   * `contextWindowUsed` is clamped to the window by the status line, so a window that is smaller
   * than what the endpoint actually serves shows a permanent 100%. `inputTokens` carries the raw
   * total, and its overshoot is the only evidence available from outside the CLI that the declared
   * window is wrong. Report the real ratio rather than the clamped one so the bar keeps moving.
   */
  const contextCountingAnomaly =
    metrics?.contextWindowSize &&
    metrics.contextWindowUsed === metrics.contextWindowSize &&
    metrics.inputTokens !== undefined &&
    metrics.inputTokens > metrics.contextWindowSize
      ? { reportedTokens: metrics.inputTokens, windowTokens: metrics.contextWindowSize }
      : undefined;
  const contextUsedPercent = contextCountingAnomaly
    ? (contextCountingAnomaly.reportedTokens / contextCountingAnomaly.windowTokens) * 100
    : metrics?.contextWindowUsed !== undefined && metrics.contextWindowSize
      ? Math.min(100, Math.max(0, (metrics.contextWindowUsed / metrics.contextWindowSize) * 100))
      : undefined;
  const windows = [
    metrics?.rateLimitFiveHour === undefined
      ? undefined
      : {
          label: '5 小时',
          resetsAt: metrics.rateLimitFiveHourResetsAt,
          usedPercent: Math.min(100, Math.max(0, metrics.rateLimitFiveHour)),
          windowDurationMins: 300,
        },
    metrics?.rateLimitSevenDay === undefined
      ? undefined
      : {
          label: '7 天',
          resetsAt: metrics.rateLimitSevenDayResetsAt,
          usedPercent: Math.min(100, Math.max(0, metrics.rateLimitSevenDay)),
          windowDurationMins: 10_080,
        },
  ].filter((window): window is NonNullable<typeof window> => Boolean(window));
  const available = contextUsedPercent !== undefined || windows.length > 0;
  return {
    availability: available ? 'available' : 'unavailable',
    autoCompactAtTokens,
    capabilities: { balance: false, context: true, windows: true },
    checkedAt,
    contextCountingAnomaly,
    contextUsedPercent,
    contextUsedTokens: contextCountingAnomaly?.reportedTokens ?? metrics?.contextWindowUsed,
    contextWindowTokens: metrics?.contextWindowSize,
    detail: available ? undefined : '等待 Claude Code 状态行上报。',
    source: 'claude-statusline',
    staleAt: metrics ? metrics.capturedAt + METRICS_MAX_AGE_MS : undefined,
    windows: windows.length > 0 ? windows : undefined,
  };
};

export const effectiveClaudeMetrics = (
  metrics: ClaudeMetrics | undefined,
  config: NormalizedClaudeConfig,
  contextWindowMode: ManagedChatGptContextWindowMode = 'standard',
): ClaudeMetrics | undefined => {
  const profile = managedChatGptContextProfile(config, contextWindowMode);
  return profile && metrics?.contextWindowSize === profile.contextWindowTokens
    ? { ...metrics, contextWindowSize: profile.effectiveContextWindowTokens }
    : metrics;
};

export const mergeClaudeResourceUsage = (
  context: ResourceUsageView,
  provider: ResourceUsageView | undefined,
): ResourceUsageView =>
  provider
    ? {
        ...provider,
        availability:
          provider.availability === 'available' || context.availability === 'available'
            ? 'available'
            : provider.availability === 'stale' || context.availability === 'stale'
              ? 'stale'
              : 'unavailable',
        autoCompactAtTokens: context.autoCompactAtTokens,
        capabilities: {
          balance: provider.capabilities.balance || context.capabilities.balance,
          context: provider.capabilities.context || context.capabilities.context,
          windows: provider.capabilities.windows || context.capabilities.windows,
        },
        checkedAt: Math.max(provider.checkedAt, context.checkedAt),
        contextCountingAnomaly: context.contextCountingAnomaly,
        contextUsedPercent: context.contextUsedPercent,
        contextUsedTokens: context.contextUsedTokens,
        contextWindowTokens: context.contextWindowTokens,
        windows: context.windows ?? provider.windows,
      }
    : context;

export const parseClaudeMetrics = (raw: string): ClaudeMetrics | undefined => {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const capturedAt = optionalFiniteNumber(parsed.capturedAt);
    if (!capturedAt || Date.now() - capturedAt > METRICS_MAX_AGE_MS) {
      return undefined;
    }

    return {
      capturedAt,
      contextWindowSize: optionalFiniteNumber(parsed.contextWindowSize),
      contextWindowUsed: optionalFiniteNumber(parsed.contextWindowUsed),
      effortLevel: optionalEffortLevel(parsed.effortLevel),
      fastMode: optionalBoolean(parsed.fastMode),
      inputTokens: optionalFiniteNumber(parsed.inputTokens),
      linesAdded: optionalFiniteNumber(parsed.linesAdded),
      linesRemoved: optionalFiniteNumber(parsed.linesRemoved),
      modelDisplayName: optionalString(parsed.modelDisplayName),
      modelId: optionalString(parsed.modelId),
      outputTokens: optionalFiniteNumber(parsed.outputTokens),
      rateLimitFiveHour: optionalFiniteNumber(parsed.rateLimitFiveHour),
      rateLimitFiveHourResetsAt: optionalFiniteNumber(parsed.rateLimitFiveHourResetsAt),
      rateLimitSevenDay: optionalFiniteNumber(parsed.rateLimitSevenDay),
      rateLimitSevenDayResetsAt: optionalFiniteNumber(parsed.rateLimitSevenDayResetsAt),
      sessionCostUsd: optionalFiniteNumber(parsed.sessionCostUsd),
      sessionDurationMs: optionalFiniteNumber(parsed.sessionDurationMs),
      sessionId: optionalString(parsed.sessionId),
      sessionName: optionalString(parsed.sessionName),
    };
  } catch {
    return undefined;
  }
};

const modelMatches = (expected: string | undefined, actual: string | undefined): boolean => {
  return claudeModelIdsMatch(expected, actual);
};

const longestMarkerPrefixSuffix = (value: string, marker: string): number => {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
};

/**
 * What makes two setups "the same endpoint" for switching purposes: identical route, credential
 * kind and preset. Anything else means a different PTY environment and therefore a relaunch.
 */
const endpointKey = (value: {
  apiKeyHelperPolicy: string;
  authMode: string;
  baseUrl: string;
  preset: string;
  provider: string;
}): string =>
  `${value.provider}|${value.preset}|${value.authMode}|${value.apiKeyHelperPolicy}|${value.baseUrl}`;

const customRouterProviderName = (endpoint: string): string => {
  const hostname =
    new URL(endpoint).hostname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'openai-relay';
  const suffix = createHash('sha256').update(endpoint).digest('hex').slice(0, 8);
  return `claudedock-${hostname}-${suffix}`;
};

const describeEndpoint = (entry: ClaudeConnectionHistoryEntry): string => {
  const providerLabel = findClaudeProvider(entry.preset)?.label ?? '自定义接入';
  if (entry.provider !== 'gateway' || !entry.baseUrl) {
    return providerLabel;
  }
  try {
    return `${providerLabel} · ${new URL(entry.baseUrl).host}`;
  } catch {
    return providerLabel;
  }
};

export const claudeCodeThemeForTerminalTheme = (themeId: TerminalThemeId): 'dark' | 'light' =>
  TERMINAL_THEMES[themeId].appearance === 'light' ? 'light' : 'dark';

export class ClaudeRuntime {
  private activityScriptPath?: string;
  private onActivityEvent?: (event: ClaudeRuntimeActivityEvent) => void;
  private onStreamFailure?: (observation: {
    cliVersion?: string;
    gatewayVersion?: string;
    kind: ClaudeStreamFailureKind;
    occurredAt: number;
    sessionId: string;
    sessionRuntimeMs: number;
  }) => void;
  private permissionHookScriptPath?: string;
  private createPermissionEndpoint?: (
    sessionId: string,
    launchGeneration: number,
  ) => { pipeName: string; token: string };
  private readonly backgroundTasks = new BackgroundTaskCoordinator(2);
  private readonly installationCache = new AsyncRefreshCache<ClaudeInstallationStatus>(
    INSTALLATION_CACHE_MS,
  );
  private readonly routerHealthCache = new AsyncRefreshCache<ClaudeRouterManagementState>(
    ROUTER_HEALTH_CACHE_MS,
  );
  private readonly softwareUpdatesCache = new AsyncRefreshCache<SoftwareUpdateState>(
    SOFTWARE_UPDATE_CACHE_MS,
  );
  private readonly configStore: ClaudeConfigStore;
  private conversationLaunchGuard: (
    cwd: string,
    mode: ClaudeLaunchMode,
    conversationId?: string,
  ) => void = () => {};
  private readonly fetchImplementation: typeof fetch;
  private readonly connectionChecks = new Map<string, ConnectionCheckRecord>();
  /** Serialises complete body/return submissions so two UI actions cannot interleave PTY bytes. */
  private readonly commandSubmissionQueues = new Map<string, Promise<void>>();
  private readonly gatewayDetector = new ClaudeGatewayDetector();
  private readonly conversationPreferences: ConversationPreferencesStore;
  private readonly historyStore: ClaudeConnectionHistoryStore;
  private readonly modelSpeedPreferences: ModelSpeedPreferencesStore;
  private metricsPollInFlight?: Promise<void>;
  private readonly metricsTimer: NodeJS.Timeout;
  private nextLaunchGeneration = 0;
  private nextStateRevision = 0;
  private readonly resourceUsageService: ProviderResourceUsageService;
  /** Serialises Shift+Tab stepping per session so two clicks can never interleave presses. */
  private readonly modeSwitchLocks = new Set<string>();
  private readonly routeLifecycle = new RouteLifecycleCoordinator();
  private readonly nativeRouteReservations = new Map<string, RouteReservationToken>();
  private readonly routerManager: ClaudeRouterManager;
  private readonly runtimeLaunchToken = randomBytes(8).toString('hex');
  private readonly runtimeRoot: string;
  private readonly sessions = new Map<string, RuntimeSession>();
  private currentThemeId: TerminalThemeId;

  public constructor(
    userDataPath: string,
    private readonly statusLineScriptPath: string,
    private readonly signalScriptPath: string,
    private readonly webSearchGuardScriptPath: string,
    /**
     * Read per launch, so toggling the workaround in settings takes effect on the next session
     * without a restart.
     */
    private readonly isWebResearchIsolationEnabled: () => boolean,
    private readonly managedChatGptContextWindowMode: () => ManagedChatGptContextWindowMode,
    /** Read per launch so a status-bar window change applies to the next session. */
    private readonly claudeContextWindow: () => {
      customTokens?: number;
      mode: ClaudeContextWindowMode;
    },
    private readonly onState: (state: ClaudeProjectState) => void,
    private readonly writeToTerminal: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
      data: string,
    ) => boolean,
    private readonly readPermissionModeFromScreen: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
    ) => Promise<ClaudePermissionMode | undefined>,
    private readonly ensureManagedChatGptGatewayReady: () => Promise<void>,
    private readonly managedChatGptGatewayInstalledVersion: () => string | undefined,
    fetchImplementation: typeof fetch = fetch,
    initialThemeId: TerminalThemeId = DEFAULT_TERMINAL_THEME,
    private readonly applicationVersion?: string,
    onRouterOperationProgress: (progress: RouterOperationProgress) => void = () => {},
    private readonly stopManagedChatGptGateway: () => Promise<void> | void = () => {},
    routerCommandEnvironment: () => Record<string, null | string | undefined> = () => ({}),
  ) {
    this.configStore = new ClaudeConfigStore(userDataPath);
    this.historyStore = new ClaudeConnectionHistoryStore(userDataPath);
    this.fetchImplementation = fetchImplementation;
    this.resourceUsageService = new ProviderResourceUsageService(fetchImplementation);
    this.conversationPreferences = new ConversationPreferencesStore(userDataPath);
    this.modelSpeedPreferences = new ModelSpeedPreferencesStore(userDataPath);
    this.routerManager = new ClaudeRouterManager(
      userDataPath,
      onRouterOperationProgress,
      routerCommandEnvironment,
    );
    this.runtimeRoot = path.join(userDataPath, 'claude', 'runtime');
    this.currentThemeId = initialThemeId;
    this.metricsTimer = setInterval(() => {
      this.pollMetrics();
    }, 1000);
    this.metricsTimer.unref();
  }

  public setRuntimeActivityHandler(
    scriptPath: string,
    handler: (event: ClaudeRuntimeActivityEvent) => void,
  ): void {
    this.activityScriptPath = scriptPath;
    this.onActivityEvent = handler;
  }

  public setPermissionRequestHook(
    scriptPath: string,
    createEndpoint: (
      sessionId: string,
      launchGeneration: number,
    ) => { pipeName: string; token: string },
  ): void {
    this.permissionHookScriptPath = scriptPath;
    this.createPermissionEndpoint = createEndpoint;
  }

  public setStreamFailureHandler(handler: NonNullable<ClaudeRuntime['onStreamFailure']>): void {
    this.onStreamFailure = handler;
  }

  public closeSession(sessionId: string): void {
    const previous = this.sessions.get(sessionId);
    const previousRoute = previous?.routeKind;
    if (previous?.launchGeneration !== undefined && previous.ptyGeneration !== undefined) {
      this.emitSyntheticSessionEnd(previous);
    }
    this.sessions.delete(sessionId);
    if (previousRoute) {
      void this.stopUnusedRoute(previousRoute).catch(() => {});
    }
  }

  public removeConversationPreferences(conversationId: string): void {
    this.conversationPreferences.remove(conversationId);
  }

  public sessionOwnsConversation(sessionId: string, cwd: string, conversationId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active || projectKey(runtime.cwd) !== projectKey(cwd)) {
      return false;
    }
    const normalizedConversationId = conversationId.toLowerCase();
    return [runtime.conversationId, runtime.metrics?.sessionId].some(
      (candidate) => candidate?.toLowerCase() === normalizedConversationId,
    );
  }

  public sessionIdsForConversation(cwd: string, conversationId: string): string[] {
    return [...this.sessions.values()]
      .filter(({ sessionId }) => this.sessionOwnsConversation(sessionId, cwd, conversationId))
      .map(({ sessionId }) => sessionId);
  }

  public setConversationLaunchGuard(
    guard: (cwd: string, mode: ClaudeLaunchMode, conversationId?: string) => void,
  ): void {
    this.conversationLaunchGuard = guard;
  }

  public officialNetworkProvider(cwd: string): NetworkProviderId | undefined {
    return officialNetworkProviderForClaudePreset(this.configStore.getConfig(cwd).preset);
  }

  public currentProviderForCcSwitch(cwd: string): CcSwitchProviderExportInput {
    const config = this.configStore.getConfig(cwd);
    const view = this.configStore.getView(cwd);
    if (view.protocol === 'openai' || view.routerProviderId) {
      throw new Error(
        '当前上游凭据由 CCR 保存且不会回显；请改用一键接入向导重新填写 Key 后再导出。',
      );
    }
    const provider = findClaudeProvider(config.preset);
    return {
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      credential: this.configStore.getCredential(cwd),
      model: config.model,
      modelFast: config.modelFast,
      name: provider?.label ?? config.preset,
    };
  }

  public connectionHistoryOfficialNetworkProvider(
    cwd: string,
    entryId: string,
  ): NetworkProviderId | undefined {
    return officialNetworkProviderForClaudePreset(
      this.historyStore.toSaveInput(cwd, entryId).preset,
    );
  }

  public createConfigSnapshot(cwd: string): ClaudeConfigSnapshot {
    return this.configStore.createSnapshot(cwd);
  }

  public restoreConfigSnapshot(cwd: string, snapshot: ClaudeConfigSnapshot): void {
    this.configStore.restoreSnapshot(cwd, snapshot);
  }

  /** Applies to the next Claude launch; a live Ink TUI is never mutated underneath the user. */
  public setTheme(themeId: TerminalThemeId): void {
    this.currentThemeId = themeId;
  }

  public consumeTerminalOutput(
    sessionId: string,
    ptyGeneration: PtyGeneration,
    data: string,
  ): string {
    const runtime = this.sessions.get(sessionId);
    if (runtime?.ptyGeneration !== ptyGeneration || !runtime.exitMarker) {
      return data;
    }

    runtime.diagnosticBuffer = `${runtime.diagnosticBuffer}${data}`.slice(-4_000);
    const rejectedEffort = parseClaudeEffortThinkingDisabledError(runtime.diagnosticBuffer);
    if (rejectedEffort && !runtime.effortCompatibility) {
      runtime.effortCompatibility = {
        detectedAt: Date.now(),
        maximum: 'high',
        recovery: 'pending',
        rejectedLevel: rejectedEffort,
      };
      void this.recoverEffortAfterThinkingDisabled(runtime, rejectedEffort);
    }
    const detectedError = parseClaudeRuntimeApiError(runtime.diagnosticBuffer);
    const contextWindowExceeded = parseClaudeContextWindowError(runtime.diagnosticBuffer);
    const contextualError =
      detectedError && contextWindowExceeded && runtime.contextWindowMode === 'extended'
        ? `${detectedError} 当前会话启用了实验性的 105 万扩展窗口；这通常表示 ChatGPT 订阅后端仍按较小的产品窗口拒绝请求，请切回标准窗口后新建会话。`
        : detectedError;
    if (contextualError && contextualError !== runtime.lastApiError?.detail) {
      const detectedAt = Date.now();
      runtime.lastApiError = {
        category: rejectedEffort
          ? 'effort-thinking-disabled'
          : contextWindowExceeded
            ? 'context-window-exceeded'
            : 'general',
        detail: contextualError,
        detectedAt,
      };
      const streamFailure = classifyClaudeStreamFailure(contextualError);
      if (streamFailure) {
        this.onStreamFailure?.({
          ...(runtime.launchedCliVersion ? { cliVersion: runtime.launchedCliVersion } : {}),
          ...(this.managedGatewayVersion() ? { gatewayVersion: this.managedGatewayVersion() } : {}),
          kind: streamFailure,
          occurredAt: detectedAt,
          sessionId,
          sessionRuntimeMs: Math.max(0, detectedAt - (runtime.launchedAt ?? detectedAt)),
        });
      }
      void this.emitState(runtime);
    }
    this.observePermissionModeFromRawOutput(runtime);

    let combined = runtime.markerRemainder + data;
    runtime.markerRemainder = '';
    const exitMarker = runtime.exitMarker;
    if (combined.includes(exitMarker)) {
      combined = combined.replaceAll(exitMarker, '');
      this.setInactive(sessionId, ptyGeneration);
    }

    if (runtime.exitMarker) {
      const retainedLength = longestMarkerPrefixSuffix(combined, runtime.exitMarker);
      if (retainedLength > 0) {
        runtime.markerRemainder = combined.slice(-retainedLength);
        return combined.slice(0, -retainedLength);
      }
    }

    return combined;
  }

  private managedGatewayVersion(): string | undefined {
    try {
      return this.managedChatGptGatewayInstalledVersion();
    } catch {
      return undefined;
    }
  }

  private resolveModelSpeed(
    config: NormalizedClaudeConfig,
    model: string,
    claudeVersion?: string,
    override?: ModelSpeedMode,
  ): ResolvedModelSpeed {
    const target = {
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      model,
      preset: config.preset,
      provider: config.provider,
    };
    const capability = classifyModelSpeed({
      claudeVersion,
      config: target,
      managedGatewayVersion: this.managedGatewayVersion(),
      model,
    });
    if (override === 'fast' && !capability.canSelectFast) {
      throw new Error(capability.detail);
    }
    const targetKey = modelSpeedTargetKey(target);
    const preference = override ?? this.modelSpeedPreferences.get(targetKey).mode;
    const appliedMode = preference === 'fast' && capability.canSelectFast ? 'fast' : 'standard';
    return {
      capability,
      preference,
      profile: { mechanism: capability.mechanism, mode: appliedMode },
      signature: modelSpeedSignature(capability, preference),
      targetKey,
    };
  }

  private modelForSpeedPreference(
    runtime: RuntimeSession,
    config: NormalizedClaudeConfig,
    claudeVersion?: string,
  ): string {
    if (!runtime.active) {
      return config.model;
    }
    const reportedModel = runtime.metrics?.modelId;
    const expectedModel = runtime.expectedModel;
    if (
      expectedModel &&
      expectedModel !== 'default' &&
      modelMatches(expectedModel, reportedModel)
    ) {
      const expectedCapability = classifyModelSpeed({
        claudeVersion,
        config,
        managedGatewayVersion: this.managedGatewayVersion(),
        model: expectedModel,
      });
      if (expectedCapability.availability !== 'unverified') {
        return expectedModel;
      }
    }
    return stripClaudeContextWindowSuffix(reportedModel ?? expectedModel ?? config.model);
  }

  private modelSpeedState(
    runtime: RuntimeSession,
    config: NormalizedClaudeConfig,
    claudeVersion?: string,
  ): ModelSpeedState {
    const model = this.modelForSpeedPreference(runtime, config, claudeVersion);
    const resolved = this.resolveModelSpeed(config, model, claudeVersion);
    const launchedTarget =
      runtime.active &&
      (runtime.launchedSpeedTargetKey === resolved.targetKey ||
        modelMatches(runtime.expectedModel, model));
    const preference = launchedTarget
      ? (runtime.launchedSpeedPreference ?? resolved.preference)
      : resolved.preference;
    const requestedSignature = modelSpeedSignature(resolved.capability, preference);
    const fastLaunchRequested =
      launchedTarget &&
      requestedSignature !== 'standard' &&
      runtime.launchedSpeedSignature === requestedSignature;
    const officialAnthropic =
      config.provider === 'anthropic' &&
      (config.preset === 'anthropic' || config.preset === 'anthropic-api');

    let detail = resolved.capability.detail;
    let status: ModelSpeedState['status'] = 'standard';
    if (runtime.active && officialAnthropic && runtime.metrics?.fastMode === true) {
      status = 'active';
      if (preference === 'standard') {
        detail =
          'Claude Code 状态行报告当前会话已开启 Fast；ClaudeDock 仍会在下次启动时恢复已保存的标准速度。';
      }
    } else if (resolved.capability.availability === 'available' && preference === 'fast') {
      if (!runtime.active) {
        status = 'requested';
        detail = `${resolved.capability.detail} 已保存，将在下次新建或恢复会话时请求。`;
      } else if (resolved.capability.mechanism === 'gpt-service-tier' && fastLaunchRequested) {
        status = 'requested';
        detail =
          'ClaudeDock 已把 service_tier=fast 写入当前 GPT 会话请求；实际资格和上游是否采用仍由 ChatGPT 决定。';
      } else if (resolved.capability.mechanism === 'claude-native-fast' && fastLaunchRequested) {
        if (runtime.metrics?.fastMode === false) {
          status = 'not-active';
          detail =
            '已请求 Claude Fast，但 Claude Code 状态行报告未生效；请查看终端中的组织权限、额度或模型提示。';
        } else {
          status = 'requested';
          detail = '已请求 Claude Fast，正在等待 Claude Code 状态行确认是否生效。';
        }
      } else {
        status = 'not-active';
        detail = '当前 PowerShell 会话没有使用已保存的快速速度配置，需要重启后才能生效。';
      }
    }

    return {
      availability: resolved.capability.availability,
      canSelectFast: resolved.capability.canSelectFast,
      detail,
      mechanism: resolved.capability.mechanism,
      model,
      preference,
      status,
    };
  }

  public async getState(sessionId: string, cwd: string): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    for (;;) {
      if (this.sessions.get(sessionId) !== runtime) {
        throw new Error('Claude Code 会话已关闭，这次状态读取已取消。');
      }
      const stateRevision = ++this.nextStateRevision;
      const active = runtime.active;
      const launchGeneration = runtime.launchGeneration;
      const ptyGeneration = runtime.ptyGeneration;
      const runtimeCwd = runtime.cwd;
      const lastApiError = runtime.lastApiError;
      const ownershipIsCurrent = (): boolean =>
        this.sessions.get(sessionId) === runtime &&
        runtime.active === active &&
        runtime.launchGeneration === launchGeneration &&
        runtime.ptyGeneration === ptyGeneration &&
        runtime.cwd === runtimeCwd;

      const installation = await this.diagnoseInstallation();
      if (!ownershipIsCurrent()) {
        continue;
      }
      const config = this.configStore.getConfig(cwd);
      const credential = this.configStore.getCredential(cwd);
      const configFingerprint = connectionFingerprint(config, credential);
      const [providerUsage, routeHealth] = await Promise.all([
        this.resourceUsageService.read(projectKey(cwd), config.preset, credential),
        this.getRouteHealth(runtime, config),
      ]);
      if (this.sessions.get(sessionId) !== runtime) {
        throw new Error('Claude Code 会话已关闭，这次状态读取已取消。');
      }
      if (
        !ownershipIsCurrent() ||
        runtime.lastApiError !== lastApiError ||
        connectionFingerprint(
          this.configStore.getConfig(cwd),
          this.configStore.getCredential(cwd),
        ) !== configFingerprint
      ) {
        continue;
      }

      const matches = modelMatches(runtime.expectedModel, runtime.metrics?.modelId);
      const metricsConfig = runtime.expectedModel
        ? { ...config, model: runtime.expectedModel }
        : config;
      const contextWindowMode = runtime.contextWindowMode ?? this.managedChatGptContextWindowMode();
      const displayMetrics = effectiveClaudeMetrics(
        runtime.metrics,
        metricsConfig,
        contextWindowMode,
      );
      const contextUsage = claudeResourceUsage(displayMetrics, metricsConfig, contextWindowMode);
      return {
        active: runtime.active,
        allowBypassPermissions: this.configStore.getAllowBypassPermissions(cwd),
        config: this.configStore.getView(cwd),
        cwd,
        effortCompatibility: runtime.effortCompatibility,
        effortRequest: runtime.effortRequest,
        expectedModel: runtime.expectedModel,
        installation,
        metrics: displayMetrics,
        modelMatches: matches,
        permissionMode: runtime.permissionMode,
        permissionModeRequest: runtime.permissionModeRequest,
        permissionModeCycle: [...runtime.permissionModeCycle],
        ptyGeneration: runtime.ptyGeneration,
        resourceUsage: mergeClaudeResourceUsage(contextUsage, providerUsage),
        routeHealth,
        sessionId,
        stateRevision,
        speed: this.modelSpeedState(runtime, config, installation.version),
        warning: matches
          ? undefined
          : `运行中模型 ${runtime.metrics?.modelId ?? '未知'} 与锁定模型 ${runtime.expectedModel} 不一致。`,
      };
    }
  }

  public async publishProjectState(sessionId: string, cwd: string): Promise<ClaudeProjectState> {
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  public isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active ?? false;
  }

  public ownsLaunch(sessionId: string, launchGeneration: number): boolean {
    const runtime = this.sessions.get(sessionId);
    return Boolean(runtime?.active && runtime.launchGeneration === launchGeneration);
  }

  public bindPty(sessionId: string, ptyGeneration: PtyGeneration): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active) {
      throw new Error('Claude Code 启动状态已失效，无法绑定新的终端。');
    }
    if (runtime.ptyGeneration !== undefined && runtime.ptyGeneration !== ptyGeneration) {
      throw new Error('Claude Code 已绑定到其他终端，这次启动结果已失效。');
    }
    runtime.ptyGeneration = ptyGeneration;
    this.onActivityEvent?.({
      event: 'SessionStart',
      eventId: `launch-${runtime.launchGeneration ?? 0}`,
      launchGeneration: runtime.launchGeneration ?? 0,
      ptyGeneration,
      sessionId,
      signaledAt: Date.now(),
    });
  }

  public isBoundToPty(sessionId: string, ptyGeneration: PtyGeneration): boolean {
    const runtime = this.sessions.get(sessionId);
    return Boolean(runtime?.active && runtime.ptyGeneration === ptyGeneration);
  }

  public writeTerminal(sessionId: string, ptyGeneration: PtyGeneration, data: string): boolean {
    return (
      this.isBoundToPty(sessionId, ptyGeneration) &&
      this.writeToTerminal(sessionId, ptyGeneration, data)
    );
  }

  private requireBoundPty(runtime: RuntimeSession): PtyGeneration {
    const ptyGeneration = runtime.ptyGeneration;
    if (!runtime.active || ptyGeneration === undefined) {
      throw new Error('Claude Code 会话已停止或重启，这次操作已取消。');
    }
    return ptyGeneration;
  }

  private isRuntimePtyCurrent(runtime: RuntimeSession, ptyGeneration: PtyGeneration): boolean {
    return (
      this.sessions.get(runtime.sessionId) === runtime &&
      runtime.active &&
      runtime.ptyGeneration === ptyGeneration
    );
  }

  private isRuntimeLaunchPtyCurrent(
    runtime: RuntimeSession,
    launchGeneration: number,
    ptyGeneration: PtyGeneration,
  ): boolean {
    return (
      this.isRuntimePtyCurrent(runtime, ptyGeneration) &&
      runtime.launchGeneration === launchGeneration
    );
  }

  private assertRuntimePty(runtime: RuntimeSession, ptyGeneration: PtyGeneration): void {
    if (!this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
      throw new Error('Claude Code 会话已停止或重启，这次操作已取消。');
    }
  }

  public getGatewayDiagnostics(cwd: string): Promise<ClaudeGatewayDiagnostics> {
    const config = this.configStore.getConfig(cwd);
    return this.backgroundTasks.run(
      `gateway-diagnostics:${projectKey(cwd)}:${config.baseUrl}`,
      'background',
      () => this.gatewayDetector.detect(cwd, config),
    );
  }

  public getRouterManagementState(): Promise<ClaudeRouterManagementState> {
    return this.getRouterHealthState();
  }

  /** Plain-language verdict on how this project reaches a model, and whether Router matters. */
  public async getConnectionAdvice(cwd: string): Promise<ClaudeConnectionAdvice> {
    const [installation, router] = await Promise.all([
      this.diagnoseInstallation(),
      this.getRouterHealthState(),
    ]);
    return computeClaudeConnectionAdvice(
      this.configStore.getConfig(cwd),
      Boolean(this.configStore.getCredential(cwd)),
      router,
      installation,
    );
  }

  public async installRouterPackage(
    source: ClaudeRouterInstallSource,
  ): Promise<{ message: string; state: ClaudeRouterManagementState }> {
    const result = await this.routerManager.installFromNpm(source);
    this.routerHealthCache.set(result.state);
    this.softwareUpdatesCache.clear();
    return result;
  }

  public async recoverInterruptedRouterInstall(): Promise<void> {
    const result = await this.routerManager.recoverInterruptedInstall();
    if (result) {
      this.routerHealthCache.set(result.state);
      this.softwareUpdatesCache.clear();
    }
  }

  public async stopUnusedRoutingServices(): Promise<void> {
    await Promise.all([this.stopUnusedRoute('ccr'), this.stopUnusedRoute('managed-chatgpt')]);
  }

  public async uninstallRouter(): Promise<{
    message: string;
    state: ClaudeRouterManagementState;
  }> {
    const result = await this.routerManager.uninstall();
    this.routerHealthCache.set(result.state);
    this.softwareUpdatesCache.clear();
    return result;
  }

  public async getSoftwareUpdates(force = false): Promise<SoftwareUpdateState> {
    return this.softwareUpdatesCache.get(async () => {
      const [installation, router] = await Promise.all([
        this.diagnoseInstallation(force),
        this.getRouterHealthState(force),
      ]);
      return this.backgroundTasks.run('software-updates', 'background', () =>
        checkSoftwareUpdates(
          installation,
          router,
          this.applicationVersion,
          this.fetchImplementation,
        ),
      );
    }, force);
  }

  public async installOrUpdateClaudeCode(
    onProgress?: (progress: SoftwareUpdateProgress) => void,
  ): Promise<{
    message: string;
    state: SoftwareUpdateState;
  }> {
    const installation = await this.diagnoseInstallation(true);
    const message = await installOrUpdateClaudeCode(installation, {
      fetchImpl: this.fetchImplementation,
      onProgress,
    });
    this.installationCache.clear();
    this.softwareUpdatesCache.clear();
    return { message, state: await this.getSoftwareUpdates(true) };
  }

  public discoverProviderModels(baseUrl: string, credential?: string): Promise<string[]> {
    return discoverOpenAiModels(baseUrl, credential, this.fetchImplementation);
  }

  public async startRouter(): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.start();
    this.routerHealthCache.set(state);
    return state;
  }

  public async stopRouter(): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.stop();
    this.routerHealthCache.set(state);
    return state;
  }

  public routerManagementUrl(): Promise<string> {
    return this.routerManager.managementUrl();
  }

  public async deleteRouterProvider(providerId: string): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.deleteProvider(providerId);
    this.routerHealthCache.set(state);
    return state;
  }

  public async saveRouterProvider(
    input: SaveClaudeRouterProviderInput,
    assertCurrent: () => void = () => undefined,
  ): Promise<SavedRouterProvider> {
    const saved = await this.routerManager.saveProvider(input);
    assertCurrent();
    this.routerHealthCache.set(saved.state);
    return saved;
  }

  public prepareRouterProjectConfig(saved: SavedRouterProvider): PreparedClaudeConfigSave {
    return {
      historyMetadata: {
        name: saved.provider.name,
        protocol: connectionProtocolForRouterProvider(saved.provider.protocol),
      },
      input: {
        authMode: 'authToken',
        baseUrl: saved.connection.baseUrl,
        credential: saved.connection.apiKey,
        credentialAction: 'replace',
        model: saved.connection.model,
        preset: 'gateway',
        provider: 'gateway',
      },
    };
  }

  public async repairRouterProviderFromProject(
    cwd: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<SavedRouterProvider> {
    // The caller owns the directory transaction before this source profile is read. Keep the exact
    // config/credential pair in memory while CCR management performs its asynchronous work.
    const launchSnapshot = this.configStore.createLaunchSnapshot(cwd);
    const input = routerRepairInputForProject(launchSnapshot.config, launchSnapshot.credential);
    const current = await this.getRouterHealthState(true);
    assertCurrent();
    if (!current.managementAvailable) {
      throw new Error('CCR 管理服务尚未就绪，无法写入服务提供方。');
    }
    if (current.providers.length > 0) {
      throw new Error('CCR 已存在服务提供方；请编辑现有配置或手动选择要使用的服务提供方。');
    }

    const saved = await this.routerManager.saveProvider(input);
    assertCurrent();
    const routerState = await this.routerManager.start();
    assertCurrent();
    this.routerHealthCache.set(routerState);
    if (routerState.gatewayState !== 'running') {
      throw new Error(routerState.message);
    }
    return { ...saved, state: routerState };
  }

  private routeKindForConfig(config: NormalizedClaudeConfig): ClaudeRouteKind {
    if (config.preset === 'chatgpt-subscription') {
      return 'managed-chatgpt';
    }
    return usesDefaultClaudeRouter(config) ? 'ccr' : 'direct';
  }

  private hasActiveRoute(routeKind: ClaudeRouteKind, excludedSessionId?: string): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.sessionId !== excludedSessionId &&
        session.active &&
        session.routeKind === routeKind,
    );
  }

  private async stopUnusedRoute(
    routeKind: ClaudeRouteKind,
    excludedSessionId?: string,
  ): Promise<void> {
    if (routeKind === 'direct') {
      return;
    }
    const stopped = await this.routeLifecycle.stopWhenUnused({
      excludedSessionId,
      hasActiveUser: (candidateRoute, excludedSession) =>
        this.hasActiveRoute(candidateRoute, excludedSession),
      isServiceRunning:
        routeKind === 'ccr'
          ? async () => (await this.routerManager.getState()).serviceRunning
          : async () => true,
      routeKind,
      stop:
        routeKind === 'ccr'
          ? async () => {
              await this.routerManager.stop();
            }
          : async () => {
              await this.stopManagedChatGptGateway();
            },
    });
    if (stopped && routeKind === 'ccr') {
      this.routerHealthCache.clear();
    }
  }

  private async prepareRouteServices(routeKind: ClaudeRouteKind, sessionId: string): Promise<void> {
    if (routeKind === 'managed-chatgpt') {
      await this.routeLifecycle.runExclusive(this.ensureManagedChatGptGatewayReady);
      await this.stopUnusedRoute('ccr', sessionId);
      return;
    }
    if (routeKind === 'ccr') {
      await this.routeLifecycle.runExclusive(async () => {
        let state = await this.routerManager.getState();
        if (!state.installed) {
          state = (await this.routerManager.installFromNpm('npm')).state;
        }
        if (!state.managementAvailable || state.gatewayState !== 'running') {
          state = await this.routerManager.start();
        }
        this.routerHealthCache.set(state);
      });
      await this.stopUnusedRoute('managed-chatgpt', sessionId);
      return;
    }
    await Promise.all([
      this.stopUnusedRoute('ccr', sessionId),
      this.stopUnusedRoute('managed-chatgpt', sessionId),
    ]);
  }

  /**
   * Prepares the same project-owned route and credential environment for the structured Agent SDK
   * lane. The reservation stays live until `releaseNativeConversation` so a PTY teardown cannot
   * stop a shared CCR/managed gateway underneath an active native conversation.
   */
  public async prepareNativeConversation(
    ownerId: string,
    cwd: string,
    requestedModel?: string,
  ): Promise<PreparedNativeClaudeConversation> {
    if (this.nativeRouteReservations.has(ownerId)) {
      throw new Error('该原生会话已经持有接入路由。');
    }
    const launchSnapshot = this.configStore.createLaunchSnapshot(cwd);
    const config = launchSnapshot.config;
    const routeKind = this.routeKindForConfig(config);
    const reservation = this.routeLifecycle.reserve(ownerId, routeKind);
    try {
      const installation = await this.diagnoseInstallation(true);
      if (installation.security !== 'ready') throw new Error(installation.message);
      await this.prepareRouteServices(routeKind, ownerId);
      if (!this.configStore.launchSnapshotIsCurrent(cwd, launchSnapshot)) {
        throw new Error('Claude 接入配置在原生会话启动期间已更新，请重试。');
      }
      const credential = launchSnapshot.credential;
      if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !credential) {
        throw new Error('当前接入需要接口凭据，请先在“接入”页保存密钥。');
      }
      if (usesDefaultClaudeRouter(config)) {
        const router = await this.getRouterHealthState(true);
        const blockingDetail = routerBlockingDetail(config, router);
        if (blockingDetail) throw new Error(blockingDetail);
      }
      const selectedModel = requestedModel ?? config.model;
      if (!MODEL_NAME_PATTERN.test(selectedModel)) throw new Error('模型标识无效。');
      const model = stripClaudeContextWindowSuffix(selectedModel);
      const launchConfig = { ...config, model };
      const speed = this.resolveModelSpeed(launchConfig, model, installation.version);
      const managedContextWindowMode = this.managedChatGptContextWindowMode();
      const claudeContextWindow = this.claudeContextWindow();
      const runtimeModel = resolveClaudeRuntimeModel(
        selectedModel,
        claudeContextWindow.mode,
        claudeContextWindow.customTokens,
      );
      this.nativeRouteReservations.set(ownerId, reservation);
      return {
        allowBypassPermissions: launchSnapshot.allowBypassPermissions,
        cliVersion: installation.version,
        configFingerprint: connectionFingerprint(launchConfig, credential),
        endpointIdentity: `${launchConfig.provider}|${launchConfig.preset}|${launchConfig.baseUrl}`,
        environment: buildClaudeEnvironment(
          launchConfig,
          credential,
          managedContextWindowMode,
          speed.profile,
          claudeContextWindow.mode,
          claudeContextWindow.customTokens,
        ),
        model,
        runtimeModel,
        settingsEnvironment: buildClaudeSettingsEnvironment(
          launchConfig,
          managedContextWindowMode,
          speed.profile,
          claudeContextWindow.mode,
          claudeContextWindow.customTokens,
        ),
      };
    } catch (error) {
      if (this.routeLifecycle.release(reservation)) {
        void this.stopUnusedRoute(routeKind).catch(() => {});
      }
      throw error;
    }
  }

  public releaseNativeConversation(ownerId: string): void {
    const reservation = this.nativeRouteReservations.get(ownerId);
    if (!reservation) return;
    this.nativeRouteReservations.delete(ownerId);
    if (this.routeLifecycle.release(reservation)) {
      void this.stopUnusedRoute(reservation.routeKind).catch(() => {});
    }
  }

  /** Re-checks the project gate before a live native session can enter bypass mode. */
  public allowsBypassPermissions(cwd: string): boolean {
    return this.configStore.getAllowBypassPermissions(cwd);
  }

  public async prepareLaunch(
    sessionId: string,
    cwd: string,
    mode: ClaudeLaunchMode,
    startMode?: ClaudePermissionMode,
  ): Promise<PreparedClaudeLaunch> {
    return this.prepareLaunchInternal(sessionId, cwd, mode, undefined, startMode);
  }

  public async prepareLaunchWithSession(
    sessionId: string,
    cwd: string,
    conversationId: string,
  ): Promise<PreparedClaudeLaunch> {
    return this.prepareLaunchInternal(sessionId, cwd, 'resume', conversationId);
  }

  private async prepareLaunchInternal(
    sessionId: string,
    cwd: string,
    mode: ClaudeLaunchMode,
    resumeSessionId?: string,
    startMode?: ClaudePermissionMode,
    overrides?: ClaudeLaunchOverrides,
    launchSnapshot = this.configStore.createLaunchSnapshot(cwd),
  ): Promise<PreparedClaudeLaunch> {
    const config = launchSnapshot.config;
    const routeKind = this.routeKindForConfig(config);
    const reservation = this.routeLifecycle.reserve(sessionId, routeKind);
    try {
      return await this.prepareLaunchWithReservedRoute(
        sessionId,
        cwd,
        mode,
        config,
        launchSnapshot,
        routeKind,
        resumeSessionId,
        startMode,
        overrides,
      );
    } finally {
      if (this.routeLifecycle.release(reservation)) {
        void this.stopUnusedRoute(routeKind).catch(() => {});
      }
    }
  }

  private async prepareLaunchWithReservedRoute(
    sessionId: string,
    cwd: string,
    mode: ClaudeLaunchMode,
    config: NormalizedClaudeConfig,
    launchSnapshot: ClaudeLaunchConfigSnapshot,
    routeKind: ClaudeRouteKind,
    resumeSessionId?: string,
    startMode?: ClaudePermissionMode,
    overrides?: ClaudeLaunchOverrides,
  ): Promise<PreparedClaudeLaunch> {
    const assertLaunchSnapshotCurrent = (): void => {
      if (!this.configStore.launchSnapshotIsCurrent(cwd, launchSnapshot)) {
        throw new Error('Claude 接入配置在启动准备期间已更新，本次启动已取消，请重试。');
      }
    };
    const installation = await this.diagnoseInstallation(true);
    if (installation.security !== 'ready') {
      throw new Error(installation.message);
    }
    assertLaunchSnapshotCurrent();

    await this.prepareRouteServices(routeKind, sessionId);
    assertLaunchSnapshotCurrent();
    const credential = launchSnapshot.credential;
    if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !credential) {
      throw new Error('当前接入需要接口凭据，请先在“接入”页保存密钥。');
    }
    if (usesDefaultClaudeRouter(config)) {
      const router = await this.getRouterHealthState(true);
      assertLaunchSnapshotCurrent();
      const blockingDetail = routerBlockingDetail(config, router);
      if (blockingDetail) {
        throw new Error(blockingDetail);
      }
    }

    const allowBypass = launchSnapshot.allowBypassPermissions;
    /*
     * Reopening a stored conversation should feel like it never stopped, so the model, permission
     * mode and thinking depth it was last running with win over the project defaults. Bypass is the
     * one exception: it stays gated on the project's own opt-in no matter what was remembered.
     *
     * A `--continue` relaunch keeps the same conversation, so its depth and mode are restored too —
     * but never its model, because a relaunch is how an explicit cross-endpoint switch is applied.
     */
    const resumedConversationId =
      resumeSessionId && isConversationId(resumeSessionId)
        ? resumeSessionId
        : mode === 'continue'
          ? this.sessions.get(sessionId)?.conversationId
          : undefined;
    this.conversationLaunchGuard(cwd, mode, resumedConversationId);
    const remembered = resumedConversationId
      ? this.conversationPreferences.get(resumedConversationId)
      : undefined;
    const rememberedMode =
      remembered?.permissionMode &&
      (remembered.permissionMode !== 'bypassPermissions' || allowBypass)
        ? remembered.permissionMode
        : undefined;
    const effectiveStartMode = startMode ?? rememberedMode;
    const selectedLaunchModel =
      overrides?.model ??
      (mode !== 'continue' && remembered?.model && MODEL_NAME_PATTERN.test(remembered.model)
        ? remembered.model
        : config.model);
    if (!MODEL_NAME_PATTERN.test(selectedLaunchModel)) {
      throw new Error('模型标识不合法，拒绝启动 Claude Code。');
    }
    const launchModel = stripClaudeContextWindowSuffix(selectedLaunchModel);
    const launchConfig = { ...config, model: launchModel };
    const speed = this.resolveModelSpeed(
      launchConfig,
      launchModel,
      installation.version,
      overrides?.speed,
    );
    const contextWindowMode = this.managedChatGptContextWindowMode();
    const claudeContextWindow = this.claudeContextWindow();
    const runtimeModel = resolveClaudeRuntimeModel(
      selectedLaunchModel,
      claudeContextWindow.mode,
      claudeContextWindow.customTokens,
    );

    const launchGeneration = ++this.nextLaunchGeneration;
    const sessionDirectory = path.join(this.runtimeRoot, sessionId);
    const artifactDirectory = path.join(
      sessionDirectory,
      `${RUNTIME_ARTIFACT_DIRECTORY_PREFIX}${this.runtimeLaunchToken}-${launchGeneration}`,
    );
    const metricsPath = path.join(artifactDirectory, 'metrics.json');
    const settingsPath = path.join(artifactDirectory, 'settings.json');
    const signalPath = path.join(artifactDirectory, 'signal.json');
    const turnStopPath = path.join(artifactDirectory, 'turn-stop.json');
    const activityEventsPath = path.join(artifactDirectory, 'events');
    mkdirSync(artifactDirectory, { recursive: true });
    if (this.activityScriptPath) mkdirSync(activityEventsPath, { recursive: true });

    const activityHook = (
      event: string,
    ): { command: string; shell: string; type: string } | undefined =>
      this.activityScriptPath
        ? {
            command: buildRuntimeActivityCommand(
              this.activityScriptPath,
              activityEventsPath,
              event,
              sessionId,
              launchGeneration,
              0,
            ),
            shell: 'powershell',
            type: 'command',
          }
        : undefined;
    const activityHookGroup = (
      event: string,
    ): Array<{ hooks: Array<{ command: string; shell: string; type: string }> }> => {
      const hook = activityHook(event);
      return hook ? [{ hooks: [hook] }] : [];
    };
    const stopActivityHook = activityHook('Stop');
    const permissionEndpoint =
      this.permissionHookScriptPath && this.createPermissionEndpoint
        ? this.createPermissionEndpoint(sessionId, launchGeneration)
        : undefined;
    const permissionRequestHook =
      permissionEndpoint && this.permissionHookScriptPath
        ? {
            command: buildClaudePermissionHookCommand(
              this.permissionHookScriptPath,
              permissionEndpoint.pipeName,
              permissionEndpoint.token,
              sessionId,
              launchGeneration,
            ),
            shell: 'powershell',
            timeout: 600,
            type: 'command',
          }
        : undefined;

    /*
     * Off unless the user turned it on: the guard hook, the subagent definition and the appended
     * system prompt are a workaround for relays that reject web search at higher effort levels, and
     * a relay without that fault should get a plain Claude Code session.
     */
    const webResearchIsolation = this.isWebResearchIsolationEnabled();
    const settings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      ...buildClaudeSpeedSettings(speed.profile),
      ...(shouldDisableInheritedApiKeyHelper(config) ? { apiKeyHelper: '' } : {}),
      env: buildClaudeSettingsEnvironment(
        launchConfig,
        contextWindowMode,
        speed.profile,
        claudeContextWindow.mode,
        claudeContextWindow.customTokens,
      ),
      // Hooks remain session-local because this file is passed through Claude Code's --settings.
      hooks: {
        ...(this.activityScriptPath
          ? {
              SessionEnd: activityHookGroup('SessionEnd'),
              StopFailure: activityHookGroup('StopFailure'),
              SubagentStart: activityHookGroup('SubagentStart'),
              SubagentStop: activityHookGroup('SubagentStop'),
              TaskCompleted: activityHookGroup('TaskCompleted'),
              TaskCreated: activityHookGroup('TaskCreated'),
              UserPromptSubmit: activityHookGroup('UserPromptSubmit'),
            }
          : {}),
        ...(permissionRequestHook
          ? {
              PermissionRequest: [{ hooks: [permissionRequestHook] }],
            }
          : {}),
        PostCompact: [
          {
            hooks: [
              {
                command: buildRuntimeSignalCommand(
                  this.signalScriptPath,
                  signalPath,
                  'PostCompact',
                ),
                shell: 'powershell',
                type: 'command',
              },
            ],
          },
        ],
        ...(webResearchIsolation
          ? {
              PreToolUse: [
                {
                  matcher: 'WebSearch|WebFetch',
                  hooks: [
                    {
                      command: buildWebSearchGuardCommand(
                        this.webSearchGuardScriptPath,
                        CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME,
                      ),
                      shell: 'powershell',
                      type: 'command',
                    },
                  ],
                },
              ],
            }
          : {}),
        Stop: [
          {
            hooks: [
              {
                command: buildRuntimeSignalCommand(this.signalScriptPath, turnStopPath, 'Stop'),
                shell: 'powershell',
                type: 'command',
              },
              ...(stopActivityHook ? [stopActivityHook] : []),
            ],
          },
        ],
      },
      model: runtimeModel,
      skipWebFetchPreflight: true,
      theme: claudeCodeThemeForTerminalTheme(this.currentThemeId),
      statusLine: {
        command: buildStatusLineCommand(this.statusLineScriptPath, metricsPath),
        refreshInterval: 1,
        type: 'command',
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

    const exitMarker = `${String.fromCharCode(27)}]9;claudedock-exit:${sessionId}:${launchGeneration}:${Date.now()}${String.fromCharCode(7)}`;
    const launchCommand = buildClaudeLaunchCommand(
      settingsPath,
      mode,
      exitMarker,
      resumeSessionId,
      { allowBypass, startMode: effectiveStartMode },
      webResearchIsolation
        ? {
            agents: CLAUDEDOCK_WEB_RESEARCH_AGENTS,
            appendSystemPrompt: CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT,
          }
        : {},
    );
    const environment = buildClaudeEnvironment(
      launchConfig,
      credential,
      contextWindowMode,
      speed.profile,
      claudeContextWindow.mode,
      claudeContextWindow.customTokens,
    );
    environment[POWERSHELL_STARTUP_COMMAND_ENV] = launchCommand;

    // Commit the runtime only after every launch artifact has been prepared successfully.
    const previousArtifactDirectory = this.sessions.get(sessionId)?.artifactDirectory;
    const runtime = this.ensureSession(sessionId, cwd);
    const predecessorPtyGeneration = runtime.active ? runtime.ptyGeneration : undefined;
    runtime.active = true;
    runtime.activityEventsPath = this.activityScriptPath ? activityEventsPath : undefined;
    runtime.artifactDirectory = artifactDirectory;
    runtime.claudeContextWindowCustomTokens = claudeContextWindow.customTokens;
    runtime.claudeContextWindowMode = claudeContextWindow.mode;
    runtime.ptyGeneration = undefined;
    runtime.routeKind = routeKind;
    runtime.conversationId = resumedConversationId;
    runtime.contextWindowMode = contextWindowMode;
    runtime.diagnosticBuffer = '';
    runtime.effortCompatibility = undefined;
    runtime.effortRestoreAfterTurn = undefined;
    runtime.effortRestoreInProgress = false;
    // A relaunch re-reads the persisted effort setting, so a session-only request no longer holds.
    runtime.effortRequest = undefined;
    runtime.expectedModel = launchModel;
    runtime.exitMarker = exitMarker;
    runtime.markerRemainder = '';
    runtime.lastApiError = undefined;
    runtime.launchedConfigFingerprint = connectionFingerprint(config, credential);
    runtime.launchedAt = Date.now();
    runtime.launchedCliVersion = installation.version;
    runtime.launchGeneration = launchGeneration;
    runtime.launchedSpeedPreference = speed.preference;
    runtime.launchedSpeedSignature = speed.signature;
    runtime.launchedSpeedTargetKey = speed.targetKey;
    runtime.metrics = undefined;
    runtime.metricsPath = metricsPath;
    runtime.runtimeModel = runtimeModel;
    // `/effort` cannot ride the launch command, so it is replayed once the new TUI is listening.
    runtime.pendingEffortRestore = remembered?.effort;
    runtime.pendingEffortRestoreAt = remembered?.effort
      ? Date.now() + EFFORT_RESTORE_DELAY_MS
      : undefined;
    runtime.settingsPath = settingsPath;
    runtime.thinkingEnabledForHighEffort = false;
    runtime.turnStopPath = turnStopPath;
    runtime.turnStopSeenAt = undefined;
    // A relaunch paints a fresh TUI, so nothing observed in the previous one still holds.
    runtime.permissionMode = effectiveStartMode;
    runtime.permissionModeRequest = effectiveStartMode;
    runtime.permissionModeCycle = effectiveStartMode ? [effectiveStartMode] : [];
    runtime.signalPath = signalPath;
    runtime.signalSeenAt = undefined;
    runtime.waitingForCompact = undefined;

    this.cleanupObsoleteLaunchArtifacts(
      sessionDirectory,
      artifactDirectory,
      previousArtifactDirectory,
    );
    return {
      command: POWERSHELL_STARTUP_TRIGGER,
      environment,
      predecessorPtyGeneration,
    };
  }

  /** Removes only a bounded sample of artifacts that no live launch can read anymore. */
  private cleanupObsoleteLaunchArtifacts(
    sessionDirectory: string,
    currentArtifactDirectory: string,
    previousArtifactDirectory?: string,
  ): void {
    for (const legacyName of LEGACY_RUNTIME_ARTIFACT_NAMES) {
      try {
        unlinkSync(path.join(sessionDirectory, legacyName));
      } catch {
        // A missing or locked legacy artifact is harmless because no launch reads shared paths now.
      }
    }

    let directory: ReturnType<typeof opendirSync> | undefined;
    try {
      directory = opendirSync(sessionDirectory);
      let examined = 0;
      let removed = 0;
      while (
        examined < RUNTIME_ARTIFACT_CLEANUP_SCAN_LIMIT &&
        removed < RUNTIME_ARTIFACT_CLEANUP_REMOVE_LIMIT
      ) {
        const entry = directory.readSync();
        if (!entry) {
          break;
        }
        examined += 1;
        if (!entry.isDirectory() || !entry.name.startsWith(RUNTIME_ARTIFACT_DIRECTORY_PREFIX)) {
          continue;
        }
        const candidate = path.join(sessionDirectory, entry.name);
        if (candidate === currentArtifactDirectory || candidate === previousArtifactDirectory) {
          continue;
        }
        try {
          rmSync(candidate, { force: true, recursive: true });
          removed += 1;
        } catch {
          // A delayed hook may still hold or recreate an old directory; a later launch retries.
        }
      }
    } catch {
      // Cleanup never makes a successfully prepared launch fail.
    } finally {
      try {
        directory?.closeSync();
      } catch {
        // Closing a best-effort cleanup iterator cannot affect the launch.
      }
    }
  }

  public async prepareConnectionConfig(
    input: SaveClaudeConfigInput,
    historyName?: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedClaudeConfigSave> {
    if (input.protocol !== 'openai') {
      return {
        historyMetadata: {
          ...(historyName ? { name: historyName } : {}),
          protocol: input.protocol ?? defaultConnectionProtocolForPreset(input.preset),
        },
        input,
      };
    }

    const prepared = await this.prepareOpenAiConnection(input, assertCurrent);
    assertCurrent();
    return {
      historyMetadata: {
        ...prepared.historyMetadata,
        ...(historyName ? { name: historyName } : {}),
      },
      input: prepared.effectiveInput,
      presentation: prepared.presentation,
    };
  }

  /** Reads and prepares one history replay without changing the project profile. */
  public async prepareConnectionHistory(
    cwd: string,
    entryId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedClaudeConfigSave> {
    const replay = this.historyStore.toReplayInput(cwd, entryId);
    assertCurrent();
    if (replay.config.protocol === 'openai') {
      return this.prepareConnectionConfig(replay.config, replay.name, assertCurrent);
    }
    return {
      historyMetadata: {
        name: replay.name,
        protocol: replay.protocol,
      },
      input: replay.config,
    };
  }

  /** The only project-route persistence point; callers hold the directory transaction here. */
  public commitPreparedConfig(cwd: string, prepared: PreparedClaudeConfigSave): void {
    this.configStore.save(cwd, prepared.input, prepared.presentation);
  }

  /** Performs fallible post-commit work while the caller still owns the tentative profile. */
  public async completePreparedConfigSave(
    sessionId: string,
    cwd: string,
    prepared: PreparedClaudeConfigSave,
  ): Promise<ClaudeProjectState> {
    await this.recordConnectionHistory(cwd, prepared.input, prepared.historyMetadata);
    const runtime = this.ensureSession(sessionId, cwd);
    if (!runtime.active) {
      await this.prepareRouteServices(
        this.routeKindForConfig(this.configStore.getConfig(cwd)),
        sessionId,
      );
    }
    return this.publishProjectState(sessionId, cwd);
  }

  public getConnectionHistory(cwd: string): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.list(cwd);
  }

  public deleteConnectionHistory(cwd: string, entryId: string): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.remove(cwd, entryId);
  }

  public renameConnectionHistory(
    cwd: string,
    entryId: string,
    name: string,
  ): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.rename(cwd, entryId, name);
  }

  /**
   * Everything the status-bar picker can offer: the model this project is configured with, plus one
   * entry per saved connection. Entries that keep the current endpoint switch inside the live
   * conversation; the rest need a relaunch because base URL and credential are PTY-spawn variables.
   */
  public async getModelOptions(cwd: string, sessionId?: string): Promise<ClaudeModelOptions> {
    const config = this.configStore.getConfig(cwd);
    const runtime = sessionId ? this.sessions.get(sessionId) : undefined;
    const installation = await this.diagnoseInstallation();
    const activeModel = runtime?.expectedModel ?? runtime?.metrics?.modelId ?? config.model;
    const launchedSignature = runtime?.launchedSpeedSignature ?? 'standard';
    const relaunchMetadata = (
      targetConfig: NormalizedClaudeConfig,
      sameEndpoint: boolean,
    ): Pick<ClaudeModelOption, 'relaunchReason' | 'requiresRelaunch'> => {
      if (!sameEndpoint) {
        return { relaunchReason: 'connection', requiresRelaunch: true };
      }
      const targetSpeed = this.resolveModelSpeed(
        targetConfig,
        targetConfig.model,
        installation.version,
      );
      return runtime?.active && targetSpeed.signature !== launchedSignature
        ? { relaunchReason: 'speed-profile', requiresRelaunch: true }
        : { requiresRelaunch: false };
    };
    const options: ClaudeModelOption[] = [
      {
        id: 'current',
        label: config.model,
        model: config.model,
        providerLabel: '当前接入',
        ...relaunchMetadata(config, true),
        sameEndpoint: true,
      },
    ];

    const seen = new Set([`${endpointKey(config)}|${config.model}`]);
    for (const entry of this.historyStore.list(cwd)) {
      const sameEndpoint = endpointKey(entry) === endpointKey(config);
      const key = `${endpointKey(entry)}|${entry.model}`;
      if (seen.has(key) || !MODEL_NAME_PATTERN.test(entry.model)) {
        continue;
      }
      seen.add(key);
      const entryConfig: NormalizedClaudeConfig = {
        apiKeyHelperPolicy: entry.apiKeyHelperPolicy,
        authMode: entry.authMode,
        baseUrl: entry.baseUrl,
        model: entry.model,
        modelFast: entry.modelFast,
        preset: entry.preset,
        provider: entry.provider,
      };
      options.push({
        entryId: entry.id,
        id: `history:${entry.id}`,
        label: entry.model,
        model: entry.model,
        providerLabel: describeEndpoint(entry),
        ...relaunchMetadata(entryConfig, sameEndpoint),
        sameEndpoint,
      });
    }

    return { activeModel: stripClaudeContextWindowSuffix(activeModel), options };
  }

  /**
   * Same-endpoint switch: `/model` applies immediately inside the running conversation. The model
   * is re-validated here rather than trusted from the renderer, because this writes to a live shell.
   */
  public async switchModel(
    sessionId: string,
    cwd: string,
    optionId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);

    const option = (await this.getModelOptions(cwd, sessionId)).options.find(
      (candidate) => candidate.id === optionId,
    );
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    if (!option) {
      throw new Error('这个模型选项已经失效，请重新打开列表。');
    }
    if (option.requiresRelaunch) {
      throw new Error(
        option.relaunchReason === 'speed-profile'
          ? '这个模型保存的服务速度配置与当前 PowerShell 不同，需要重启会话才能切换。'
          : '这个模型属于其他接入端点，需要重启会话才能切换。',
      );
    }
    if (!MODEL_NAME_PATTERN.test(option.model)) {
      throw new Error('模型标识不合法，拒绝写入终端。');
    }
    const canonicalModel = stripClaudeContextWindowSuffix(option.model);
    if (!MODEL_NAME_PATTERN.test(canonicalModel)) {
      throw new Error('模型标识不合法，拒绝写入终端。');
    }
    const installation = await this.diagnoseInstallation();
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    const targetSpeed = this.resolveModelSpeed(
      { ...this.configStore.getConfig(cwd), model: canonicalModel },
      canonicalModel,
      installation.version,
    );
    const runtimeModel = resolveClaudeRuntimeModel(
      option.model,
      runtime.claudeContextWindowMode ?? 'auto',
      runtime.claudeContextWindowCustomTokens,
    );

    await this.submitClaudeCommand(runtime, `/model ${runtimeModel}`, assertCurrent);
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    runtime.expectedModel = canonicalModel;
    runtime.runtimeModel = runtimeModel;
    runtime.launchedSpeedPreference = targetSpeed.preference;
    runtime.launchedSpeedSignature = targetSpeed.signature;
    runtime.launchedSpeedTargetKey = targetSpeed.targetKey;
    runtime.diagnosticBuffer = '';
    runtime.effortCompatibility = undefined;
    runtime.effortRestoreAfterTurn = undefined;
    if (runtime.lastApiError?.category === 'effort-thinking-disabled') {
      runtime.lastApiError = undefined;
    }
    this.captureConversationPreferences(runtime);
    const state = await this.getState(sessionId, cwd);
    this.assertRuntimePty(runtime, ptyGeneration);
    this.onState(state);
    return state;
  }

  /**
   * `/effort` applies inside the running conversation, so no relaunch is needed for any level. The
   * requested value is remembered until the status line reports what Claude Code actually applied:
   * a model that does not support the level silently falls back to the highest one it does support,
   * and `ultracode` reports back as plain `xhigh`.
   */
  public async setEffort(
    sessionId: string,
    cwd: string,
    effort: ClaudeEffortRequest,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);
    if (!CLAUDE_EFFORT_REQUESTS.has(effort)) {
      throw new Error('思考程度标识不合法，拒绝写入终端。');
    }
    if (runtime.effortCompatibility && !isClaudeEffortSafeAfterThinkingDisabledError(effort)) {
      throw new Error(
        '当前会话已检测到高档思考与 thinking 关闭冲突；为避免请求再次失败，只能选择“均衡”或更低档位。',
      );
    }
    if (!isClaudeEffortSafeAfterThinkingDisabledError(effort)) {
      this.enableThinkingForHighEffort(runtime);
    }

    await this.submitClaudeCommand(runtime, `/effort ${effort}`);
    this.assertRuntimePty(runtime, ptyGeneration);
    runtime.effortRequest = effort;
    // A relaunch of this conversation should come back at the depth just chosen, not the default.
    runtime.pendingEffortRestore = undefined;
    runtime.pendingEffortRestoreAt = undefined;
    if (runtime.effortCompatibility) {
      runtime.effortCompatibility = {
        ...runtime.effortCompatibility,
        recovery: 'recovered',
      };
    }
    this.captureConversationPreferences(runtime);
    const state = await this.getState(sessionId, cwd);
    this.assertRuntimePty(runtime, ptyGeneration);
    this.onState(state);
    return state;
  }

  /**
   * Runs a command that has already passed the main-process command/argument whitelist. Keeping the
   * actual PTY submission here gives model switching, compaction, and command-palette actions the
   * same ordering and stale-session guarantees.
   */
  public async runCommand(
    sessionId: string,
    cwd: string,
    commandLine: string,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);
    await this.submitClaudeCommand(runtime, commandLine);
    this.assertRuntimePty(runtime, ptyGeneration);
    const state = await this.getState(sessionId, cwd);
    this.assertRuntimePty(runtime, ptyGeneration);
    this.onState(state);
    return state;
  }

  public async saveModelSpeedPreference(
    sessionId: string,
    cwd: string,
    mode: ModelSpeedMode,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    if (runtime.active) {
      throw new Error('Claude Code 正在运行；调整服务速度需要精确恢复当前对话。');
    }
    const launchSnapshot = this.configStore.createLaunchSnapshot(cwd);
    const { config } = launchSnapshot;
    const installation = await this.diagnoseInstallation();
    if (!this.configStore.launchSnapshotIsCurrent(cwd, launchSnapshot)) {
      throw new Error('Claude 接入配置在保存速度偏好期间已更新，请重试。');
    }
    const resolved = this.resolveModelSpeed(config, config.model, installation.version, mode);
    this.modelSpeedPreferences.set(resolved.targetKey, mode);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  public async prepareModelSpeedRelaunch(
    sessionId: string,
    cwd: string,
    mode: ModelSpeedMode,
  ): Promise<PreparedClaudeSpeedRelaunch> {
    const runtime = this.ensureSession(sessionId, cwd);
    if (!runtime.active) {
      throw new Error('Claude Code 尚未运行；请直接保存下次启动使用的服务速度。');
    }
    const conversationId = runtime.metrics?.sessionId ?? runtime.conversationId;
    if (!conversationId || !isConversationId(conversationId)) {
      throw new Error('当前对话尚未上报可恢复的会话标识，请稍候再调整服务速度。');
    }
    const launchSnapshot = this.configStore.createLaunchSnapshot(cwd);
    const { config } = launchSnapshot;
    const installation = await this.diagnoseInstallation();
    if (!this.configStore.launchSnapshotIsCurrent(cwd, launchSnapshot)) {
      throw new Error('Claude 接入配置在速度切换准备期间已更新，请重试。');
    }
    const model = this.modelForSpeedPreference(runtime, config, installation.version);
    const resolved = this.resolveModelSpeed(config, model, installation.version, mode);
    const prepared = await this.prepareLaunchInternal(
      sessionId,
      cwd,
      'resume',
      conversationId,
      undefined,
      { model, speed: mode },
      launchSnapshot,
    );
    return {
      ...prepared,
      preference: resolved.preference,
      targetKey: resolved.targetKey,
    };
  }

  public async commitModelSpeedPreference(
    sessionId: string,
    cwd: string,
    targetKey: string,
    mode: ModelSpeedMode,
  ): Promise<ClaudeProjectState> {
    this.modelSpeedPreferences.set(targetKey, mode);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  /** Completes the optional live `/compact` before a relaunch; it never mutates the project profile. */
  public async compactBeforeRelaunch(
    sessionId: string,
    cwd: string,
    compactFirst: boolean,
    assertCurrent: () => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = this.ensureSession(sessionId, cwd);
    assertCurrent();
    if (compactFirst && runtime.active) {
      await this.compactAndWait(runtime, assertCurrent, signal);
      assertCurrent();
    }
  }

  /**
   * Walks the Shift+Tab cycle one press at a time, taking an on-demand xterm snapshot before and
   * after every press. A passive output event is not a sufficient barrier: it can be delayed, and
   * Shift+Tab is contextual when Claude is showing a picker or confirmation dialog. If the badge is
   * not currently visible, no key is sent. Re-visiting a mode proves the live cycle is exhausted.
   */
  public async setPermissionMode(
    sessionId: string,
    cwd: string,
    mode: ClaudePermissionMode,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);
    if (mode === 'dontAsk') {
      throw new Error('「仅预批准」不在 Shift+Tab 循环内，需要重启会话才能进入。');
    }
    if (mode === 'bypassPermissions' && !this.configStore.getAllowBypassPermissions(cwd)) {
      throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
    }
    if (this.modeSwitchLocks.has(sessionId)) {
      throw new Error('上一次模式切换还没有完成，请稍候。');
    }

    this.modeSwitchLocks.add(sessionId);
    runtime.permissionModeRequest = mode;
    void this.emitState(runtime);
    try {
      const current = await this.readPermissionModeFromScreen(sessionId, ptyGeneration);
      this.assertRuntimePty(runtime, ptyGeneration);
      if (!current) {
        throw new Error(
          '当前终端没有显示权限模式徽标。请先关闭 Claude Code 的选择器或确认框，回到主输入界面后重试。',
        );
      }
      this.recordPermissionMode(runtime, current);
      if (current === mode) {
        const state = await this.getState(sessionId, cwd);
        this.assertRuntimePty(runtime, ptyGeneration);
        return state;
      }

      const visited = new Set<ClaudePermissionMode>([current]);
      for (let step = 0; step < PERMISSION_MODE_MAX_STEPS; step += 1) {
        const before = runtime.permissionMode ?? current;
        if (!this.writeToTerminal(sessionId, ptyGeneration, SHIFT_TAB_SEQUENCE)) {
          throw new Error('Claude Code 会话已停止或重启，这次模式切换已取消。');
        }
        const changed = await this.waitForPermissionModeChange(runtime, ptyGeneration, before);
        this.assertRuntimePty(runtime, ptyGeneration);
        if (!changed) {
          throw new Error(
            '当前终端没有确认这次模式切换，已停止继续按键以避免切到错误模式。请回到 Claude Code 主输入界面后重试；若刚进入「完全允许」，请先在终端完成 Claude Code 自己的免责确认。',
          );
        }
        this.recordPermissionMode(runtime, changed);
        if (changed === mode) {
          const state = await this.getState(sessionId, cwd);
          this.assertRuntimePty(runtime, ptyGeneration);
          this.onState(state);
          return state;
        }
        if (visited.has(changed)) {
          throw new Error('该模式不在当前会话的可用循环中。');
        }
        visited.add(changed);
      }
      throw new Error('该模式不在当前会话的可用循环中。');
    } finally {
      if (runtime.permissionMode !== mode) {
        runtime.permissionModeRequest = undefined;
        void this.emitState(runtime);
      }
      this.modeSwitchLocks.delete(sessionId);
    }
  }

  public commitAllowBypassPermissions(cwd: string, allowed: boolean): void {
    this.configStore.setAllowBypassPermissions(cwd, allowed);
  }

  /**
   * Accepts the badge reconstructed by xterm. Claude Code normally repaints only changed cells, so
   * the complete viewport is the reliable source after a Shift+Tab step.
   */
  public observePermissionModeFromScreen(
    sessionId: string,
    cwd: string,
    ptyGeneration: PtyGeneration,
    mode: ClaudePermissionMode,
  ): void {
    const runtime = this.ensureSession(sessionId, cwd);
    if (this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
      this.recordPermissionMode(runtime, mode);
    }
  }

  /** A full raw repaint remains a useful startup fallback before xterm reports its first screen. */
  private observePermissionModeFromRawOutput(runtime: RuntimeSession): void {
    if (runtime.permissionMode !== undefined) {
      return;
    }
    const mode = parseClaudePermissionMode(runtime.diagnosticBuffer);
    if (mode) {
      this.recordPermissionMode(runtime, mode);
    }
  }

  private recordPermissionMode(runtime: RuntimeSession, mode: ClaudePermissionMode): void {
    if (mode === runtime.permissionMode) {
      return;
    }
    runtime.permissionMode = mode;
    if (!runtime.permissionModeCycle.includes(mode)) {
      runtime.permissionModeCycle.push(mode);
    }
    this.captureConversationPreferences(runtime);
    void this.emitState(runtime);
  }

  /**
   * Mirrors the live status bar into per-conversation storage. Reopening the conversation from the
   * history list then restores exactly what it was running with, instead of the project defaults.
   */
  private captureConversationPreferences(runtime: RuntimeSession): void {
    const conversationId = runtime.metrics?.sessionId ?? runtime.conversationId;
    if (!conversationId || !isConversationId(conversationId)) {
      return;
    }
    runtime.conversationId = conversationId;
    const model = runtime.metrics?.modelId ?? runtime.expectedModel;
    this.conversationPreferences.record(conversationId, {
      effort: runtime.effortRequest ?? runtime.metrics?.effortLevel,
      model: model ? stripClaudeContextWindowSuffix(model) : undefined,
      permissionMode: runtime.permissionMode,
    });
  }

  /**
   * Sends the depth remembered for a resumed conversation, once and only once the status line proves
   * the TUI is alive and reports something different from what was asked for.
   */
  private replayRememberedEffort(runtime: RuntimeSession): void {
    const desired = runtime.pendingEffortRestore;
    const ptyGeneration = runtime.ptyGeneration;
    if (!desired || !runtime.active || ptyGeneration === undefined) {
      return;
    }
    if (runtime.pendingEffortRestoreAt && Date.now() < runtime.pendingEffortRestoreAt) {
      return;
    }
    runtime.pendingEffortRestore = undefined;
    runtime.pendingEffortRestoreAt = undefined;
    if (runtime.metrics?.effortLevel === desired) {
      runtime.effortRequest = desired;
      return;
    }
    void (async () => {
      try {
        if (!isClaudeEffortSafeAfterThinkingDisabledError(desired)) {
          this.enableThinkingForHighEffort(runtime);
        }
        await this.submitClaudeCommand(runtime, `/effort ${desired}`);
        this.assertRuntimePty(runtime, ptyGeneration);
        runtime.effortRequest = desired;
        await this.emitState(runtime);
        this.assertRuntimePty(runtime, ptyGeneration);
      } catch {
        // Restoring the remembered depth is best effort; the session still runs at its default.
      }
    })();
  }

  private waitForPermissionModeChange(
    runtime: RuntimeSession,
    ptyGeneration: PtyGeneration,
    before: ClaudePermissionMode | undefined,
  ): Promise<ClaudePermissionMode | undefined> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const probe = async (): Promise<void> => {
        try {
          this.assertRuntimePty(runtime, ptyGeneration);
          const observed = await this.readPermissionModeFromScreen(
            runtime.sessionId,
            ptyGeneration,
          );
          this.assertRuntimePty(runtime, ptyGeneration);
          if (observed && observed !== before) {
            resolve(observed);
            return;
          }
          if (Date.now() - startedAt >= PERMISSION_MODE_STEP_TIMEOUT_MS) {
            resolve(undefined);
            return;
          }
          setTimeout(() => {
            void probe();
          }, PERMISSION_MODE_PROBE_INTERVAL_MS);
        } catch (error) {
          reject(error);
        }
      };
      void probe();
    });
  }

  /**
   * Issues `/compact` and waits for the PostCompact hook. A timeout is not fatal — the relaunch is
   * still safe, it just carries the un-compacted history — so the caller is never blocked.
   */
  private async compactAndWait(
    runtime: RuntimeSession,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const ptyGeneration = this.requireBoundPty(runtime);
    let abortListener: (() => void) | undefined;
    let finish!: (error?: unknown) => void;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let waiter: RuntimeSession['waitingForCompact'];
    const compacted = new Promise<unknown | undefined>((resolve) => {
      finish = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener);
        }
        if (runtime.waitingForCompact === waiter) {
          runtime.waitingForCompact = undefined;
        }
        resolve(error);
      };
      waiter = () => {
        finish();
      };
      runtime.waitingForCompact = waiter;
      timer = setTimeout(() => {
        finish();
      }, COMPACT_TIMEOUT_MS);
      timer.unref?.();
      if (signal) {
        abortListener = () => {
          finish(signal.reason ?? new Error('这次重启操作已取消。'));
        };
        if (signal.aborted) {
          abortListener();
        } else {
          signal.addEventListener('abort', abortListener, { once: true });
        }
      }
    });
    try {
      assertCurrent();
      await this.submitClaudeCommand(runtime, `/compact ${COMPACT_INSTRUCTION}`, assertCurrent);
      const compactError = await compacted;
      if (compactError !== undefined) {
        throw compactError;
      }
      assertCurrent();
      this.assertRuntimePty(runtime, ptyGeneration);
    } catch (error) {
      finish(error);
      const cancellationReason = signal?.reason;
      throw signal?.aborted && cancellationReason instanceof Error ? cancellationReason : error;
    }
  }

  /**
   * Claude Code's TUI treats command text and a trailing return received in one PTY chunk as a
   * paste, which can leave `/model ...` sitting in the input box forever. Queue complete submissions
   * per session, then write the return separately after the shared TUI-safe gap.
   */
  private submitClaudeCommand(
    runtime: RuntimeSession,
    commandLine: string,
    assertCurrent?: () => void,
  ): Promise<void> {
    const { sessionId } = runtime;
    const ptyGeneration = this.requireBoundPty(runtime);
    const previous = this.commandSubmissionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        let writeFailed = false;
        const isCurrentSession = (): boolean => {
          try {
            assertCurrent?.();
          } catch {
            return false;
          }
          return !writeFailed && this.isRuntimePtyCurrent(runtime, ptyGeneration);
        };
        const submitted = await writeTerminalSubmission(
          buildTerminalSubmission(commandLine),
          (data) => {
            if (!this.writeToTerminal(sessionId, ptyGeneration, data)) {
              writeFailed = true;
            }
          },
          isCurrentSession,
        );
        if (!submitted || writeFailed) {
          throw new Error('Claude Code 会话已停止或重启，已取消这次命令。');
        }
        this.assertRuntimePty(runtime, ptyGeneration);
      });
    this.commandSubmissionQueues.set(sessionId, current);
    return current.finally(() => {
      if (this.commandSubmissionQueues.get(sessionId) === current) {
        this.commandSubmissionQueues.delete(sessionId);
      }
    });
  }

  /** Builds the real Claude Code route for an OpenAI-compatible upstream. */
  private async prepareOpenAiConnection(
    input: SaveClaudeConfigInput,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedOpenAiConnection> {
    if (input.authMode !== 'authToken' && input.authMode !== 'none') {
      throw new Error('OpenAI 协议请选择 Bearer 密钥或无需认证。');
    }
    const model = input.model.trim();
    const modelFast = input.modelFast?.trim() || model;
    if (!MODEL_NAME_PATTERN.test(model) || !MODEL_NAME_PATTERN.test(modelFast)) {
      throw new Error('模型标识只能包含字母、数字以及 . _ : / @ [ ] ~ -。');
    }
    const endpoint = completeConnectionEndpoint(input.baseUrl, 'openai');
    const protocol = routerProtocolForOpenAiEndpoint(endpoint);

    let routerState = await this.routerManager.getState();
    assertCurrent();
    if (!routerState.installed) {
      const installed = await this.routerManager.installFromNpm('npm');
      assertCurrent();
      routerState = installed.state;
      this.softwareUpdatesCache.clear();
    }
    if (!routerState.managementAvailable) {
      let startError: unknown;
      try {
        routerState = await this.routerManager.start();
      } catch (error) {
        startError = error;
        routerState = await this.routerManager.getState();
      }
      assertCurrent();
      if (!routerState.managementAvailable) {
        throw new Error(
          startError instanceof Error
            ? `OpenAI 协议需要本地 Router 完成格式转换：${startError.message}`
            : 'OpenAI 协议需要先安装并启动本地 Router。',
        );
      }
    }

    const sameEndpoint = (candidate: ClaudeRouterManagementState['providers'][number]): boolean => {
      if (candidate.protocol !== protocol) {
        return false;
      }
      try {
        return completeConnectionEndpoint(candidate.baseUrl, 'openai') === endpoint;
      } catch {
        return false;
      }
    };
    const existing =
      routerState.providers.find((candidate) => candidate.id === input.routerProviderId) ??
      routerState.providers.find(sameEndpoint);
    const enteredCredential = input.credential?.trim();
    const credentialAction =
      input.authMode === 'none' || input.credentialAction === 'clear'
        ? 'clear'
        : enteredCredential
          ? 'replace'
          : 'keep';
    if (
      credentialAction === 'keep' &&
      input.authMode !== 'none' &&
      !existing?.credentialConfigured
    ) {
      throw new Error('这个 OpenAI 中转站还没有保存接口密钥，请填写后再继续。');
    }

    const saved = await this.routerManager.saveProvider({
      apiKey: enteredCredential,
      baseUrl: endpoint,
      credentialAction,
      id: existing?.id,
      makePreferred: true,
      models: [...new Set([model, modelFast])],
      name: existing?.name ?? customRouterProviderName(endpoint),
      protocol,
      useForCurrentProject: false,
    });
    assertCurrent();
    routerState = await this.routerManager.start();
    assertCurrent();
    this.routerHealthCache.set(routerState);
    if (routerState.gatewayState !== 'running') {
      throw new Error(`本地 Router 未能启动模型网关：${routerState.message}`);
    }

    const sourceCredentialConfigured =
      credentialAction === 'replace' ||
      (credentialAction === 'keep' && Boolean(existing?.credentialConfigured));
    const sourceConfig: SaveClaudeConfigInput = {
      ...input,
      baseUrl: endpoint,
      credential: undefined,
      credentialAction: 'keep',
      protocol: 'openai',
      routerProviderId: saved.provider.id,
    };
    return {
      effectiveInput: {
        apiKeyHelperPolicy: input.apiKeyHelperPolicy,
        authMode: 'authToken',
        baseUrl: saved.connection.baseUrl,
        credential: saved.connection.apiKey,
        credentialAction: 'replace',
        model: `${saved.provider.name}/${model}`,
        modelFast: `${saved.provider.name}/${modelFast}`,
        preset: 'custom',
        provider: 'gateway',
      },
      historyMetadata: {
        name: saved.provider.name,
        protocol: 'openai',
        routerProviderId: saved.provider.id,
        sourceConfig,
        sourceCredential: credentialAction === 'replace' ? enteredCredential : undefined,
        sourceCredentialConfigured,
      },
      presentation: {
        protocol: 'openai',
        routerProviderId: saved.provider.id,
        sourceAuthMode: input.authMode,
        sourceBaseUrl: endpoint,
        sourceCredentialConfigured,
        sourceModel: model,
        sourceModelFast: modelFast,
      },
    };
  }

  private async recordConnectionHistory(
    cwd: string,
    input: SaveClaudeConfigInput,
    metadata?: ConnectionHistoryMetadata,
  ): Promise<void> {
    try {
      const router = await this.getRouterHealthState();
      this.historyStore.record(cwd, {
        config: input,
        credential: metadata?.sourceConfig
          ? metadata.sourceCredential
          : this.configStore.getCredential(cwd),
        gatewayEndpoint: router.endpoint,
        gatewayState: router.gatewayState,
        name: metadata?.name,
        protocol: metadata?.protocol ?? defaultConnectionProtocolForPreset(input.preset),
        routerProviderId: metadata?.routerProviderId,
        sourceConfig: metadata?.sourceConfig,
        sourceCredentialConfigured: metadata?.sourceCredentialConfigured,
      });
    } catch {
      // The configuration is already saved; a missing history entry is not worth failing over.
    }
  }

  public async testConnection(
    cwd: string,
    input: SaveClaudeConfigInput,
  ): Promise<ClaudeConnectionTestResult> {
    const prepared =
      input.protocol === 'openai' ? await this.prepareOpenAiConnection(input) : undefined;
    const testInput = prepared?.effectiveInput ?? input;
    const config = normalizeClaudeConfig(testInput);
    const enteredCredential = testInput.credential?.trim();
    const credential = enteredCredential || this.configStore.getCredential(cwd);
    const fingerprint = connectionFingerprint(config, credential);
    const result = await this.backgroundTasks.run(
      `connection-test:${projectKey(cwd)}:${fingerprint}`,
      'interactive',
      () => testClaudeConnection(config, credential),
    );
    this.connectionChecks.set(projectKey(cwd), {
      fingerprint,
      result,
    });
    return result;
  }

  public setInactive(sessionId: string, expectedGeneration: PtyGeneration): boolean {
    const runtime = this.sessions.get(sessionId);
    if (
      !runtime?.active ||
      expectedGeneration === undefined ||
      runtime.ptyGeneration !== expectedGeneration
    ) {
      return false;
    }
    return this.deactivateRuntime(runtime);
  }

  public cleanupPreparedLaunch(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active || runtime.ptyGeneration !== undefined) {
      return false;
    }
    return this.deactivateRuntime(runtime);
  }

  private deactivateRuntime(runtime: RuntimeSession): boolean {
    const waitingForCompact = runtime.waitingForCompact;
    this.emitSyntheticSessionEnd(runtime);
    runtime.active = false;
    runtime.launchGeneration = undefined;
    runtime.permissionModeRequest = undefined;
    runtime.ptyGeneration = undefined;
    runtime.exitMarker = undefined;
    runtime.markerRemainder = '';
    runtime.waitingForCompact = undefined;
    waitingForCompact?.(0);
    if (runtime.routeKind) {
      void this.stopUnusedRoute(runtime.routeKind).catch(() => {});
    }
    void this.emitState(runtime);
    return true;
  }

  private emitSyntheticSessionEnd(runtime: RuntimeSession): void {
    if (runtime.launchGeneration === undefined || runtime.ptyGeneration === undefined) return;
    this.onActivityEvent?.({
      event: 'SessionEnd',
      eventId: `session-end-${Date.now()}`,
      launchGeneration: runtime.launchGeneration,
      ptyGeneration: runtime.ptyGeneration,
      sessionId: runtime.sessionId,
      signaledAt: Date.now(),
    });
  }

  public shutdown(): void {
    clearInterval(this.metricsTimer);
    this.sessions.clear();
    this.commandSubmissionQueues.clear();
    this.routeLifecycle.clear();
  }

  /**
   * High effort is only useful when Claude Code keeps thinking enabled for the request. The
   * command-line settings file is session-local and contains no credential, so it can be updated
   * without changing the user's Claude Code configuration.
   */
  private enableThinkingForHighEffort(runtime: RuntimeSession): void {
    if (runtime.thinkingEnabledForHighEffort || !runtime.settingsPath) {
      return;
    }

    const temporaryPath = `${runtime.settingsPath}.thinking-${process.pid}.tmp`;
    try {
      const parsed: unknown = JSON.parse(readFileSync(runtime.settingsPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      const settings = parsed as Record<string, unknown>;
      if (settings.alwaysThinkingEnabled !== true) {
        writeFileSync(
          temporaryPath,
          `${JSON.stringify({ ...settings, alwaysThinkingEnabled: true }, null, 2)}\n`,
          'utf8',
        );
        renameSync(temporaryPath, runtime.settingsPath);
      }
      runtime.thinkingEnabledForHighEffort = true;
    } catch {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
      // The runtime fallback still catches the precise API error and safely lowers effort.
    }
  }

  private async recoverEffortAfterThinkingDisabled(
    runtime: RuntimeSession,
    rejectedEffort: 'max' | 'xhigh',
  ): Promise<void> {
    const ptyGeneration = runtime.ptyGeneration;
    if (!runtime.active || ptyGeneration === undefined) {
      return;
    }
    runtime.effortRestoreAfterTurn = runtime.effortRequest ?? rejectedEffort;
    try {
      await this.submitClaudeCommand(runtime, '/effort high');
      this.assertRuntimePty(runtime, ptyGeneration);
      runtime.effortRequest = 'high';
      if (runtime.effortCompatibility) {
        runtime.effortCompatibility = {
          ...runtime.effortCompatibility,
          recovery: 'recovered',
        };
      }
    } catch {
      if (!this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
        return;
      }
      runtime.effortRestoreAfterTurn = undefined;
      if (runtime.effortCompatibility) {
        runtime.effortCompatibility = {
          ...runtime.effortCompatibility,
          recovery: 'failed',
        };
      }
    }
    await this.emitState(runtime);
  }

  private async restoreEffortAfterCompatibilityTurn(runtime: RuntimeSession): Promise<void> {
    const restoreTo = runtime.effortRestoreAfterTurn;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      !restoreTo ||
      runtime.effortRestoreInProgress ||
      !runtime.active ||
      ptyGeneration === undefined
    ) {
      return;
    }

    runtime.effortRestoreInProgress = true;
    try {
      if (!isClaudeEffortSafeAfterThinkingDisabledError(restoreTo)) {
        this.enableThinkingForHighEffort(runtime);
      }
      await this.submitClaudeCommand(runtime, `/effort ${restoreTo}`);
      this.assertRuntimePty(runtime, ptyGeneration);
      runtime.diagnosticBuffer = '';
      runtime.effortRequest = restoreTo;
      runtime.effortCompatibility = undefined;
      runtime.effortRestoreAfterTurn = undefined;
      if (runtime.lastApiError?.category === 'effort-thinking-disabled') {
        runtime.lastApiError = undefined;
      }
    } catch {
      // Keep the recovered high cap in place. A later successful Stop signal retries restoration.
    } finally {
      if (this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
        runtime.effortRestoreInProgress = false;
        await this.emitState(runtime);
      }
    }
  }

  private async getRouteHealth(
    runtime: RuntimeSession,
    config: NormalizedClaudeConfig,
  ): Promise<ClaudeRouteHealth | undefined> {
    const credential = this.configStore.getCredential(runtime.cwd);
    const fingerprint = connectionFingerprint(config, credential);
    const connectionCheck = this.connectionChecks.get(projectKey(runtime.cwd));
    const matchingCheck =
      connectionCheck?.fingerprint === fingerprint ? connectionCheck.result : undefined;

    if (usesDefaultClaudeRouter(config)) {
      const router = await this.getRouterHealthState();
      const blockingDetail = routerBlockingDetail(config, router);
      if (blockingDetail) {
        return {
          blocking: true,
          checkedAt: router.checkedAt,
          detail: blockingDetail,
          headline: '当前路由器无法接收 Claude Code 请求',
          source: 'router',
          tone: 'error',
        };
      }
    }

    if (runtime.lastApiError && runtime.launchedConfigFingerprint === fingerprint) {
      const contextWindowExceeded = runtime.lastApiError.category === 'context-window-exceeded';
      return {
        blocking: false,
        checkedAt: runtime.lastApiError.detectedAt,
        detail: matchingCheck?.ok
          ? `${runtime.lastApiError.detail} 此配置此前的单令牌测试通过，但真实 Claude Code 会话随后失败；测试成功不代表端点会持续可用或完整支持 Claude Code。`
          : runtime.lastApiError.detail,
        headline: contextWindowExceeded
          ? '当前对话已超过上下文上限'
          : 'Claude Code 的真实对话请求失败',
        source: 'runtime',
        tone: 'error',
      };
    }

    if (matchingCheck) {
      return {
        blocking: matchingCheck.tone === 'error',
        checkedAt: matchingCheck.testedAt,
        detail: matchingCheck.message,
        headline:
          matchingCheck.tone === 'success'
            ? '当前配置已通过单令牌测试'
            : matchingCheck.tone === 'warning'
              ? '当前配置只通过了部分测试'
              : '当前配置的连接测试失败',
        source: 'connection-test',
        tone: matchingCheck.tone,
      };
    }

    if (usesDefaultClaudeRouter(config)) {
      const router = await this.getRouterHealthState();
      return {
        blocking: false,
        checkedAt: router.checkedAt,
        detail: `CCR 模型网关正在运行，当前可见 ${router.providers.length} 个服务提供方。仍建议执行单令牌真实测试。`,
        headline: '当前路由器基础状态正常',
        source: 'router',
        tone: 'success',
      };
    }
    return undefined;
  }

  private getRouterHealthState(
    force = false,
    priority: BackgroundTaskPriority = 'background',
  ): Promise<ClaudeRouterManagementState> {
    return this.routerHealthCache.get(
      () =>
        this.backgroundTasks.run('router-health', priority, () => this.routerManager.getState()),
      force,
    );
  }

  private diagnoseInstallation(force = false): Promise<ClaudeInstallationStatus> {
    return this.installationCache.get(
      () =>
        this.backgroundTasks.run('claude-installation', 'background', async () => {
          try {
            const result = await execFileAsync(
              'powershell.exe',
              [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                '$command = Get-Command claude -ErrorAction Stop; Write-Output $command.Source; & claude --version',
              ],
              {
                encoding: 'utf8',
                timeout: 10_000,
                windowsHide: true,
              },
            );
            const lines = result.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            const executable = lines.shift();
            return evaluateClaudeInstallation(lines.join(' '), executable);
          } catch (error) {
            const message =
              error instanceof Error && error.message.includes('timed out')
                ? '检查 Claude Code 版本超时。'
                : '未找到 claude 命令，请先安装 Claude Code 2.1.197 或更高版本。';
            return noInstallation(message);
          }
        }),
      force,
    );
  }

  private async emitState(runtime: RuntimeSession): Promise<void> {
    this.onState(await this.getState(runtime.sessionId, runtime.cwd));
  }

  /**
   * Rides the existing 1-second metrics tick rather than adding a timer. Each read captures both the
   * launch and PTY owner, then checks them again after I/O so an in-flight G1 read cannot mutate G2.
   */
  private async pollRuntimeSignal(runtime: RuntimeSession): Promise<void> {
    const waitingForCompact = runtime.waitingForCompact;
    const signalPath = runtime.signalPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      !waitingForCompact ||
      !signalPath ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }

    try {
      // `Set-Content -Encoding UTF8` writes a BOM on Windows PowerShell; JSON.parse rejects it.
      const raw = await this.readLaunchArtifact(signalPath);
      if (
        !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration) ||
        runtime.signalPath !== signalPath ||
        runtime.waitingForCompact !== waitingForCompact
      ) {
        return;
      }
      const parsed = JSON.parse(
        raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw,
      ) as {
        event?: unknown;
        signaledAt?: unknown;
      };
      const signaledAt = optionalFiniteNumber(parsed.signaledAt);
      if (parsed.event !== 'PostCompact' || !signaledAt || signaledAt === runtime.signalSeenAt) {
        return;
      }
      runtime.signalSeenAt = signaledAt;
      waitingForCompact(signaledAt);
    } catch {
      // The helper replaces the file atomically; retry on the next poll.
    }
  }

  private async pollTurnStopSignal(runtime: RuntimeSession): Promise<void> {
    const turnStopPath = runtime.turnStopPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      runtime.effortRestoreInProgress ||
      !turnStopPath ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }

    try {
      const raw = await this.readLaunchArtifact(turnStopPath);
      if (
        !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration) ||
        runtime.turnStopPath !== turnStopPath ||
        runtime.effortRestoreInProgress
      ) {
        return;
      }
      const parsed = JSON.parse(
        raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw,
      ) as {
        event?: unknown;
        signaledAt?: unknown;
      };
      const signaledAt = optionalFiniteNumber(parsed.signaledAt);
      if (parsed.event !== 'Stop' || !signaledAt || signaledAt === runtime.turnStopSeenAt) {
        return;
      }
      runtime.turnStopSeenAt = signaledAt;
      if (
        !runtime.effortRestoreAfterTurn ||
        (runtime.effortCompatibility && signaledAt <= runtime.effortCompatibility.detectedAt)
      ) {
        return;
      }
      void this.restoreEffortAfterCompatibilityTurn(runtime);
    } catch {
      // The helper replaces the file atomically; retry on the next poll.
    }
  }

  private async pollRuntimeActivityEvents(runtime: RuntimeSession): Promise<void> {
    const eventsPath = runtime.activityEventsPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    const handler = this.onActivityEvent;
    if (
      !eventsPath ||
      !handler ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }
    try {
      const files = (await readdir(eventsPath))
        .filter((name) => /^event-\d+-[a-f0-9]{32}\.json$/i.test(name))
        .sort()
        .slice(0, 100);
      for (const name of files) {
        const eventPath = path.join(eventsPath, name);
        try {
          const raw = await readFile(eventPath, 'utf8');
          if (!this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)) return;
          const parsed = JSON.parse(
            raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw,
          ) as Partial<ClaudeRuntimeActivityEvent>;
          if (
            typeof parsed.event !== 'string' ||
            typeof parsed.eventId !== 'string' ||
            parsed.sessionId !== runtime.sessionId ||
            parsed.launchGeneration !== launchGeneration ||
            typeof parsed.signaledAt !== 'number'
          ) {
            await unlink(eventPath);
            continue;
          }
          handler({
            agentId: optionalString(parsed.agentId),
            agentType: optionalString(parsed.agentType),
            backgroundTasks: Array.isArray(parsed.backgroundTasks)
              ? parsed.backgroundTasks.slice(0, 50).map((task) => ({
                  description: optionalString(task?.description),
                  id: optionalString(task?.id),
                  kind: optionalString(task?.kind),
                }))
              : undefined,
            backgroundTasksPresent: parsed.backgroundTasksPresent === true,
            description: optionalString(parsed.description),
            event: parsed.event,
            eventId: parsed.eventId,
            failureKind: optionalString(parsed.failureKind),
            launchGeneration,
            ptyGeneration,
            sessionId: runtime.sessionId,
            signaledAt: parsed.signaledAt,
            taskId: optionalString(parsed.taskId),
          });
          await unlink(eventPath);
        } catch {
          // A file may still be completing or temporarily locked; retry it on the next poll.
        }
      }
    } catch {
      // The event directory is optional and can disappear during generation cleanup.
    }
  }

  private ensureSession(sessionId: string, cwd: string): RuntimeSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.cwd = cwd;
      return existing;
    }

    const created: RuntimeSession = {
      active: false,
      cwd,
      diagnosticBuffer: '',
      effortRestoreInProgress: false,
      markerRemainder: '',
      permissionModeCycle: [],
      sessionId,
      thinkingEnabledForHighEffort: false,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private readLaunchArtifact(artifactPath: string): Promise<string> {
    return readFile(artifactPath, 'utf8');
  }

  private async pollRuntimeMetrics(runtime: RuntimeSession): Promise<void> {
    const metricsPath = runtime.metricsPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      !metricsPath ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }

    try {
      const raw = await this.readLaunchArtifact(metricsPath);
      if (
        !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration) ||
        runtime.metricsPath !== metricsPath
      ) {
        return;
      }
      const metrics = parseClaudeMetrics(raw);
      if (!metrics || metrics.capturedAt === runtime.metrics?.capturedAt) {
        return;
      }
      if (metrics.effortLevel === 'xhigh' || metrics.effortLevel === 'max') {
        this.enableThinkingForHighEffort(runtime);
      }
      runtime.metrics = metrics;
      if (runtime.lastApiError && metrics.capturedAt > runtime.lastApiError.detectedAt) {
        runtime.lastApiError = undefined;
      }
      this.captureConversationPreferences(runtime);
      this.replayRememberedEffort(runtime);
      void this.emitState(runtime);
    } catch {
      // The status-line helper replaces the file atomically; retry on the next poll.
    }
  }

  private async pollMetricsOnce(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (runtime) => {
        await Promise.all([
          this.pollRuntimeActivityEvents(runtime),
          this.pollRuntimeSignal(runtime),
          this.pollTurnStopSignal(runtime),
          this.pollRuntimeMetrics(runtime),
        ]);
      }),
    );
  }

  private pollMetrics(): void {
    if (this.metricsPollInFlight) {
      return;
    }
    const poll = this.pollMetricsOnce();
    this.metricsPollInFlight = poll;
    void poll.then(
      () => {
        if (this.metricsPollInFlight === poll) {
          this.metricsPollInFlight = undefined;
        }
      },
      () => {
        if (this.metricsPollInFlight === poll) {
          this.metricsPollInFlight = undefined;
        }
      },
    );
  }
}
