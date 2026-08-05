import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  CodexAccountView,
  CodexInstallationStatus,
  CodexLaunchMode,
  CodexLoginMethod,
  CodexLoginView,
  CodexProjectState,
  CodexRateLimitsView,
  PtyGeneration,
  ResourceUsageView,
} from '../shared/contracts';
import { AsyncRefreshCache } from './async-refresh-cache';
import type { BusyRegistry } from './busy-registry';
import { CodexAppServerClient, type CodexAppServerNotification } from './codex-app-server';
import { CodexInstaller, compareVersions } from './codex-installer';
import type { DownloadEngine } from './download-engine';
import {
  resolveWindowsCommandInvocation,
  runProcess,
  windowsCommandInvocationForPath,
  type WindowsCommandInvocation,
} from './windows-command';

type JsonRecord = Record<string, unknown>;

interface CodexRuntimeSession {
  active: boolean;
  cwd: string;
  exitMarker?: string;
  markerRemainder: string;
  /** Exact PowerShell/ConPTY instance this runtime may observe or mutate. */
  ptyGeneration?: PtyGeneration;
  sessionId: string;
}

interface CodexAccountReadResult {
  account?: CodexAccountView;
  requiresOpenaiAuth: boolean;
}

export interface PreparedCodexLaunch {
  command: string;
  environment: Record<string, null | string>;
  state: CodexProjectState;
}

export interface PreparedCodexLogin {
  externalUrl?: string;
  state: CodexProjectState;
}

const INSTALLATION_CACHE_MS = 5 * 60_000;
const ACCOUNT_CACHE_MS = 5_000;
const MARKER_PREFIX = '\u001b]9;claudedock-codex-exit:';

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const boundedString = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;

export const parseCodexAccountRead = (value: unknown): CodexAccountReadResult => {
  if (!isRecord(value)) {
    throw new Error('Codex 账号响应格式无效。');
  }
  const requiresOpenaiAuth = value.requiresOpenaiAuth === true;
  if (value.account === null || value.account === undefined) {
    return { requiresOpenaiAuth };
  }
  if (!isRecord(value.account)) {
    throw new Error('Codex 账号响应格式无效。');
  }
  const rawType = boundedString(value.account.type, 80);
  const type: CodexAccountView['type'] =
    rawType === 'chatgpt' ? 'chatgpt' : rawType === 'apiKey' ? 'apiKey' : 'other';
  return {
    account: {
      email: boundedString(value.account.email, 320),
      planType: boundedString(value.account.planType, 80),
      type,
    },
    requiresOpenaiAuth,
  };
};

const parseRateLimitWindow = (value: unknown) => {
  if (!isRecord(value) || typeof value.usedPercent !== 'number') {
    return undefined;
  }
  return {
    resetsAt:
      typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)
        ? value.resetsAt
        : undefined,
    usedPercent: Math.min(100, Math.max(0, value.usedPercent)),
    windowDurationMins:
      typeof value.windowDurationMins === 'number' && Number.isFinite(value.windowDurationMins)
        ? value.windowDurationMins
        : undefined,
  };
};

export const parseCodexRateLimits = (value: unknown): CodexRateLimitsView | undefined => {
  if (!isRecord(value) || !isRecord(value.rateLimits)) {
    return undefined;
  }
  const primary = parseRateLimitWindow(value.rateLimits.primary);
  const secondary = parseRateLimitWindow(value.rateLimits.secondary);
  return primary || secondary ? { primary, secondary } : undefined;
};

export const codexResourceUsage = (
  account: CodexAccountView | undefined,
  rateLimits: CodexRateLimitsView | undefined,
): ResourceUsageView => {
  const windows = [rateLimits?.primary, rateLimits?.secondary].flatMap((window, index) =>
    window
      ? [
          {
            label:
              window.windowDurationMins === 300
                ? '5 小时'
                : window.windowDurationMins === 10_080
                  ? '7 天'
                  : index === 0
                    ? '主要窗口'
                    : '次要窗口',
            resetsAt: window.resetsAt,
            usedPercent: window.usedPercent,
            windowDurationMins: window.windowDurationMins,
          },
        ]
      : [],
  );
  const available = account?.type === 'chatgpt' && windows.length > 0;
  return {
    availability: available ? 'available' : 'unavailable',
    capabilities: { balance: false, context: false, windows: account?.type === 'chatgpt' },
    checkedAt: Date.now(),
    detail:
      account?.type !== 'chatgpt'
        ? 'API Key 账号没有订阅额度窗口。'
        : available
          ? undefined
          : 'Codex 官方状态源暂未返回额度。',
    source: 'codex-app-server',
    windows: windows.length > 0 ? windows : undefined,
  };
};

const quotePowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const buildCodexLaunchCommand = (
  executable: string,
  cwd: string,
  mode: CodexLaunchMode,
  exitMarker: string,
): string => {
  const argumentsList = [
    ...(mode === 'new' ? [] : ['resume']),
    ...(mode === 'continue' ? ['--last'] : []),
    '--cd',
    cwd,
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'on-request',
    '--no-alt-screen',
  ];
  const command = [
    '&',
    quotePowerShellLiteral(executable),
    ...argumentsList.map(quotePowerShellLiteral),
  ].join(' ');
  return `${command}; [Console]::Write(${quotePowerShellLiteral(exitMarker)})`;
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

export class CodexRuntime {
  private readonly accountCache = new AsyncRefreshCache<CodexAccountReadResult>(ACCOUNT_CACHE_MS);
  private readonly appServer: CodexAppServerClient;
  private readonly installationCache = new AsyncRefreshCache<CodexInstallationStatus>(
    INSTALLATION_CACHE_MS,
  );
  private readonly installer: CodexInstaller;
  private installProgress: string | undefined;
  private lastInstallProgressEmitAt = 0;
  private login: CodexLoginView = { phase: 'idle' };
  private rateLimits: CodexRateLimitsView | undefined;
  private readonly sessions = new Map<string, CodexRuntimeSession>();

  public constructor(
    userDataPath: string,
    private readonly onState: (state: CodexProjectState) => void,
    private readonly writeToTerminal: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
      data: string,
    ) => boolean,
    downloadEngine: DownloadEngine,
    busyRegistry: BusyRegistry,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.installer = new CodexInstaller(
      userDataPath,
      downloadEngine,
      busyRegistry,
      (line, stream) => {
        const detail = line.trim();
        if (!detail) {
          return;
        }
        this.installProgress = `${stream === 'stderr' ? '安装提示' : '正在安装'}：${detail.slice(0, 300)}`;
        const now = Date.now();
        if (now - this.lastInstallProgressEmitAt >= 200) {
          this.lastInstallProgressEmitAt = now;
          void this.emitAllStates();
        }
      },
      fetchImplementation,
    );
    this.appServer = new CodexAppServerClient(() => this.resolveCodexInvocation());
    this.appServer.onNotification((notification) => {
      this.handleNotification(notification);
    });
  }

  public closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  public dispose(): void {
    this.appServer.stop();
    this.sessions.clear();
  }

  public isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active ?? false;
  }

  public bindPty(sessionId: string, ptyGeneration: PtyGeneration): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active) {
      throw new Error('Codex 启动状态已失效，无法绑定新的终端。');
    }
    if (runtime.ptyGeneration !== undefined && runtime.ptyGeneration !== ptyGeneration) {
      throw new Error('Codex 已绑定到其他终端，这次启动结果已失效。');
    }
    runtime.ptyGeneration = ptyGeneration;
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

  public setInactive(sessionId: string, expectedGeneration: PtyGeneration): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session?.active ||
      expectedGeneration === undefined ||
      session.ptyGeneration !== expectedGeneration
    ) {
      return false;
    }
    return this.deactivateSession(session);
  }

  public cleanupPreparedLaunch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.active || session.ptyGeneration !== undefined) {
      return false;
    }
    return this.deactivateSession(session);
  }

  private deactivateSession(session: CodexRuntimeSession): boolean {
    session.active = false;
    session.ptyGeneration = undefined;
    session.exitMarker = undefined;
    session.markerRemainder = '';
    void this.emitState(session);
    return true;
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

  public async getState(sessionId: string, cwd: string): Promise<CodexProjectState> {
    const session = this.ensureSession(sessionId, cwd);
    const installation = await this.diagnoseInstallation();
    let accountResult: CodexAccountReadResult = { requiresOpenaiAuth: true };
    let warning: string | undefined;
    if (installation.installed) {
      try {
        accountResult = await this.readAccount();
        if (accountResult.account?.type === 'chatgpt') {
          await this.readRateLimits();
        } else {
          this.rateLimits = undefined;
        }
      } catch (error) {
        warning =
          error instanceof Error
            ? `无法读取 Codex 账号：${error.message}`
            : '无法读取 Codex 账号状态。';
      }
    }
    return {
      account: accountResult.account,
      active: session.active,
      cwd,
      installation,
      login: { ...this.login },
      operationMessage: this.installProgress,
      rateLimits: this.rateLimits,
      resourceUsage: codexResourceUsage(accountResult.account, this.rateLimits),
      requiresOpenaiAuth: accountResult.requiresOpenaiAuth,
      sessionId,
      warning,
    };
  }

  public async installOrUpdate(sessionId: string, cwd: string): Promise<CodexProjectState> {
    this.installProgress = '准备下载 Codex 官方安装脚本…';
    await this.emitAllStates();
    try {
      await this.installer.installLatest();
      this.appServer.stop();
      this.installationCache.clear();
      this.accountCache.clear();
    } finally {
      this.installProgress = undefined;
      await this.emitAllStates();
    }
    return this.getState(sessionId, cwd);
  }

  public async startLogin(
    sessionId: string,
    cwd: string,
    method: CodexLoginMethod,
  ): Promise<PreparedCodexLogin> {
    const installation = await this.diagnoseInstallation(true);
    if (!installation.installed) {
      throw new Error('请先安装 Codex CLI。');
    }
    this.login = { method, phase: 'starting' };
    await this.emitAllStates();
    try {
      const response = await this.appServer.request<JsonRecord>('account/login/start', {
        ...(method === 'browser'
          ? {
              appBrand: 'chatgpt',
              type: 'chatgpt',
              useHostedLoginSuccessPage: true,
            }
          : { type: 'chatgptDeviceCode' }),
      });
      const loginId = boundedString(response.loginId, 100);
      if (!loginId) {
        throw new Error('Codex 没有返回登录标识。');
      }
      if (method === 'browser') {
        const authUrl = this.validateLoginUrl(response.authUrl);
        this.login = { loginId, method, phase: 'waiting' };
        return { externalUrl: authUrl, state: await this.getState(sessionId, cwd) };
      }
      const verificationUrl = this.validateLoginUrl(response.verificationUrl);
      const userCode = boundedString(response.userCode, 32);
      if (!userCode) {
        throw new Error('Codex 没有返回设备验证码。');
      }
      this.login = {
        loginId,
        method,
        phase: 'waiting',
        userCode,
        verificationUrl,
      };
      return { externalUrl: verificationUrl, state: await this.getState(sessionId, cwd) };
    } catch (error) {
      this.login = {
        error: error instanceof Error ? error.message : '无法启动 ChatGPT 登录。',
        method,
        phase: 'error',
      };
      await this.emitAllStates();
      throw error;
    }
  }

  public async cancelLogin(sessionId: string, cwd: string): Promise<CodexProjectState> {
    const loginId = this.login.loginId;
    if (loginId) {
      await this.appServer.request('account/login/cancel', { loginId });
    }
    this.login = { phase: 'idle' };
    return this.getState(sessionId, cwd);
  }

  public async logout(sessionId: string, cwd: string): Promise<CodexProjectState> {
    await this.appServer.request('account/logout');
    this.accountCache.clear();
    this.rateLimits = undefined;
    this.login = { phase: 'idle' };
    return this.getState(sessionId, cwd);
  }

  public async prepareLaunch(
    sessionId: string,
    cwd: string,
    mode: CodexLaunchMode,
  ): Promise<PreparedCodexLaunch> {
    const state = await this.getState(sessionId, cwd);
    if (!state.installation.installed || !state.installation.executable) {
      throw new Error(state.installation.message);
    }
    if (state.requiresOpenaiAuth && !state.account) {
      throw new Error('请先使用 ChatGPT 账号登录 Codex。');
    }
    const runtime = this.ensureSession(sessionId, cwd);
    runtime.active = true;
    runtime.ptyGeneration = undefined;
    runtime.exitMarker = `${MARKER_PREFIX}${sessionId}:${Date.now()}\u0007`;
    runtime.markerRemainder = '';
    return {
      command: buildCodexLaunchCommand(
        state.installation.executable,
        cwd,
        mode,
        runtime.exitMarker,
      ),
      environment: {},
      state: { ...state, active: true },
    };
  }

  private ensureSession(sessionId: string, cwd: string): CodexRuntimeSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.cwd = cwd;
      return existing;
    }
    const session: CodexRuntimeSession = {
      active: false,
      cwd,
      markerRemainder: '',
      sessionId,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async diagnoseInstallation(force = false): Promise<CodexInstallationStatus> {
    return this.installationCache.get(async () => {
      let latestVersion: string | undefined;
      try {
        latestVersion = (await this.installer.latest()).version;
      } catch {
        // Installation remains usable when GitHub is unavailable.
      }
      try {
        const invocation = await this.resolveCodexInvocation();
        const environment: NodeJS.ProcessEnv = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const result = await runProcess(
          invocation.executable,
          [...invocation.argumentsPrefix, '--version'],
          environment,
          { maxBuffer: 64 * 1024, timeout: 10_000 },
        );
        const version = /codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s]+)?)/i.exec(
          result.stdout,
        )?.[1];
        if (!version) {
          throw new Error('无法识别 Codex CLI 版本。');
        }
        const updateAvailable = Boolean(
          latestVersion && compareVersions(version, latestVersion) < 0,
        );
        return {
          executable: invocation.source,
          installed: true,
          latestVersion,
          message: updateAvailable
            ? `已安装 ${version}，官方最新版为 ${latestVersion}。`
            : `Codex CLI ${version} 已就绪。`,
          updateAvailable,
          version,
        };
      } catch (error) {
        return {
          installed: false,
          latestVersion,
          message:
            error instanceof Error && !/未找到 codex 命令/.test(error.message)
              ? error.message
              : '尚未安装 Codex CLI，可使用官方 Windows 安装器一键准备。',
          updateAvailable: false,
        };
      }
    }, force);
  }

  private async resolveCodexInvocation(): Promise<WindowsCommandInvocation> {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const standalone = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      if (existsSync(standalone)) {
        return windowsCommandInvocationForPath(standalone, 'codex');
      }
    }
    const resolved = await resolveWindowsCommandInvocation('codex');
    if (path.extname(resolved.source).toLowerCase() !== '.ps1') {
      return resolved;
    }
    /*
     * npm's generated PowerShell shim buffers piped stdin through `$input` before it starts Node.
     * That deadlocks the long-lived App Server JSONL transport, so invoke the verified official
     * package entry directly while retaining the shim path as the user-facing launch source.
     */
    const npmEntry = path.join(
      path.dirname(resolved.source),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (!existsSync(npmEntry)) {
      return resolved;
    }
    const node = await resolveWindowsCommandInvocation('node');
    return {
      argumentsPrefix: [...node.argumentsPrefix, npmEntry],
      executable: node.executable,
      source: resolved.source,
    };
  }

  private readAccount(): Promise<CodexAccountReadResult> {
    return this.accountCache.get(async () =>
      parseCodexAccountRead(await this.appServer.request('account/read', { refreshToken: false })),
    );
  }

  private async readRateLimits(): Promise<void> {
    try {
      this.rateLimits = parseCodexRateLimits(
        await this.appServer.request('account/rateLimits/read'),
      );
    } catch {
      this.rateLimits = undefined;
    }
  }

  private validateLoginUrl(value: unknown): string {
    const raw = boundedString(value, 4_096);
    if (!raw) {
      throw new Error('Codex 没有返回登录地址。');
    }
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      !['auth.openai.com', 'chatgpt.com'].includes(url.hostname.toLowerCase())
    ) {
      throw new Error('Codex 返回了不受信任的登录地址。');
    }
    return url.toString();
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    if (notification.method === 'account/login/completed') {
      const success = notification.params?.success === true;
      this.login = success
        ? { phase: 'idle' }
        : {
            error: boundedString(notification.params?.error, 1_000) ?? 'ChatGPT 登录未完成。',
            phase: 'error',
          };
      this.accountCache.clear();
      void this.emitAllStates();
      return;
    }
    if (notification.method === 'account/updated') {
      this.accountCache.clear();
      void this.emitAllStates();
      return;
    }
    if (notification.method === 'account/rateLimits/updated') {
      this.rateLimits = parseCodexRateLimits(notification.params);
      void this.emitAllStates();
    }
  }

  private async emitState(session: CodexRuntimeSession): Promise<void> {
    this.onState(await this.getState(session.sessionId, session.cwd));
  }

  private async emitAllStates(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        await this.emitState(session);
      }),
    );
  }
}
