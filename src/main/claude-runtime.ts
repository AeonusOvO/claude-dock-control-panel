import { execFile } from 'node:child_process';
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
  ClaudeRouterManagementState,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
} from '../shared/contracts';
import {
  buildClaudeEnvironment,
  buildClaudeLaunchCommand,
  buildStatusLineCommand,
  evaluateClaudeInstallation,
  normalizeClaudeConfig,
  type ClaudeEnvironmentOverrides,
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
  exitMarker?: string;
  expectedModel?: string;
  markerRemainder: string;
  metrics?: ClaudeMetrics;
  metricsPath?: string;
  sessionId: string;
}

export interface PreparedClaudeLaunch {
  command: string;
  environment: ClaudeEnvironmentOverrides;
  state: ClaudeProjectState;
}

const execFileAsync = promisify(execFile);
const INSTALLATION_CACHE_MS = 30_000;
const METRICS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const noInstallation = (message: string): ClaudeInstallationStatus => ({
  installed: false,
  message,
  security: 'not-installed',
});

const optionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 1000 ? value : undefined;

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
  private readonly configStore: ClaudeConfigStore;
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
    return {
      active: runtime.active,
      config: this.configStore.getView(cwd),
      cwd,
      expectedModel: runtime.expectedModel,
      installation,
      metrics: runtime.metrics,
      modelMatches: matches,
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

  public startRouter(): Promise<ClaudeRouterManagementState> {
    return this.routerManager.start();
  }

  public stopRouter(): Promise<ClaudeRouterManagementState> {
    return this.routerManager.stop();
  }

  public routerManagementUrl(): Promise<string> {
    return this.routerManager.managementUrl();
  }

  public deleteRouterProvider(providerId: string): Promise<ClaudeRouterManagementState> {
    return this.routerManager.deleteProvider(providerId);
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

    const sessionDirectory = path.join(this.runtimeRoot, sessionId);
    const metricsPath = path.join(sessionDirectory, 'metrics.json');
    const settingsPath = path.join(sessionDirectory, 'settings.json');
    mkdirSync(sessionDirectory, { recursive: true });
    if (existsSync(metricsPath)) {
      unlinkSync(metricsPath);
    }

    const settings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
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
    runtime.expectedModel = config.model;
    runtime.exitMarker = `\u001b]9;claudedock-exit:${sessionId}:${Date.now()}\u0007`;
    runtime.markerRemainder = '';
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

  public testConnection(
    cwd: string,
    input: SaveClaudeConfigInput,
  ): Promise<ClaudeConnectionTestResult> {
    const config = normalizeClaudeConfig(input);
    const enteredCredential = input.credential?.trim();
    const credential = enteredCredential || this.configStore.getCredential(cwd);
    return testClaudeConnection(config, credential);
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
        void this.emitState(runtime);
      } catch {
        // The status-line helper replaces the file atomically; retry on the next poll.
      }
    }
  }
}
