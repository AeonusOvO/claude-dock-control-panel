import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ClaudeConnectionTestResult,
  ClaudeGatewayDiagnostics,
  ClaudeInstallationStatus,
  ClaudeLaunchMode,
  ClaudeMetrics,
  ClaudeProjectState,
  ClaudeRouteHealth,
  ClaudeRouterManagementState,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
} from '../shared/contracts';
import {
  buildClaudeEnvironment,
  buildClaudeLaunchCommand,
  buildClaudeSettingsEnvironment,
  buildStatusLineCommand,
  evaluateClaudeInstallation,
  normalizeClaudeConfig,
  type ClaudeEnvironmentOverrides,
  type NormalizedClaudeConfig,
} from './claude-configuration';
import { testClaudeConnection } from './claude-connection-test';
import { ClaudeConfigStore } from './claude-config-store';
import { ClaudeGatewayDetector } from './claude-gateway-diagnostics';
import {
  ClaudeRouterManager,
  type DownloadedRouterInstaller,
  type SavedRouterProvider,
} from './claude-router-manager';

interface RuntimeSession {
  active: boolean;
  cwd: string;
  diagnosticBuffer: string;
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
  sessionId: string;
}

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

const projectKey = (cwd: string): string => path.resolve(cwd).toLocaleLowerCase();

const credentialDigest = (credential?: string): string =>
  createHash('sha256')
    .update(credential ?? '')
    .digest('hex');

const connectionFingerprint = (config: NormalizedClaudeConfig, credential?: string): string =>
  JSON.stringify({
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    credentialDigest: credentialDigest(credential),
    model: config.model,
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

const normalizedRuntimeError = (value: string): string => {
  const compact = value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
  if (/ConnectionRefused/i.test(compact)) {
    return 'Claude Code 无法连接到当前 API 地址（ConnectionRefused）。端点可能已停止、被代理拒绝，或保存后的路由已经变化。';
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid (?:api )?key|authentication/i.test(compact)) {
    return 'Claude Code 的真实会话被接口拒绝认证。请重新核对认证方式与当前保存的密钥。';
  }
  if (/\b404\b|not found/i.test(compact)) {
    return 'Claude Code 没有找到 Messages 接口；请确认当前基址最终提供 /v1/messages。';
  }
  if (/model.+(?:not found|invalid|unsupported)|unknown model/i.test(compact)) {
    return 'Claude Code 的真实会话未被当前模型接受；请核对最终接口中的模型 ID。';
  }
  return compact ? `Claude Code 返回 API 错误：${compact}` : 'Claude Code 的真实会话请求失败。';
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
    return '当前项目指向 Router 的 3456 接口，但 CCR 没有任何 Provider/模型。请先在“接入”页添加 Provider。';
  }
  if (router.gatewayState !== 'running') {
    return `当前项目指向 Router 的 3456 接口，但模型网关未就绪：${router.message}`;
  }
  return undefined;
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

export class ClaudeRuntime {
  private cachedInstallation?: { checkedAt: number; value: ClaudeInstallationStatus };
  private cachedRouterHealth?: { checkedAt: number; value: ClaudeRouterManagementState };
  private readonly configStore: ClaudeConfigStore;
  private readonly connectionChecks = new Map<string, ConnectionCheckRecord>();
  private readonly gatewayDetector = new ClaudeGatewayDetector();
  private readonly metricsTimer: NodeJS.Timeout;
  private readonly routerManager: ClaudeRouterManager;
  private readonly runtimeRoot: string;
  private readonly sessions = new Map<string, RuntimeSession>();

  public constructor(
    userDataPath: string,
    private readonly statusLineScriptPath: string,
    private readonly onState: (state: ClaudeProjectState) => void,
  ) {
    this.configStore = new ClaudeConfigStore(userDataPath);
    this.routerManager = new ClaudeRouterManager(userDataPath);
    this.runtimeRoot = path.join(userDataPath, 'claude', 'runtime');
    this.metricsTimer = setInterval(() => {
      this.pollMetrics();
    }, 1000);
    this.metricsTimer.unref();
  }

  public closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
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
      config: this.configStore.getView(cwd),
      cwd,
      expectedModel: runtime.expectedModel,
      installation,
      metrics: runtime.metrics,
      modelMatches: matches,
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
    return this.gatewayDetector.detect(cwd, this.configStore.getConfig(cwd));
  }

  public getRouterManagementState(): Promise<ClaudeRouterManagementState> {
    return this.routerManager.getState();
  }

  public downloadRouterInstaller(): Promise<DownloadedRouterInstaller> {
    return this.routerManager.downloadLatestInstaller();
  }

  public async startRouter(): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.start();
    this.cachedRouterHealth = { checkedAt: Date.now(), value: state };
    return state;
  }

  public async stopRouter(): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.stop();
    this.cachedRouterHealth = { checkedAt: Date.now(), value: state };
    return state;
  }

  public routerManagementUrl(): Promise<string> {
    return this.routerManager.managementUrl();
  }

  public async deleteRouterProvider(providerId: string): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.deleteProvider(providerId);
    this.cachedRouterHealth = { checkedAt: Date.now(), value: state };
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
    this.cachedRouterHealth = { checkedAt: Date.now(), value: saved.state };
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

  public async prepareLaunch(
    sessionId: string,
    cwd: string,
    mode: ClaudeLaunchMode,
  ): Promise<PreparedClaudeLaunch> {
    const installation = await this.diagnoseInstallation(true);
    if (installation.security !== 'ready') {
      throw new Error(installation.message);
    }

    const config = this.configStore.getConfig(cwd);
    const credential = this.configStore.getCredential(cwd);
    if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !credential) {
      throw new Error('当前接入需要 API 凭据，请先在“接入”页保存密钥。');
    }
    if (usesDefaultClaudeRouter(config)) {
      const router = await this.routerManager.getState();
      this.cachedRouterHealth = { checkedAt: Date.now(), value: router };
      const blockingDetail = routerBlockingDetail(config, router);
      if (blockingDetail) {
        throw new Error(blockingDetail);
      }
    }

    const sessionDirectory = path.join(this.runtimeRoot, sessionId);
    const metricsPath = path.join(sessionDirectory, 'metrics.json');
    const settingsPath = path.join(sessionDirectory, 'settings.json');
    mkdirSync(sessionDirectory, { recursive: true });
    if (existsSync(metricsPath)) {
      unlinkSync(metricsPath);
    }

    const settings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      env: buildClaudeSettingsEnvironment(config),
      model: config.model,
      skipWebFetchPreflight: true,
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
    runtime.expectedModel = config.model;
    runtime.exitMarker = `\u001b]9;claudedock-exit:${sessionId}:${Date.now()}\u0007`;
    runtime.markerRemainder = '';
    runtime.lastApiError = undefined;
    runtime.launchedConfigFingerprint = connectionFingerprint(config, credential);
    runtime.metrics = undefined;
    runtime.metricsPath = metricsPath;

    const command = buildClaudeLaunchCommand(settingsPath, config.model, mode, runtime.exitMarker);
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
    const runtime = this.ensureSession(sessionId, cwd);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return { ...state, active: runtime.active };
  }

  public async testConnection(
    cwd: string,
    input: SaveClaudeConfigInput,
  ): Promise<ClaudeConnectionTestResult> {
    const config = normalizeClaudeConfig(input);
    const enteredCredential = input.credential?.trim();
    const credential = enteredCredential || this.configStore.getCredential(cwd);
    const result = await testClaudeConnection(config, credential);
    this.connectionChecks.set(projectKey(cwd), {
      fingerprint: connectionFingerprint(config, credential),
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
          headline: '当前 Router 无法接收 Claude Code 请求',
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
          ? `${runtime.lastApiError.detail} 此配置此前的 1-token 测试通过，但真实 Claude Code 会话随后失败；测试成功不代表端点会持续可用或完整支持 Claude Code。`
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
            ? '当前配置已通过 1-token 测试'
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
        detail: `CCR 模型网关正在运行，当前可见 ${router.providers.length} 个 Provider。仍建议执行 1-token 真实测试。`,
        headline: '当前 Router 基础状态正常',
        source: 'router',
        tone: 'success',
      };
    }
    return undefined;
  }

  private async getRouterHealthState(): Promise<ClaudeRouterManagementState> {
    if (
      this.cachedRouterHealth &&
      Date.now() - this.cachedRouterHealth.checkedAt < ROUTER_HEALTH_CACHE_MS
    ) {
      return this.cachedRouterHealth.value;
    }
    const value = await this.routerManager.getState();
    this.cachedRouterHealth = { checkedAt: Date.now(), value };
    return value;
  }

  private async diagnoseInstallation(force = false): Promise<ClaudeInstallationStatus> {
    if (
      !force &&
      this.cachedInstallation &&
      Date.now() - this.cachedInstallation.checkedAt < INSTALLATION_CACHE_MS
    ) {
      return this.cachedInstallation.value;
    }

    let value: ClaudeInstallationStatus;
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
      value = evaluateClaudeInstallation(lines.join(' '), executable);
    } catch (error) {
      const message =
        error instanceof Error && error.message.includes('timed out')
          ? '检查 Claude Code 版本超时。'
          : '未找到 claude 命令，请先安装 Claude Code 2.1.197 或更高版本。';
      value = noInstallation(message);
    }

    this.cachedInstallation = { checkedAt: Date.now(), value };
    return value;
  }

  private async emitState(runtime: RuntimeSession): Promise<void> {
    this.onState(await this.getState(runtime.sessionId, runtime.cwd));
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
      sessionId,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private pollMetrics(): void {
    for (const runtime of this.sessions.values()) {
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
