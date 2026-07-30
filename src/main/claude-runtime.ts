import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ClaudeConnectionAdvice,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionTestResult,
  ClaudeEffortLevel,
  ClaudeEffortRequest,
  ClaudeGatewayDiagnostics,
  ClaudeInstallationStatus,
  ClaudeCodeInstallSource,
  ClaudeLaunchMode,
  ClaudeMetrics,
  ClaudeModelOption,
  ClaudeModelOptions,
  ClaudePermissionMode,
  ClaudeProjectState,
  ClaudeRelaunchInput,
  ClaudeRouteHealth,
  ClaudeRouterManagementState,
  ClaudeRouterInstallSource,
  SoftwareUpdateState,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
} from '../shared/contracts';
import { buildTerminalSubmission, writeTerminalSubmission } from '../shared/composer-input';
import { CLAUDE_EFFORT_LEVELS, CLAUDE_EFFORT_REQUESTS } from '../shared/claude-effort';
import { parseClaudePermissionMode } from '../shared/claude-permission-mode';
import { findClaudeProvider } from '../shared/claude-providers';
import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../shared/terminal-themes';
import { AsyncRefreshCache } from './async-refresh-cache';
import {
  BackgroundTaskCoordinator,
  type BackgroundTaskPriority,
} from './background-task-coordinator';
import {
  buildClaudeEnvironment,
  buildClaudeLaunchCommand,
  buildClaudeSettingsEnvironment,
  buildRuntimeSignalCommand,
  buildStatusLineCommand,
  evaluateClaudeInstallation,
  MODEL_NAME_PATTERN,
  normalizeClaudeConfig,
  shouldDisableInheritedApiKeyHelper,
  type ClaudeEnvironmentOverrides,
  type NormalizedClaudeConfig,
} from './claude-configuration';
import { claudeMessagesEndpoint, testClaudeConnection } from './claude-connection-test';
import { ClaudeConfigStore } from './claude-config-store';
import type { ClaudeConfigSnapshot } from './claude-config-store';
import { ClaudeConnectionHistoryStore } from './claude-connection-history';
import { ClaudeGatewayDetector } from './claude-gateway-diagnostics';
import {
  ClaudeRouterManager,
  type DownloadedRouterInstaller,
  type SavedRouterProvider,
} from './claude-router-manager';
import { checkSoftwareUpdates, installOrUpdateClaudeCode } from './software-updates';

interface RuntimeSession {
  active: boolean;
  cwd: string;
  diagnosticBuffer: string;
  /** Effort last requested from the status bar, until the status line reports what was applied. */
  effortRequest?: ClaudeEffortRequest;
  exitMarker?: string;
  expectedModel?: string;
  lastApiError?: {
    detectedAt: number;
    detail: string;
  };
  launchedConfigFingerprint?: string;
  markerRemainder: string;
  metrics?: ClaudeMetrics;
  metricsPath?: string;
  /** Live mode read off the TUI badge; undefined until the badge has been painted once. */
  permissionMode?: ClaudePermissionMode;
  /** Modes this session has actually shown, in first-seen order. */
  permissionModeCycle: ClaudePermissionMode[];
  sessionId: string;
  /** Latest `signaledAt` consumed from signal.json, so each signal is only acted on once. */
  signalSeenAt?: number;
  signalPath?: string;
  /** Resolved by the next PostCompact signal; lets a relaunch wait for compaction to finish. */
  waitingForCompact?: (signaledAt: number) => void;
}

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
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const COMPACT_INSTRUCTION = '请保留：当前任务目标、已完成的修改、待办的下一步。';

interface ConnectionCheckRecord {
  fingerprint: string;
  result: ClaudeConnectionTestResult;
}

export interface PreparedClaudeLaunch {
  command: string;
  environment: ClaudeEnvironmentOverrides;
  state: ClaudeProjectState;
}

const execFileAsync = promisify(execFile);
const INSTALLATION_CACHE_MS = 30_000;
const METRICS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ROUTER_HEALTH_CACHE_MS = 3_000;
const SOFTWARE_UPDATE_CACHE_MS = 5 * 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const noInstallation = (message: string): ClaudeInstallationStatus => ({
  installed: false,
  message,
  security: 'not-installed',
});

const optionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 1000 ? value : undefined;

const optionalEffortLevel = (value: unknown): ClaudeEffortLevel | undefined =>
  typeof value === 'string' && CLAUDE_EFFORT_LEVELS.has(value as ClaudeEffortLevel)
    ? (value as ClaudeEffortLevel)
    : undefined;

const projectKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();

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
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid (?:api )?key|authentication/i.test(compact)) {
    return 'Claude Code 的真实会话被接口拒绝认证。请重新核对认证方式与当前保存的密钥。';
  }
  if (/\b404\b|not found/i.test(compact)) {
    return 'Claude Code 没有找到消息接口；请确认当前基址最终提供 /v1/messages。';
  }
  if (/model.+(?:not found|invalid|unsupported)|unknown model/i.test(compact)) {
    return 'Claude Code 的真实会话未被当前模型接受；请核对最终接口中的模型标识。';
  }
  return compact
    ? 'Claude Code 的接口请求失败；请检查接入地址、认证方式和模型配置。原始错误已保留在终端输出中。'
    : 'Claude Code 的真实会话请求失败。';
};

export const parseClaudeRuntimeApiError = (value: string): string | undefined => {
  const withoutAnsi = value
    .replace(
      // ANSI CSI / OSC control sequences emitted by the terminal renderer.
      // eslint-disable-next-line no-control-regex
      /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g,
      '',
    )
    .replace(/\r/g, '\n');
  const matches = [...withoutAnsi.matchAll(/API Error:\s*([^\n]{1,500})/gi)];
  const latest = matches.at(-1)?.[1];
  return latest ? normalizedRuntimeError(latest) : undefined;
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
      inputTokens: optionalFiniteNumber(parsed.inputTokens),
      linesAdded: optionalFiniteNumber(parsed.linesAdded),
      linesRemoved: optionalFiniteNumber(parsed.linesRemoved),
      modelDisplayName: optionalString(parsed.modelDisplayName),
      modelId: optionalString(parsed.modelId),
      outputTokens: optionalFiniteNumber(parsed.outputTokens),
      rateLimitFiveHour: optionalFiniteNumber(parsed.rateLimitFiveHour),
      rateLimitSevenDay: optionalFiniteNumber(parsed.rateLimitSevenDay),
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
  if (!expected || expected === 'default' || !actual) {
    return true;
  }
  const normalizedExpected = expected.toLowerCase();
  const normalizedActual = actual.toLowerCase();
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.includes(normalizedExpected) ||
    (['haiku', 'opus', 'sonnet'].includes(normalizedExpected) &&
      normalizedActual.includes(normalizedExpected))
  );
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
  private readonly connectionChecks = new Map<string, ConnectionCheckRecord>();
  /** Serialises complete body/return submissions so two UI actions cannot interleave PTY bytes. */
  private readonly commandSubmissionQueues = new Map<string, Promise<void>>();
  private readonly gatewayDetector = new ClaudeGatewayDetector();
  private readonly historyStore: ClaudeConnectionHistoryStore;
  private readonly metricsTimer: NodeJS.Timeout;
  /** Serialises Shift+Tab stepping per session so two clicks can never interleave presses. */
  private readonly modeSwitchLocks = new Set<string>();
  private readonly routerManager: ClaudeRouterManager;
  private readonly runtimeRoot: string;
  private readonly sessions = new Map<string, RuntimeSession>();
  private currentThemeId: TerminalThemeId;

  public constructor(
    userDataPath: string,
    private readonly statusLineScriptPath: string,
    private readonly signalScriptPath: string,
    private readonly onState: (state: ClaudeProjectState) => void,
    private readonly writeToTerminal: (sessionId: string, data: string) => void,
    private readonly readPermissionModeFromScreen: (
      sessionId: string,
    ) => Promise<ClaudePermissionMode | undefined>,
    initialThemeId: TerminalThemeId = DEFAULT_TERMINAL_THEME,
  ) {
    this.configStore = new ClaudeConfigStore(userDataPath);
    this.historyStore = new ClaudeConnectionHistoryStore(userDataPath);
    this.routerManager = new ClaudeRouterManager(userDataPath);
    this.runtimeRoot = path.join(userDataPath, 'claude', 'runtime');
    this.currentThemeId = initialThemeId;
    this.metricsTimer = setInterval(() => {
      this.pollMetrics();
    }, 1000);
    this.metricsTimer.unref();
  }

  public closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  public usesOfficialProvider(cwd: string): boolean {
    return this.configStore.getConfig(cwd).provider === 'anthropic';
  }

  public connectionHistoryUsesOfficialProvider(cwd: string, entryId: string): boolean {
    return this.historyStore.toSaveInput(cwd, entryId).provider === 'anthropic';
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

  public consumeTerminalOutput(sessionId: string, data: string): string {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.exitMarker) {
      return data;
    }

    runtime.diagnosticBuffer = `${runtime.diagnosticBuffer}${data}`.slice(-4_000);
    const detectedError = parseClaudeRuntimeApiError(runtime.diagnosticBuffer);
    if (detectedError && detectedError !== runtime.lastApiError?.detail) {
      runtime.lastApiError = {
        detail: detectedError,
        detectedAt: Date.now(),
      };
      void this.emitState(runtime);
    }
    this.observePermissionModeFromRawOutput(runtime);

    let combined = runtime.markerRemainder + data;
    runtime.markerRemainder = '';
    if (combined.includes(runtime.exitMarker)) {
      combined = combined.replaceAll(runtime.exitMarker, '');
      runtime.active = false;
      runtime.exitMarker = undefined;
      void this.emitState(runtime);
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

  public async getState(sessionId: string, cwd: string): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    const installation = await this.diagnoseInstallation();
    const matches = modelMatches(runtime.expectedModel, runtime.metrics?.modelId);
    const config = this.configStore.getConfig(cwd);
    return {
      active: runtime.active,
      allowBypassPermissions: this.configStore.getAllowBypassPermissions(cwd),
      config: this.configStore.getView(cwd),
      cwd,
      effortRequest: runtime.effortRequest,
      expectedModel: runtime.expectedModel,
      installation,
      metrics: runtime.metrics,
      modelMatches: matches,
      permissionMode: runtime.permissionMode,
      permissionModeCycle: [...runtime.permissionModeCycle],
      routeHealth: await this.getRouteHealth(runtime, config),
      sessionId,
      warning: matches
        ? undefined
        : `运行中模型 ${runtime.metrics?.modelId ?? '未知'} 与锁定模型 ${runtime.expectedModel} 不一致。`,
    };
  }

  public isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active ?? false;
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

  public downloadRouterInstaller(): Promise<DownloadedRouterInstaller> {
    return this.routerManager.downloadLatestInstaller();
  }

  public async installRouterPackage(
    source: Exclude<ClaudeRouterInstallSource, 'github'>,
  ): Promise<{ message: string; state: ClaudeRouterManagementState }> {
    const result = await this.routerManager.installFromNpm(source);
    this.routerHealthCache.set(result.state);
    this.softwareUpdatesCache.clear();
    return result;
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
        checkSoftwareUpdates(installation, router),
      );
    }, force);
  }

  public async installOrUpdateClaudeCode(
    source: ClaudeCodeInstallSource,
  ): Promise<{ message: string; state: SoftwareUpdateState }> {
    const installation = await this.diagnoseInstallation(true);
    const message = await installOrUpdateClaudeCode(source, installation.installed);
    this.installationCache.clear();
    this.softwareUpdatesCache.clear();
    return { message, state: await this.getSoftwareUpdates(true) };
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
    sessionId: string,
    cwd: string,
    input: SaveClaudeRouterProviderInput,
  ): Promise<{
    projectState?: ClaudeProjectState;
    saved: SavedRouterProvider;
  }> {
    const saved = await this.routerManager.saveProvider(input);
    this.routerHealthCache.set(saved.state);
    if (!input.useForCurrentProject) {
      return { saved };
    }
    const projectState = await this.saveConfig(sessionId, cwd, {
      authMode: 'authToken',
      baseUrl: saved.connection.baseUrl,
      credential: saved.connection.apiKey,
      credentialAction: 'replace',
      model: saved.connection.model,
      preset: 'gateway',
      provider: 'gateway',
    });
    return { projectState, saved };
  }

  public async repairRouterFromProject(
    sessionId: string,
    cwd: string,
  ): Promise<{
    projectState: ClaudeProjectState;
    saved: SavedRouterProvider;
  }> {
    const config = this.configStore.getConfig(cwd);
    const credential = this.configStore.getCredential(cwd);
    const input = routerRepairInputForProject(config, credential);
    const current = await this.getRouterHealthState(true);
    if (!current.managementAvailable) {
      throw new Error('CCR 管理服务尚未就绪，无法写入服务提供方。');
    }
    if (current.providers.length > 0) {
      throw new Error('CCR 已存在服务提供方；请编辑现有配置或手动选择要使用的服务提供方。');
    }

    const saved = await this.routerManager.saveProvider(input);
    const routerState = await this.routerManager.start();
    this.routerHealthCache.set(routerState);
    if (routerState.gatewayState !== 'running') {
      throw new Error(routerState.message);
    }
    const projectState = await this.saveConfig(sessionId, cwd, {
      authMode: 'authToken',
      baseUrl: saved.connection.baseUrl,
      credential: saved.connection.apiKey,
      credentialAction: 'replace',
      model: saved.connection.model,
      preset: 'gateway',
      provider: 'gateway',
    });
    return {
      projectState,
      saved: { ...saved, state: routerState },
    };
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
  ): Promise<PreparedClaudeLaunch> {
    const installation = await this.diagnoseInstallation(true);
    if (installation.security !== 'ready') {
      throw new Error(installation.message);
    }

    const config = this.configStore.getConfig(cwd);
    const credential = this.configStore.getCredential(cwd);
    if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !credential) {
      throw new Error('当前接入需要接口凭据，请先在“接入”页保存密钥。');
    }
    if (usesDefaultClaudeRouter(config)) {
      const router = await this.getRouterHealthState(true);
      const blockingDetail = routerBlockingDetail(config, router);
      if (blockingDetail) {
        throw new Error(blockingDetail);
      }
    }

    const sessionDirectory = path.join(this.runtimeRoot, sessionId);
    const metricsPath = path.join(sessionDirectory, 'metrics.json');
    const settingsPath = path.join(sessionDirectory, 'settings.json');
    const signalPath = path.join(sessionDirectory, 'signal.json');
    mkdirSync(sessionDirectory, { recursive: true });
    if (existsSync(metricsPath)) {
      unlinkSync(metricsPath);
    }
    if (existsSync(signalPath)) {
      unlinkSync(signalPath);
    }

    const settings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      ...(shouldDisableInheritedApiKeyHelper(config) ? { apiKeyHelper: '' } : {}),
      env: buildClaudeSettingsEnvironment(config),
      // The only hook we install: it reports that a `/compact` issued before a cross-endpoint
      // relaunch has actually finished, so the restart never cuts the summary short.
      hooks: {
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
      },
      model: config.model,
      skipWebFetchPreflight: true,
      theme: claudeCodeThemeForTerminalTheme(this.currentThemeId),
      statusLine: {
        command: buildStatusLineCommand(this.statusLineScriptPath, metricsPath),
        refreshInterval: 1,
        type: 'command',
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

    const runtime = this.ensureSession(sessionId, cwd);
    runtime.active = true;
    runtime.diagnosticBuffer = '';
    // A relaunch re-reads the persisted effort setting, so a session-only request no longer holds.
    runtime.effortRequest = undefined;
    runtime.expectedModel = config.model;
    runtime.exitMarker = `\u001b]9;claudedock-exit:${sessionId}:${Date.now()}\u0007`;
    runtime.markerRemainder = '';
    runtime.lastApiError = undefined;
    runtime.launchedConfigFingerprint = connectionFingerprint(config, credential);
    runtime.metrics = undefined;
    runtime.metricsPath = metricsPath;
    // A relaunch paints a fresh TUI, so nothing observed in the previous one still holds.
    runtime.permissionMode = startMode;
    runtime.permissionModeCycle = startMode ? [startMode] : [];
    runtime.signalPath = signalPath;
    runtime.signalSeenAt = undefined;
    runtime.waitingForCompact = undefined;

    const command = buildClaudeLaunchCommand(
      settingsPath,
      config.model,
      mode,
      runtime.exitMarker,
      resumeSessionId,
      { allowBypass: this.configStore.getAllowBypassPermissions(cwd), startMode },
    );
    const state = await this.getState(sessionId, cwd);
    return {
      command,
      environment: buildClaudeEnvironment(config, credential),
      state,
    };
  }

  public async saveConfig(
    sessionId: string,
    cwd: string,
    input: Parameters<ClaudeConfigStore['save']>[1],
  ): Promise<ClaudeProjectState> {
    this.configStore.save(cwd, input);
    await this.recordConnectionHistory(cwd, input);
    const runtime = this.ensureSession(sessionId, cwd);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return { ...state, active: runtime.active };
  }

  public getConnectionHistory(cwd: string): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.list(cwd);
  }

  public deleteConnectionHistory(cwd: string, entryId: string): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.remove(cwd, entryId);
  }

  /**
   * Replays a saved setup. It goes through `saveConfig`, so restoring a record is indistinguishable
   * from having typed it again — including the deduplication that keeps the list from growing when
   * the restored setup is already the newest one.
   */
  public async applyConnectionHistory(
    sessionId: string,
    cwd: string,
    entryId: string,
  ): Promise<ClaudeProjectState> {
    return this.saveConfig(sessionId, cwd, this.historyStore.toSaveInput(cwd, entryId));
  }

  /**
   * Everything the status-bar picker can offer: the model this project is configured with, plus one
   * entry per saved connection. Entries that keep the current endpoint switch inside the live
   * conversation; the rest need a relaunch because base URL and credential are PTY-spawn variables.
   */
  public getModelOptions(cwd: string, sessionId?: string): ClaudeModelOptions {
    const config = this.configStore.getConfig(cwd);
    const runtime = sessionId ? this.sessions.get(sessionId) : undefined;
    const activeModel = runtime?.expectedModel ?? runtime?.metrics?.modelId ?? config.model;
    const options: ClaudeModelOption[] = [
      {
        id: 'current',
        label: config.model,
        model: config.model,
        providerLabel: '当前接入',
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
      options.push({
        entryId: entry.id,
        id: `history:${entry.id}`,
        label: entry.model,
        model: entry.model,
        providerLabel: describeEndpoint(entry),
        sameEndpoint,
      });
    }

    return { activeModel, options };
  }

  /**
   * Same-endpoint switch: `/model` applies immediately inside the running conversation. The model
   * is re-validated here rather than trusted from the renderer, because this writes to a live shell.
   */
  public async switchModel(
    sessionId: string,
    cwd: string,
    optionId: string,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    if (!runtime.active) {
      throw new Error('Claude Code 尚未运行，无法切换模型。');
    }

    const option = this.getModelOptions(cwd, sessionId).options.find(
      (candidate) => candidate.id === optionId,
    );
    if (!option) {
      throw new Error('这个模型选项已经失效，请重新打开列表。');
    }
    if (!option.sameEndpoint) {
      throw new Error('这个模型属于其他接入端点，需要重启会话才能切换。');
    }
    if (!MODEL_NAME_PATTERN.test(option.model)) {
      throw new Error('模型标识不合法，拒绝写入终端。');
    }

    await this.submitClaudeCommand(runtime, `/model ${option.model}`);
    runtime.expectedModel = option.model;
    const state = await this.getState(sessionId, cwd);
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
    if (!runtime.active) {
      throw new Error('Claude Code 尚未运行，无法调整思考程度。');
    }
    if (!CLAUDE_EFFORT_REQUESTS.has(effort)) {
      throw new Error('思考程度标识不合法，拒绝写入终端。');
    }

    await this.submitClaudeCommand(runtime, `/effort ${effort}`);
    runtime.effortRequest = effort;
    const state = await this.getState(sessionId, cwd);
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
    if (!runtime.active) {
      throw new Error('Claude Code 尚未运行，无法执行命令。');
    }
    await this.submitClaudeCommand(runtime, commandLine);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  /**
   * The one relaunch path, shared by cross-endpoint model switches and by `dontAsk` — both need a
   * new PTY. `--continue` restores the conversation; the optional `/compact` first keeps the restored
   * context small enough for a model whose window may be narrower than the current one's.
   */
  public async relaunch(
    sessionId: string,
    cwd: string,
    input: ClaudeRelaunchInput,
  ): Promise<PreparedClaudeLaunch> {
    const runtime = this.ensureSession(sessionId, cwd);
    if (input.compactFirst && runtime.active) {
      await this.compactAndWait(runtime);
    }
    if (input.entryId) {
      await this.applyConnectionHistory(sessionId, cwd, input.entryId);
    }
    return this.prepareLaunch(sessionId, cwd, 'continue', input.permissionMode);
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
    if (!runtime.active) {
      throw new Error('Claude Code 尚未运行，无法切换模式。');
    }
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
    try {
      const current = await this.readPermissionModeFromScreen(sessionId);
      if (!current) {
        throw new Error(
          '当前终端没有显示权限模式徽标。请先关闭 Claude Code 的选择器或确认框，回到主输入界面后重试。',
        );
      }
      this.recordPermissionMode(runtime, current);
      if (current === mode) {
        return this.getState(sessionId, cwd);
      }

      const visited = new Set<ClaudePermissionMode>([current]);
      for (let step = 0; step < PERMISSION_MODE_MAX_STEPS; step += 1) {
        const before = runtime.permissionMode ?? current;
        this.writeToTerminal(sessionId, SHIFT_TAB_SEQUENCE);
        const changed = await this.waitForPermissionModeChange(sessionId, before);
        if (!changed) {
          throw new Error(
            '当前终端没有确认这次模式切换，已停止继续按键以避免切到错误模式。请回到 Claude Code 主输入界面后重试；若刚进入「完全允许」，请先在终端完成 Claude Code 自己的免责确认。',
          );
        }
        this.recordPermissionMode(runtime, changed);
        if (changed === mode) {
          const state = await this.getState(sessionId, cwd);
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
      this.modeSwitchLocks.delete(sessionId);
    }
  }

  public async setAllowBypassPermissions(
    sessionId: string,
    cwd: string,
    allowed: boolean,
  ): Promise<ClaudeProjectState> {
    this.configStore.setAllowBypassPermissions(cwd, allowed);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  /**
   * Accepts the badge reconstructed by xterm. Claude Code normally repaints only changed cells, so
   * the complete viewport is the reliable source after a Shift+Tab step.
   */
  public observePermissionModeFromScreen(
    sessionId: string,
    cwd: string,
    mode: ClaudePermissionMode,
  ): void {
    const runtime = this.ensureSession(sessionId, cwd);
    if (runtime.active) {
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
    void this.emitState(runtime);
  }

  private waitForPermissionModeChange(
    sessionId: string,
    before: ClaudePermissionMode | undefined,
  ): Promise<ClaudePermissionMode | undefined> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const probe = async (): Promise<void> => {
        const observed = await this.readPermissionModeFromScreen(sessionId);
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
      };
      void probe();
    });
  }

  /**
   * Issues `/compact` and waits for the PostCompact hook. A timeout is not fatal — the relaunch is
   * still safe, it just carries the un-compacted history — so the caller is never blocked.
   */
  private async compactAndWait(runtime: RuntimeSession): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const compacted = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        runtime.waitingForCompact = undefined;
        resolve();
      }, COMPACT_TIMEOUT_MS);
      timer.unref?.();
      runtime.waitingForCompact = () => {
        if (timer) {
          clearTimeout(timer);
        }
        runtime.waitingForCompact = undefined;
        resolve();
      };
    });
    try {
      await this.submitClaudeCommand(runtime, `/compact ${COMPACT_INSTRUCTION}`);
      await compacted;
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      runtime.waitingForCompact = undefined;
      throw error;
    }
  }

  /**
   * Claude Code's TUI treats command text and a trailing return received in one PTY chunk as a
   * paste, which can leave `/model ...` sitting in the input box forever. Queue complete submissions
   * per session, then write the return separately after the shared TUI-safe gap.
   */
  private submitClaudeCommand(runtime: RuntimeSession, commandLine: string): Promise<void> {
    const { sessionId } = runtime;
    const previous = this.commandSubmissionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const isCurrentSession = (): boolean =>
          this.sessions.get(sessionId) === runtime && runtime.active;
        const submitted = await writeTerminalSubmission(
          buildTerminalSubmission(commandLine),
          (data) => {
            this.writeToTerminal(sessionId, data);
          },
          isCurrentSession,
        );
        if (!submitted) {
          throw new Error('Claude Code 会话已停止或重启，已取消这次命令。');
        }
      });
    this.commandSubmissionQueues.set(sessionId, current);
    return current.finally(() => {
      if (this.commandSubmissionQueues.get(sessionId) === current) {
        this.commandSubmissionQueues.delete(sessionId);
      }
    });
  }

  /**
   * Snapshots what was saved together with the gateway state at that moment, so a record restores
   * the situation and not just the form fields. A history failure must never fail the save itself.
   */
  private async recordConnectionHistory(cwd: string, input: SaveClaudeConfigInput): Promise<void> {
    try {
      const router = await this.getRouterHealthState();
      this.historyStore.record(cwd, {
        config: input,
        credential: this.configStore.getCredential(cwd),
        gatewayEndpoint: router.endpoint,
        gatewayState: router.gatewayState,
      });
    } catch {
      // The configuration is already saved; a missing history entry is not worth failing over.
    }
  }

  public async testConnection(
    cwd: string,
    input: SaveClaudeConfigInput,
  ): Promise<ClaudeConnectionTestResult> {
    const config = normalizeClaudeConfig(input);
    const enteredCredential = input.credential?.trim();
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

  public setInactive(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.active = false;
    runtime.exitMarker = undefined;
    runtime.markerRemainder = '';
    void this.emitState(runtime);
  }

  public shutdown(): void {
    clearInterval(this.metricsTimer);
    this.sessions.clear();
    this.commandSubmissionQueues.clear();
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
      return {
        blocking: false,
        checkedAt: runtime.lastApiError.detectedAt,
        detail: matchingCheck?.ok
          ? `${runtime.lastApiError.detail} 此配置此前的单令牌测试通过，但真实 Claude Code 会话随后失败；测试成功不代表端点会持续可用或完整支持 Claude Code。`
          : runtime.lastApiError.detail,
        headline: 'Claude Code 的真实对话请求失败',
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
   * Rides the existing 1-second metrics tick rather than adding a timer. Only fresh signals count:
   * a stale `signal.json` from an earlier compaction must not release a later relaunch early.
   */
  private pollRuntimeSignal(runtime: RuntimeSession): void {
    if (!runtime.waitingForCompact || !runtime.signalPath || !existsSync(runtime.signalPath)) {
      return;
    }

    try {
      // `Set-Content -Encoding UTF8` writes a BOM on Windows PowerShell; JSON.parse rejects it.
      const raw = readFileSync(runtime.signalPath, 'utf8');
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
      runtime.waitingForCompact(signaledAt);
    } catch {
      // The helper replaces the file atomically; retry on the next poll.
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
      markerRemainder: '',
      permissionModeCycle: [],
      sessionId,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private pollMetrics(): void {
    for (const runtime of this.sessions.values()) {
      this.pollRuntimeSignal(runtime);
      if (!runtime.metricsPath || !existsSync(runtime.metricsPath)) {
        continue;
      }

      try {
        const metrics = parseClaudeMetrics(readFileSync(runtime.metricsPath, 'utf8'));
        if (!metrics || metrics.capturedAt === runtime.metrics?.capturedAt) {
          continue;
        }
        runtime.metrics = metrics;
        if (runtime.lastApiError && metrics.capturedAt > runtime.lastApiError.detectedAt) {
          runtime.lastApiError = undefined;
        }
        void this.emitState(runtime);
      } catch {
        // The status-line helper replaces the file atomically; retry on the next poll.
      }
    }
  }
}
