import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ClaudeRouterGatewayState,
  ClaudeRouterManagementState,
  ClaudeRouterProviderView,
  RouterOperationProgress,
  SaveClaudeRouterProviderInput,
} from '../../shared/contracts';
import { runWindowsCommand } from '../infra/windows-command';
import {
  buildDeletedRouterConfig,
  buildUpdatedRouterConfig,
  isRecord,
  normalizeRouterProviderInput,
  optionalString,
  readGatewayApiKey,
  sanitizeRouterConfig,
  type CcrAppConfig,
} from './router-provider-config';
import {
  appDataRoot,
  ClaudeRouterPackageManager,
  safeMessage,
  type CcrCliInstallation,
  type CcrServiceAccess,
} from './router-package-manager';
export { ROUTER_DATA_ENTRIES, routerDataDirectory } from './router-package-manager';
export type { RouterPackageOperation } from './router-package-manager';
export {
  buildDeletedRouterConfig,
  buildUpdatedRouterConfig,
  normalizeRouterProviderInput,
  sanitizeRouterConfig,
} from './router-provider-config';

const execFileAsync = promisify(execFile);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
const SERVICE_WAIT_MS = 20_000;

interface CcrGatewayStatus {
  endpoint?: unknown;
  lastError?: unknown;
  state?: unknown;
}

interface CcrAppInfo {
  version?: unknown;
}

interface CcrRpcSuccess<T> {
  ok: true;
  value: T;
}

interface CcrRpcFailure {
  error?: { message?: unknown };
  ok: false;
}

export interface SavedRouterProvider {
  connection: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  provider: ClaudeRouterProviderView;
  state: ClaudeRouterManagementState;
}

const localAppDataRoot = (): string =>
  process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');

const routerNativeModuleMismatch = (
  error: unknown,
): { compiledAbi?: string; requiredAbi?: string } | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !/compiled against a different Node\.js version|NODE_MODULE_VERSION/i.test(message) ||
    !/better[-_]?sqlite3|better_sqlite3/i.test(message)
  ) {
    return undefined;
  }
  const match =
    /NODE_MODULE_VERSION\s+(\d+)[\s\S]{0,400}?requires\s+NODE_MODULE_VERSION\s+(\d+)/i.exec(
      message,
    );
  return {
    compiledAbi: match?.[1],
    requiredAbi: match?.[2],
  };
};

export const routerNativeModuleErrorMessage = (error: unknown): string | undefined => {
  const mismatch = routerNativeModuleMismatch(error);
  if (!mismatch) {
    return undefined;
  }
  const abiDetail =
    mismatch.compiledAbi && mismatch.requiredAbi
      ? `（原生模块 ABI ${mismatch.compiledAbi}，当前运行时 ABI ${mismatch.requiredAbi}）`
      : '';
  return `路由器的 Node.js 运行环境不匹配${abiDetail}。点击“修复运行环境并重启”，ClaudeDock 会改用 CCR 安装时配套的系统 Node.js；不会重编译数据库，也不会修改服务提供方或 Codex。`;
};

export const routerServiceRunsInAppRuntime = (
  serviceImageName: string,
  appExecutable: string,
): boolean => {
  const serviceImage = path.basename(serviceImageName).toLowerCase();
  const appImage = path.basename(appExecutable).toLowerCase();
  return (
    Boolean(serviceImage) &&
    Boolean(appImage) &&
    appImage !== 'node.exe' &&
    serviceImage === appImage
  );
};

export const tasklistImageNames = (bytes: Uint8Array): string[] => {
  const imageNames = new Set<string>();
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      const output = new TextDecoder(encoding).decode(bytes).trim();
      const imageMatch = /^"((?:""|[^"])*)"/.exec(output);
      const imageName = imageMatch?.[1]?.replaceAll('""', '"').trim();
      if (imageName) {
        imageNames.add(imageName);
      }
    } catch {
      // Try the other Windows console encoding.
    }
  }
  return [...imageNames];
};

export const routerCliStartSpec = (
  nodeExecutable: string,
  cliPath: string,
): { args: string[]; executable: string } => ({
  args: [cliPath, 'start', '--no-open', '--gateway'],
  executable: nodeExecutable,
});

export const routerGatewayErrorMessage = (providerCount: number, lastError?: string): string => {
  if (
    providerCount === 0 ||
    /No available models|Configure at least one provider/i.test(lastError ?? '')
  ) {
    return '路由器管理服务已运行，但 3456 模型网关无法启动：还没有配置服务提供方和模型。请按下方“解决办法”添加第一个服务提供方。';
  }
  const detail = lastError
    ? '网关返回了错误；原始信息已保留在终端输出或日志中。'
    : '请检查服务提供方的地址、模型和密钥。';
  return `路由器管理服务已运行，但 3456 模型网关出错：${detail} 请编辑服务提供方后重新启动。`;
};

const readJsonFile = (filePath: string, maximumBytes = 2 * 1024 * 1024): unknown => {
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maximumBytes) {
    throw new Error('CCR 状态文件大小异常。');
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
};

const versionMajor = (version: string | undefined): number | undefined => {
  const match = /^(\d+)\./.exec(version ?? '');
  return match ? Number(match[1]) : undefined;
};

export class ClaudeRouterManager extends ClaudeRouterPackageManager {
  public constructor(
    userDataPath: string,
    onOperationProgress: (progress: RouterOperationProgress) => void = () => {},
    commandEnvironment: () => Record<string, null | string | undefined> = () => ({}),
    runCommand: typeof runWindowsCommand = runWindowsCommand,
  ) {
    super(userDataPath, onOperationProgress, commandEnvironment, runCommand);
  }

  public override async getState(): Promise<ClaudeRouterManagementState> {
    const checkedAt = Date.now();
    const [cli, desktop] = await Promise.all([
      this.findCliInstallation(),
      Promise.resolve(this.findDesktopExecutable()),
    ]);
    const access = await this.getActiveServiceAccess();
    const accessKind = access ? await this.serviceRuntimeKind(access, desktop) : undefined;
    const cliAccess = accessKind === 'cli' || accessKind === 'claudedock';
    const installationKind =
      cli && desktop ? 'mixed' : cli ? 'npm' : desktop ? 'desktop' : 'unknown';
    const installation = {
      // Desktop CCR and its shared data are never uninstall targets for ClaudeDock's CLI-only path.
      canUninstall: Boolean(cli),
      installationKind,
    } as const;
    if (!access || !cliAccess) {
      const installed = Boolean(cli);
      const cliManageable = Boolean(cli?.nodeExecutable && (versionMajor(cli.version) ?? 0) >= 3);
      const manageable = cliManageable;
      return {
        ...installation,
        checkedAt,
        endpoint: 'http://127.0.0.1:3456',
        gatewayState: 'stopped',
        installed,
        manageable,
        managementAvailable: false,
        message:
          access && !cliAccess
            ? '检测到 CCR 桌面版服务正在运行；ClaudeDock 不会接管或改写桌面 App，请关闭该服务后再启用独立 CLI 路由。'
            : installed
              ? manageable
                ? 'Claude Code Router CLI 已安装，但后台服务当前未运行。'
                : cli && (versionMajor(cli.version) ?? 0) >= 3
                  ? '检测到 CCR CLI 3.x，但没有找到能加载其 better-sqlite3 的系统 Node.js；请安装或更新 Node.js。'
                  : '检测到旧版 CCR CLI；请在 ClaudeDock 中一键更新后继续。'
              : desktop
                ? '仅检测到 CCR 桌面版；ClaudeDock 不会操作它，可在后台另行安装 CLI 路由。'
                : '尚未检测到 Claude Code Router CLI，可由 ClaudeDock 在后台自动安装。',
        providers: [],
        serviceRunning: false,
        version: cli?.version,
      };
    }

    if (cli?.nodeExecutable && accessKind === 'claudedock') {
      return {
        ...installation,
        checkedAt,
        endpoint: 'http://127.0.0.1:3456',
        gatewayState: 'unknown',
        installed: true,
        manageable: true,
        managementAvailable: false,
        message:
          '检测到 CCR 正由 ClaudeDock 的 Electron 内置 Node.js 运行，可能把服务提供方误报为空并触发原生模块兼容错误。点击“修复运行环境并重启”；数据库、服务提供方和 Codex 都不会被修改。',
        providers: [],
        runtimeMismatch: true,
        serviceRunning: true,
        version: cli.version,
      };
    }

    try {
      const [appInfo, gateway, config] = await Promise.all([
        this.rpcWithAccess<CcrAppInfo>(access, 'getAppInfo'),
        this.rpcWithAccess<CcrGatewayStatus>(access, 'getGatewayStatus'),
        this.rpcWithAccess<CcrAppConfig>(access, 'getConfig'),
      ]);
      const gatewayState = this.gatewayState(gateway.state);
      const gatewayStateText =
        gatewayState === 'starting'
          ? '启动中'
          : gatewayState === 'stopped'
            ? '已停止'
            : gatewayState === 'unknown'
              ? '未知'
              : gatewayState;
      const lastError = optionalString(gateway.lastError);
      const providers = sanitizeRouterConfig(config);
      return {
        ...installation,
        checkedAt,
        endpoint: optionalString(gateway.endpoint) ?? 'http://127.0.0.1:3456',
        gatewayState,
        installed: true,
        manageable: true,
        managementAvailable: true,
        message:
          gatewayState === 'running'
            ? `路由器网关正在运行，已配置 ${providers.length} 个服务提供方。`
            : gatewayState === 'error'
              ? routerGatewayErrorMessage(providers.length, lastError)
              : `路由器管理服务已运行，网关状态：${gatewayStateText}。`,
        providers,
        serviceRunning: true,
        version: optionalString(appInfo.version) ?? cli?.version,
      };
    } catch (error) {
      const nativeModuleMessage = routerNativeModuleErrorMessage(error);
      return {
        ...installation,
        checkedAt,
        endpoint: 'http://127.0.0.1:3456',
        gatewayState: 'unknown',
        installed: true,
        manageable: Boolean(nativeModuleMessage && cli?.nodeExecutable),
        managementAvailable: false,
        message:
          nativeModuleMessage ??
          'CCR 管理服务响应异常；请重启路由器，或查看终端输出和日志了解详情。',
        providers: [],
        runtimeMismatch: Boolean(nativeModuleMessage),
        serviceRunning: true,
        version: cli?.version,
      };
    }
  }

  public async start(): Promise<ClaudeRouterManagementState> {
    this.emitProgress('start', 'checking', 1, 3, '正在检查 CCR CLI 后台状态。');
    try {
      const state = await this.startInternal();
      const detail =
        state.gatewayState === 'running'
          ? 'CCR CLI 后台与模型网关已就绪。'
          : state.managementAvailable
            ? 'CCR CLI 管理后台已就绪；模型网关正在等待服务商配置。'
            : state.message;
      this.emitProgress('start', 'complete', 3, 3, detail, false);
      return state;
    } catch (error) {
      this.emitProgress('start', 'error', 3, 3, `启动失败：${safeMessage(error)}`, false);
      throw error;
    }
  }

  private async startInternal(): Promise<ClaudeRouterManagementState> {
    const cli = await this.findCliInstallation();
    const desktop = this.findDesktopExecutable();
    const existing = await this.getActiveServiceAccess();
    if (existing) {
      const runtimeKind = await this.serviceRuntimeKind(existing, desktop);
      if (cli?.nodeExecutable && runtimeKind === 'claudedock') {
        await this.restartCliService(cli, existing);
        return this.getState();
      }
      if (runtimeKind !== 'cli') {
        throw new Error(
          '检测到非 CLI 的 CCR 后台正在运行；为保护 Claude/Codex App，ClaudeDock 不会接管或终止它。',
        );
      }
      try {
        await this.rpcWithAccess(existing, 'startGateway');
      } catch (error) {
        if (!routerNativeModuleMismatch(error) || !cli?.nodeExecutable) {
          throw error;
        }
        await this.restartCliService(cli, existing);
      }
      return this.getState();
    }

    if (cli) {
      if ((versionMajor(cli.version) ?? 0) < 3) {
        throw new Error('一键管理要求 Claude Code 路由器 3.x，请先升级。');
      }
      await this.startCliService(cli);
      this.emitProgress('start', 'starting', 2, 3, 'CCR CLI 管理服务已启动，正在启动模型网关。');
    } else {
      throw new Error('未找到 Claude Code Router CLI，请先由 ClaudeDock 在后台安装。');
    }

    const access = await this.waitForActiveService();
    await this.rpcWithAccess(access, 'startGateway');
    return this.getState();
  }

  public async stop(): Promise<ClaudeRouterManagementState> {
    this.emitProgress('stop', 'stopping', 1, 2, '正在停止 ClaudeDock 管理的 CCR CLI 后台。');
    const access = await this.getActiveServiceAccess();
    if (!access) {
      const state = await this.getState();
      this.emitProgress('stop', 'complete', 2, 2, 'CCR CLI 后台已经停止。', false);
      return state;
    }
    try {
      await this.stopCliService(access, this.findDesktopExecutable());
      const state = await this.getState();
      this.emitProgress('stop', 'complete', 2, 2, 'CCR CLI 后台与网关已停止。', false);
      return state;
    } catch (error) {
      this.emitProgress('stop', 'error', 2, 2, `停止失败：${safeMessage(error)}`, false);
      throw error;
    }
  }

  public async managementUrl(): Promise<string> {
    const access = await this.getActiveServiceAccess();
    if (
      !access ||
      (await this.serviceRuntimeKind(access, this.findDesktopExecutable())) !== 'cli'
    ) {
      throw new Error('CCR CLI 后台没有运行，无法打开管理页。');
    }
    return access.managementUrl;
  }

  public async saveProvider(rawInput: SaveClaudeRouterProviderInput): Promise<SavedRouterProvider> {
    this.emitProgress('configure', 'configuring', 1, 2, '正在写入服务提供方与模型映射（仅 CLI）。');
    try {
      const result = await this.saveProviderInternal(rawInput);
      this.emitProgress('configure', 'complete', 2, 2, 'CLI 路由配置已保存并校验。', false);
      return result;
    } catch (error) {
      this.emitProgress('configure', 'error', 2, 2, `配置失败：${safeMessage(error)}`, false);
      throw error;
    }
  }

  private async saveProviderInternal(
    rawInput: SaveClaudeRouterProviderInput,
  ): Promise<SavedRouterProvider> {
    const input = normalizeRouterProviderInput(rawInput);
    let access = await this.getActiveServiceAccess();
    if (!access) {
      try {
        await this.startInternal();
      } catch (error) {
        // Some CCR builds report “no models” as an error even though their CLI management service
        // is now healthy. That state is exactly what the first Provider save is meant to repair.
        access = await this.getActiveServiceAccess();
        if (!access) {
          throw error;
        }
      }
      access ??= await this.requireActiveService();
    }
    await this.requireCliOwnedService(access);
    const current = await this.rpcWithAccess<CcrAppConfig>(access, 'getConfig');
    const updated = buildUpdatedRouterConfig(current, input);
    const saved = await this.saveConfigWithoutProfileTakeover(access, updated.config, [
      input.apiKey ?? '',
    ]);
    // A fresh CCR service intentionally keeps port 3456 stopped until its first provider exists.
    // Start it here, after the provider is valid, so the one-click path never sends users to the
    // management page to perform the missing middle step themselves.
    await this.rpcWithAccess(access, 'startGateway');
    let state = await this.getState();
    const gatewayDeadline = Date.now() + 10_000;
    while (state.gatewayState !== 'running' && Date.now() < gatewayDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await this.getState();
    }
    if (state.gatewayState !== 'running') {
      throw new Error(`服务提供方已保存，但 CCR 模型接口自动启动失败：${state.message}`);
    }
    const provider = state.providers.find((item) => item.id === updated.providerId);
    if (!provider) {
      throw new Error('CCR 已保存配置，但没有返回对应服务提供方。');
    }
    return {
      connection: {
        apiKey: readGatewayApiKey(saved),
        baseUrl: state.endpoint,
        model: `${provider.name}/${provider.models[0]}`,
      },
      provider,
      state,
    };
  }

  public async deleteProvider(providerId: string): Promise<ClaudeRouterManagementState> {
    const access = await this.requireActiveService();
    await this.requireCliOwnedService(access);
    const current = await this.rpcWithAccess<CcrAppConfig>(access, 'getConfig');
    const updated = buildDeletedRouterConfig(current, providerId);
    await this.saveConfigWithoutProfileTakeover(access, updated);
    return this.getState();
  }

  protected override async findCliInstallation(): Promise<CcrCliInstallation | undefined> {
    const directories = new Set<string>();
    try {
      const result = await execFileAsync('where.exe', ['ccr'], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      });
      for (const line of result.stdout.split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate && path.isAbsolute(candidate)) {
          directories.add(path.dirname(candidate));
        }
      }
    } catch {
      // Fall through to the standard npm location.
    }
    directories.add(path.join(appDataRoot(), 'npm'));

    for (const directory of directories) {
      const packageRoot = path.join(directory, 'node_modules', '@musistudio', 'claude-code-router');
      const packageFile = path.join(packageRoot, 'package.json');
      const cliPath = path.join(packageRoot, 'dist', 'main', 'cli.js');
      if (!existsSync(packageFile) || !existsSync(cliPath)) {
        continue;
      }
      try {
        const parsed = readJsonFile(packageFile) as Record<string, unknown>;
        const version = optionalString(parsed.version);
        if (version && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
          return {
            cliPath,
            installDirectory: directory,
            nodeExecutable: await this.findCompatibleNodeExecutable(directory, packageRoot),
            packageRoot,
            version,
          };
        }
      } catch {
        // Try the next installation candidate.
      }
    }
    return undefined;
  }

  private async findCompatibleNodeExecutable(
    installationDirectory: string,
    packageRoot: string,
  ): Promise<string | undefined> {
    const candidates = new Set<string>();
    const localNode = path.join(installationDirectory, 'node.exe');
    if (existsSync(localNode)) {
      candidates.add(localNode);
    }
    try {
      const result = await execFileAsync('where.exe', ['node'], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      });
      for (const line of result.stdout.split(/\r?\n/)) {
        const candidate = line.trim();
        if (
          candidate &&
          path.isAbsolute(candidate) &&
          path.basename(candidate).toLowerCase() === 'node.exe' &&
          existsSync(candidate)
        ) {
          candidates.add(candidate);
        }
      }
    } catch {
      // A local Node next to the npm prefix may still be available.
    }
    if (
      path.basename(process.execPath).toLowerCase() === 'node.exe' &&
      existsSync(process.execPath)
    ) {
      candidates.add(process.execPath);
    }

    const nativeBinding = path.join(
      packageRoot,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    );
    for (const candidate of candidates) {
      try {
        const args = existsSync(nativeBinding)
          ? [
              '-e',
              'require(process.argv[1]); process.stdout.write(process.versions.modules || "")',
              nativeBinding,
            ]
          : ['-e', 'process.stdout.write(process.versions.modules || "")'];
        await execFileAsync(candidate, args, {
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
          timeout: 5_000,
          windowsHide: true,
        });
        return candidate;
      } catch {
        // Try another installed Node runtime.
      }
    }
    return undefined;
  }

  private nodeEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    return environment;
  }

  private async serviceRuntimeKind(
    access: CcrServiceAccess,
    desktopExecutable?: string,
  ): Promise<'claudedock' | 'cli' | 'desktop' | 'unknown'> {
    /*
     * Keyed on the service token as well as the PID. Windows recycles PIDs aggressively, so a cache
     * keyed on the PID alone let a freshly started CCR Desktop service inherit the `cli`
     * classification of a dead CLI service that happened to hold the same PID — which would then
     * authorise mutations ClaudeDock must never make to a Desktop-owned service.
     */
    if (
      this.serviceRuntimeCache?.pid === access.pid &&
      this.serviceRuntimeCache.serviceToken === access.serviceToken
    ) {
      return this.serviceRuntimeCache.kind;
    }
    let kind: 'claudedock' | 'cli' | 'desktop' | 'unknown' = 'unknown';
    try {
      const result = await execFileAsync(
        'tasklist.exe',
        ['/FI', `PID eq ${access.pid}`, '/FO', 'CSV', '/NH'],
        {
          encoding: 'buffer',
          maxBuffer: 64 * 1024,
          timeout: 3_000,
          windowsHide: true,
        },
      );
      const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
      const images = tasklistImageNames(bytes).map((imageName) =>
        path.basename(imageName).toLowerCase(),
      );
      const appImage = path.basename(process.execPath).toLowerCase();
      const desktopImage = desktopExecutable
        ? path.basename(desktopExecutable).toLowerCase()
        : undefined;
      if (images.includes('node.exe')) {
        kind = 'cli';
      } else if (appImage !== 'node.exe' && images.includes(appImage)) {
        kind = 'claudedock';
      } else if (desktopImage && images.includes(desktopImage)) {
        kind = 'desktop';
      }
    } catch {
      kind = 'unknown';
    }
    this.serviceRuntimeCache = { kind, pid: access.pid, serviceToken: access.serviceToken };
    return kind;
  }

  /**
   * Gate for every Provider mutation.
   *
   * ClaudeDock only manages the CCR CLI service it starts itself; a Desktop installation owns its
   * own configuration and must not be reconfigured from here. `stopCliService` already refuses
   * non-CLI runtimes, but `saveProvider` and `deleteProvider` used to go straight to
   * `getConfig`/`saveConfig`, so a Desktop-owned service could be reconfigured through the RPC
   * before anything checked ownership.
   */
  private async requireCliOwnedService(access: CcrServiceAccess): Promise<void> {
    const runtimeKind = await this.serviceRuntimeKind(access, this.findDesktopExecutable());
    if (runtimeKind !== 'cli' && runtimeKind !== 'claudedock') {
      throw new Error(
        runtimeKind === 'desktop'
          ? '检测到 CCR 桌面版正在托管该服务，ClaudeDock 不会修改它的配置。'
          : '无法确认 CCR 服务归属，已停止修改配置以免影响桌面版。',
      );
    }
  }

  protected override async stopCliService(
    access: CcrServiceAccess,
    desktopExecutable?: string,
  ): Promise<void> {
    const runtimeKind = await this.serviceRuntimeKind(access, desktopExecutable);
    if (runtimeKind !== 'cli' && runtimeKind !== 'claudedock') {
      throw new Error(
        '检测到的 CCR 后台不是 ClaudeDock 管理的 CLI 进程；为保护 Claude/Codex App，已拒绝终止。',
      );
    }
    if (access.pid === process.pid) {
      throw new Error('拒绝终止 ClaudeDock 主进程；请完全退出旧版本后重试。');
    }
    try {
      await this.rpcWithAccess(access, 'stopGateway');
    } catch {
      // The service process can still be terminated when the gateway RPC is unavailable.
    }
    try {
      process.kill(access.pid, 'SIGTERM');
    } catch (error) {
      if (!isRecord(error) || (error.code !== 'ESRCH' && error.code !== 'EINVAL')) {
        throw error;
      }
    }
    const stoppedAt = Date.now();
    while (Date.now() - stoppedAt < 10_000 && this.processIsRunning(access.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.processIsRunning(access.pid)) {
      throw new Error('CCR CLI 后台没有在 10 秒内退出，请完全退出相关 CLI 进程后重试。');
    }
    this.serviceRuntimeCache = undefined;
  }

  private async startCliService(cli: CcrCliInstallation): Promise<void> {
    if (!cli.nodeExecutable) {
      throw new Error(
        'CCR 已安装，但没有找到能加载 better-sqlite3 的系统 Node.js；请安装或更新官方版路由器。',
      );
    }
    const command = routerCliStartSpec(cli.nodeExecutable, cli.cliPath);
    await execFileAsync(command.executable, command.args, {
      encoding: 'utf8',
      env: this.nodeEnvironment(),
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
  }

  private async restartCliService(
    cli: CcrCliInstallation,
    access: CcrServiceAccess,
  ): Promise<void> {
    if (!cli.nodeExecutable) {
      throw new Error('没有找到与 CCR 原生模块兼容的系统 Node.js。');
    }
    if (access.pid === process.pid) {
      throw new Error('拒绝终止 ClaudeDock 主进程；请彻底退出旧版后重新打开。');
    }
    try {
      process.kill(access.pid, 'SIGTERM');
    } catch (error) {
      if (!isRecord(error) || (error.code !== 'ESRCH' && error.code !== 'EINVAL')) {
        throw error;
      }
    }
    const stoppedAt = Date.now();
    while (Date.now() - stoppedAt < 10_000 && this.processIsRunning(access.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.processIsRunning(access.pid)) {
      throw new Error('旧 CCR 服务没有在 10 秒内退出，请彻底退出旧版 ClaudeDock 后重试。');
    }
    this.serviceRuntimeCache = undefined;
    await this.startCliService(cli);
    await this.waitForActiveService();
  }

  private processIsRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isRecord(error) && error.code === 'EPERM';
    }
  }

  protected override findDesktopExecutable(): string | undefined {
    const root = localAppDataRoot();
    const candidates = [
      path.join(root, 'Programs', 'claude-code-router', 'Claude Code Router.exe'),
      path.join(root, 'Programs', 'Claude Code Router', 'Claude Code Router.exe'),
      path.join(root, 'Claude Code Router', 'Claude Code Router.exe'),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  private serviceFile(): string {
    return path.join(appDataRoot(), 'claude-code-router', 'service.json');
  }

  private readServiceAccess(): CcrServiceAccess {
    const parsed = readJsonFile(this.serviceFile());
    if (!isRecord(parsed)) {
      throw new Error('CCR service.json 格式无效。');
    }
    const urlText = optionalString(parsed.url);
    const serviceToken = optionalString(parsed.serviceToken);
    const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
    if (!urlText || !serviceToken || !Number.isInteger(pid) || pid <= 0) {
      throw new Error('CCR service.json 缺少必要字段。');
    }
    const url = new URL(urlText);
    if (
      url.protocol !== 'http:' ||
      !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password
    ) {
      throw new Error('CCR 管理服务不是受支持的本机地址。');
    }
    const webToken = url.searchParams.get('ccr_web_token')?.trim() ?? '';
    if (webToken.length < 20 || webToken.length > 300 || serviceToken.length > 300) {
      throw new Error('CCR 管理令牌格式无效。');
    }
    const origin = url.origin;
    return {
      managementUrl: url.toString(),
      origin,
      pid,
      serviceToken,
      webToken,
    };
  }

  protected override async getActiveServiceAccess(): Promise<CcrServiceAccess | undefined> {
    if (!existsSync(this.serviceFile())) {
      return undefined;
    }
    try {
      const access = this.readServiceAccess();
      const identity = await this.rpcWithAccess<Record<string, unknown>>(
        access,
        'getServiceIdentity',
        [access.serviceToken],
        [access.serviceToken, access.webToken],
      );
      if (identity.serviceTokenMatches !== true || identity.pid !== access.pid) {
        return undefined;
      }
      return access;
    } catch {
      return undefined;
    }
  }

  private async requireActiveService(): Promise<CcrServiceAccess> {
    const access = await this.getActiveServiceAccess();
    if (!access) {
      throw new Error('CCR 管理服务没有运行，请先点击“启动路由器”。');
    }
    return access;
  }

  private async waitForActiveService(): Promise<CcrServiceAccess> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < SERVICE_WAIT_MS) {
      const access = await this.getActiveServiceAccess();
      if (access) {
        return access;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('等待 CCR 管理服务启动超时。');
  }

  /**
   * The only allowed CCR saveConfig call. ClaudeDock manages CLI routing only, so profile takeover
   * is forced off here instead of relying on every caller to remember a security-sensitive flag.
   */
  private saveConfigWithoutProfileTakeover(
    access: CcrServiceAccess,
    config: CcrAppConfig,
    secrets: string[] = [],
  ): Promise<CcrAppConfig> {
    return this.rpcWithAccess<CcrAppConfig>(
      access,
      'saveConfig',
      [config, { applyProfile: false }],
      secrets,
    );
  }

  private async rpcWithAccess<T>(
    access: CcrServiceAccess,
    method: string,
    args: unknown[] = [],
    secrets: string[] = [],
  ): Promise<T> {
    const response = await fetch(`${access.origin}/api/ccr/rpc`, {
      body: JSON.stringify({ args, method }),
      headers: {
        'content-type': 'application/json',
        'x-ccr-web-auth': access.webToken,
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RPC_RESPONSE_BYTES) {
      throw new Error('CCR 管理响应超过允许大小。');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RPC_RESPONSE_BYTES) {
      throw new Error('CCR 管理响应超过允许大小。');
    }
    let payload: CcrRpcSuccess<T> | CcrRpcFailure;
    try {
      payload = JSON.parse(bytes.toString('utf8')) as CcrRpcSuccess<T> | CcrRpcFailure;
    } catch {
      throw new Error(`CCR 管理接口返回了无效 JSON（HTTP ${response.status}）。`);
    }
    if (!response.ok || payload.ok !== true) {
      const message =
        payload.ok === false && typeof payload.error?.message === 'string'
          ? payload.error.message
          : `CCR 管理接口返回 HTTP ${response.status}。`;
      throw new Error(safeMessage(message, [access.webToken, access.serviceToken, ...secrets]));
    }
    return payload.value;
  }

  private gatewayState(value: unknown): ClaudeRouterGatewayState {
    return value === 'error' || value === 'running' || value === 'starting' || value === 'stopped'
      ? value
      : 'unknown';
  }
}
