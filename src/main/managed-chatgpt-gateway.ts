import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ManagedChatGptGatewayState } from '../shared/contracts';
import type { BusyRegistry } from './busy-registry';
import type { DownloadEngine } from './download-engine';
import { discoverOpenAiModels } from './provider-model-discovery';
import { runProcess } from './windows-command';

const RELEASE_API = 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest';
const MAX_RELEASE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DEFAULT_PORT = 8317;
const LAST_PORT = 8327;
const OAUTH_DEFAULT_PORT = 1455;
const OAUTH_LAST_PORT = 1465;
const START_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const execFileAsync = promisify(execFile);

interface SafeStorageLike {
  decryptString: (encrypted: Buffer) => string;
  encryptString: (plainText: string) => Buffer;
  isEncryptionAvailable: () => boolean;
}

interface PersistedGatewayState {
  encryptedClientKey: string;
  encryptedManagementKey?: string;
  executableRelativePath: string;
  executableSha256: string;
  installedVersion: string;
  port: number;
  processId?: number;
  releaseDigest: string;
  version: 1;
}

interface CliProxyApiReleaseAsset {
  browser_download_url?: unknown;
  digest?: unknown;
  name?: unknown;
  size?: unknown;
}

interface CliProxyApiReleasePayload {
  assets?: unknown;
  tag_name?: unknown;
}

export interface CliProxyApiRelease {
  digest: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  version: string;
}

export interface ManagedChatGptGatewayProjectConfig {
  availableModels: string[];
  baseUrl: string;
  credential: string;
  model: string;
  modelFast: string;
}

export type ManagedChatGptSetupReporter = (step: number, detail: string) => void;

export interface ManagedChatGptGatewayManagementAccess {
  managementKey: string;
  url: string;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const sha256File = (filePath: string): string =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

const nonChatModel = /(?:audio|embedding|image|moderation|realtime|speech|transcri|tts|whisper)/i;

export const recommendedChatModel = (models: readonly string[]): string => {
  if (models.length === 0) {
    throw new Error('网关没有返回可用模型。');
  }
  const preferred = ['gpt-5.6-sol', 'gpt-5.6', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'];
  return (
    preferred.find((candidate) => models.includes(candidate)) ??
    models.find((candidate) => !nonChatModel.test(candidate) && !/mini|nano/i.test(candidate)) ??
    models.find((candidate) => !nonChatModel.test(candidate)) ??
    models[0]!
  );
};

const recommendedFastModel = (models: readonly string[], fallback: string): string =>
  models.find((candidate) => !nonChatModel.test(candidate) && /mini|nano|flash/i.test(candidate)) ??
  fallback;

const MANAGED_GATEWAY_ROUTE_ENVIRONMENT_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_AGENT_',
  'CLAUDE_CODE_',
  'CODEX_',
  'CODEXL_',
  'CCR_',
  'OPENAI_',
] as const;

/**
 * The managed gateway must authenticate and route with its app-owned config/auth directory only.
 * Transport proxy variables remain available because they describe how to reach the official
 * endpoint, while provider credentials and base-URL overrides could silently send the request to
 * a relay inherited from the process that launched ClaudeDock.
 */
export const buildManagedGatewayEnvironment = (
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized === 'ELECTRON_RUN_AS_NODE' ||
      MANAGED_GATEWAY_ROUTE_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      delete environment[key];
    }
  }
  return environment;
};

const limitedResponseBody = async (response: Response, maximumBytes: number): Promise<Buffer> => {
  if (!response.ok) {
    throw new Error(`无法读取 CLIProxyAPI 发布信息：HTTP ${response.status}。`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('CLIProxyAPI 发布信息超过安全大小上限。');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maximumBytes) {
    throw new Error('CLIProxyAPI 发布信息超过安全大小上限。');
  }
  return body;
};

export const parseCliProxyApiRelease = (value: unknown): CliProxyApiRelease => {
  if (!value || typeof value !== 'object') {
    throw new Error('CLIProxyAPI 发布信息格式无效。');
  }
  const release = value as CliProxyApiReleasePayload;
  if (typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('CLIProxyAPI 发布版本格式无效。');
  }
  const version = release.tag_name.slice(1);
  const expectedName = `CLIProxyAPI_${version}_windows_amd64.zip`;
  const asset = Array.isArray(release.assets)
    ? release.assets.find(
        (candidate): candidate is CliProxyApiReleaseAsset =>
          Boolean(candidate) &&
          typeof candidate === 'object' &&
          (candidate as CliProxyApiReleaseAsset).name === expectedName,
      )
    : undefined;
  if (
    !asset ||
    typeof asset.browser_download_url !== 'string' ||
    typeof asset.digest !== 'string' ||
    typeof asset.size !== 'number'
  ) {
    throw new Error('CLIProxyAPI 最新发布缺少可验证的 Windows x64 压缩包。');
  }
  const url = new URL(asset.browser_download_url);
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1]?.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.pathname !==
      `/router-for-me/CLIProxyAPI/releases/download/${release.tag_name}/${expectedName}` ||
    !digest ||
    !Number.isInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_ARCHIVE_BYTES
  ) {
    throw new Error('CLIProxyAPI 压缩包未通过来源、版本、大小或 SHA-256 元数据检查。');
  }
  return {
    digest,
    downloadUrl: asset.browser_download_url,
    fileName: expectedName,
    size: asset.size,
    version,
  };
};

export const archiveEntriesAreSafe = (entries: string[]): boolean =>
  entries.length > 0 &&
  entries.length <= 500 &&
  entries.every((entry) => {
    const normalized = entry.trim().replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      return false;
    }
    const segments = normalized.split('/').filter(Boolean);
    return segments.length > 0 && !segments.includes('..');
  });

export const buildManagedGatewayConfig = (input: {
  authDirectory: string;
  clientKey: string;
  managementKey: string;
  port: number;
}): string => {
  if (
    !path.isAbsolute(input.authDirectory) ||
    !/^sk-claudedock-[A-Za-z0-9_-]{32,}$/.test(input.clientKey) ||
    !/^mgmt-claudedock-[A-Za-z0-9_-]{32,}$/.test(input.managementKey) ||
    !Number.isInteger(input.port) ||
    input.port < DEFAULT_PORT ||
    input.port > LAST_PORT
  ) {
    throw new Error('ClaudeDock 托管网关配置参数无效。');
  }
  return [
    'host: "127.0.0.1"',
    `port: ${input.port}`,
    'tls:',
    '  enable: false',
    'remote-management:',
    '  allow-remote: false',
    `  secret-key: ${JSON.stringify(input.managementKey)}`,
    '  disable-control-panel: false',
    '  disable-auto-update-panel: true',
    '  panel-github-repository: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"',
    `auth-dir: ${JSON.stringify(input.authDirectory.replaceAll('\\', '/'))}`,
    'api-keys:',
    `  - ${JSON.stringify(input.clientKey)}`,
    'debug: false',
    'logging-to-file: false',
    'usage-statistics-enabled: false',
    '',
  ].join('\n');
};

const portIsAvailable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });

const findAvailablePort = async (
  firstPort: number,
  lastPort: number,
  purpose: string,
): Promise<number> => {
  for (let port = firstPort; port <= lastPort; port += 1) {
    if (await portIsAvailable(port)) {
      return port;
    }
  }
  throw new Error(`本机 ${firstPort}–${lastPort} 端口均被占用，无法${purpose}。`);
};

const safeErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/mgmt-claudedock-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏]')
    .replace(/https?:\/\/localhost:\d+\/[^\s]+/gi, '[本机回调地址]')
    .replace(/https?:\/\/127\.0\.0\.1:\d+\/[^\s]+/gi, '[本机回调地址]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
};

export class ManagedChatGptGateway {
  private readonly authDirectory: string;
  private readonly configPath: string;
  private readonly downloadsDirectory: string;
  private readonly rootDirectory: string;
  private readonly statePath: string;
  private readonly versionsDirectory: string;
  private process?: ChildProcess;
  private spawnedExecutablePath?: string;
  private setupInFlight?: Promise<ManagedChatGptGatewayProjectConfig>;

  public constructor(
    userDataPath: string,
    private readonly downloadEngine: DownloadEngine,
    private readonly busyRegistry: BusyRegistry,
    private readonly safeStorage: SafeStorageLike,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.rootDirectory = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    this.authDirectory = path.join(this.rootDirectory, 'auth');
    this.configPath = path.join(this.rootDirectory, 'config.yaml');
    this.downloadsDirectory = path.join(this.rootDirectory, 'downloads');
    this.statePath = path.join(this.rootDirectory, 'state.json');
    this.versionsDirectory = path.join(this.rootDirectory, 'versions');
  }

  public async getState(): Promise<ManagedChatGptGatewayState> {
    const busy = Boolean(this.setupInFlight);
    const persisted = this.loadState();
    const installed = Boolean(persisted && this.executableIsValid(persisted));
    const authenticated = this.hasAuthentication();
    const clientKey = persisted ? this.decryptClientKey(persisted) : undefined;
    const managementKey = persisted ? this.decryptManagementKey(persisted) : undefined;
    const availableModels =
      !busy && persisted && clientKey
        ? await this.availableModels(persisted, clientKey).catch(() => [])
        : [];
    const running = availableModels.length > 0;
    const endpoint = `http://127.0.0.1:${persisted?.port ?? DEFAULT_PORT}`;
    const phase = busy
      ? 'installing'
      : !installed
        ? 'not-installed'
        : !authenticated
          ? 'login-required'
          : running
            ? 'ready'
            : 'stopped';
    const message =
      phase === 'installing'
        ? '正在下载、校验并配置托管网关；完成前无需重复点击。'
        : phase === 'not-installed'
          ? '尚未安装 ClaudeDock 托管网关。'
          : phase === 'login-required'
            ? `CLIProxyAPI ${persisted?.installedVersion ?? ''} 已安装，等待 OpenAI 授权。`
            : phase === 'ready'
              ? `CLIProxyAPI ${persisted?.installedVersion ?? ''} 已在本机安全运行。`
              : `CLIProxyAPI ${persisted?.installedVersion ?? ''} 已授权，启动 Claude Code 时会自动运行。`;
    return {
      availableModels,
      authenticated,
      busy,
      checkedAt: Date.now(),
      endpoint,
      installed,
      managementAvailable: Boolean(running && managementKey),
      message,
      phase,
      running,
      usageStatisticsEnabled: false,
      version: installed ? persisted?.installedVersion : undefined,
    };
  }

  /** Reads only ClaudeDock's validated state file; it never starts or probes the gateway. */
  public getInstalledVersion(): string | undefined {
    return this.loadState()?.installedVersion;
  }

  public async setup(
    forceLogin = false,
    report?: ManagedChatGptSetupReporter,
  ): Promise<ManagedChatGptGatewayProjectConfig> {
    if (this.setupInFlight) {
      return this.setupInFlight;
    }
    const operation = this.setupInternal(forceLogin, report);
    this.setupInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.setupInFlight === operation) {
        this.setupInFlight = undefined;
      }
    }
  }

  private async setupInternal(
    forceLogin: boolean,
    report?: ManagedChatGptSetupReporter,
  ): Promise<ManagedChatGptGatewayProjectConfig> {
    const releaseBusy = this.busyRegistry.acquire({
      cancellable: false,
      id: 'managed-gateway:chatgpt-setup',
      kind: 'configure',
      label: '正在安装并配置 ChatGPT 托管网关',
      severity: 'blocking',
    });
    try {
      report?.(3, '正在检查 CLIProxyAPI 的受信任上游版本。');
      let persisted = await this.installLatest(report);
      report?.(4, '正在生成仅限本机的网关配置与独立访问密钥。');
      persisted = await this.ensureConfiguration(persisted);
      if (forceLogin || !this.hasAuthentication()) {
        report?.(5, '正在等待你在 OpenAI 官方页面完成授权。');
        await this.login(persisted);
      }
      report?.(6, '授权已确认，正在启动本机模型接口并读取可用模型。');
      await this.start(persisted);
      return this.projectConfiguration(persisted);
    } finally {
      releaseBusy();
    }
  }

  public async configurationForModel(model?: string): Promise<ManagedChatGptGatewayProjectConfig> {
    const persisted = this.loadState();
    if (!persisted || !this.executableIsValid(persisted) || !this.hasAuthentication()) {
      throw new Error('ChatGPT 托管网关尚未完成一键安装与 OpenAI 授权。');
    }
    const configured = await this.ensureConfiguration(persisted);
    await this.start(configured);
    return this.projectConfiguration(configured, model);
  }

  public async ensureRunning(): Promise<void> {
    const persisted = this.loadState();
    if (!persisted || !this.executableIsValid(persisted) || !this.hasAuthentication()) {
      throw new Error('ChatGPT 托管网关尚未完成一键安装与 OpenAI 授权。');
    }
    await this.start(await this.ensureConfiguration(persisted));
  }

  public async managementAccess(): Promise<ManagedChatGptGatewayManagementAccess> {
    const persisted = this.loadState();
    const managementKey = persisted ? this.decryptManagementKey(persisted) : undefined;
    const clientKey = persisted ? this.decryptClientKey(persisted) : undefined;
    if (
      !persisted ||
      !managementKey ||
      !clientKey ||
      !this.executableIsValid(persisted) ||
      !(await this.probe(persisted.port, clientKey))
    ) {
      throw new Error('ChatGPT 托管网关当前没有运行，无法打开后台。');
    }
    return {
      managementKey,
      url: `http://127.0.0.1:${persisted.port}/management.html`,
    };
  }

  public async stop(): Promise<void> {
    const state = this.loadState();
    if (!state) {
      this.stopProcess();
      return;
    }
    await this.stopProcessesForState(state, 'ChatGPT 本地网关停止后端口仍被占用。');
  }

  public shutdown(): void {
    // Keep the persisted PID until the child really exits. If the app terminates first, the next
    // instance can still verify and reconcile the exact managed process instead of trusting a port.
    this.stopProcess();
  }

  private async latest(): Promise<CliProxyApiRelease> {
    const response = await this.fetchImplementation(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ClaudeDock',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await limitedResponseBody(response, MAX_RELEASE_BYTES);
    return parseCliProxyApiRelease(JSON.parse(body.toString('utf8')) as unknown);
  }

  private async installLatest(
    report?: ManagedChatGptSetupReporter,
  ): Promise<PersistedGatewayState | undefined> {
    const current = this.loadState();
    let release: CliProxyApiRelease;
    try {
      release = await this.latest();
    } catch (error) {
      if (current && this.executableIsValid(current)) {
        return current;
      }
      throw error;
    }
    if (current?.installedVersion === release.version && this.executableIsValid(current)) {
      report?.(3, `CLIProxyAPI ${release.version} 已安装，正在复用现有文件。`);
      return current;
    }
    report?.(3, `正在下载并校验 CLIProxyAPI ${release.version}。`);
    mkdirSync(this.downloadsDirectory, { recursive: true });
    mkdirSync(this.versionsDirectory, { recursive: true });
    const archivePath = path.join(this.downloadsDirectory, release.fileName);
    await this.downloadEngine.start({
      allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
      allowedPathPrefixes: [
        `/router-for-me/CLIProxyAPI/releases/download/v${release.version}/${release.fileName}`,
        '/',
      ],
      expectedBytes: release.size,
      expectedSha256: release.digest,
      finalPath: archivePath,
      id: `managed-cliproxyapi-${release.version}`,
      label: `CLIProxyAPI ${release.version} 上游发布包`,
      maxBytes: MAX_ARCHIVE_BYTES,
      url: release.downloadUrl,
    });
    const relativeExecutable = await this.extractRelease(archivePath, release.version);
    const executableSha256 = sha256File(path.resolve(this.rootDirectory, relativeExecutable));
    if (current) {
      report?.(4, `正在停止 CLIProxyAPI ${current.installedVersion}，准备切换版本。`);
      await this.stopProcessesForState(
        current,
        '旧版 CLIProxyAPI 停止后端口仍被占用，已拒绝切换安装版本。',
      );
    }
    const next: PersistedGatewayState = {
      encryptedClientKey: current?.encryptedClientKey ?? '',
      encryptedManagementKey: current?.encryptedManagementKey,
      executableRelativePath: relativeExecutable,
      executableSha256,
      installedVersion: release.version,
      port: current?.port ?? 0,
      releaseDigest: release.digest,
      version: 1,
    };
    this.persistState(next);
    report?.(4, `CLIProxyAPI ${release.version} 已校验并安装完成。`);
    return next;
  }

  private async extractRelease(archivePath: string, version: string): Promise<string> {
    const environment = buildManagedGatewayEnvironment();
    const list = await runProcess('tar.exe', ['-tf', archivePath], environment, {
      maxBuffer: 512 * 1024,
      timeout: 30_000,
    });
    const entries = list.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!archiveEntriesAreSafe(entries)) {
      throw new Error('CLIProxyAPI 压缩包包含不安全路径，已拒绝解压。');
    }
    const executableEntry = entries.find(
      (entry) =>
        path.posix.basename(entry.replaceAll('\\', '/')).toLowerCase() === 'cli-proxy-api.exe',
    );
    if (!executableEntry) {
      throw new Error('CLIProxyAPI 压缩包中没有找到预期的 Windows 可执行文件。');
    }
    const staging = path.join(this.versionsDirectory, `.staging-${version}-${Date.now()}`);
    const finalDirectory = path.join(this.versionsDirectory, version);
    mkdirSync(staging, { recursive: true });
    try {
      await runProcess('tar.exe', ['-xf', archivePath, '-C', staging], environment, {
        maxBuffer: 128 * 1024,
        timeout: 60_000,
      });
      const executableSegments = executableEntry.replaceAll('\\', '/').split('/').filter(Boolean);
      const extractedExecutable = path.resolve(staging, ...executableSegments);
      if (
        !extractedExecutable
          .toLowerCase()
          .startsWith(`${path.resolve(staging).toLowerCase()}${path.sep}`) ||
        !existsSync(extractedExecutable) ||
        !lstatSync(extractedExecutable).isFile() ||
        !realpathSync(extractedExecutable)
          .toLowerCase()
          .startsWith(`${realpathSync(staging).toLowerCase()}${path.sep}`)
      ) {
        throw new Error('CLIProxyAPI 可执行文件没有安全解压到预期目录。');
      }
      this.removeGuardedDirectory(finalDirectory);
      renameSync(staging, finalDirectory);
      return path.relative(this.rootDirectory, path.join(finalDirectory, ...executableSegments));
    } catch (error) {
      this.removeGuardedDirectory(staging);
      throw error;
    }
  }

  private async ensureConfiguration(
    current: PersistedGatewayState | undefined,
  ): Promise<PersistedGatewayState> {
    if (!current || !existsSync(this.executablePath(current))) {
      throw new Error('CLIProxyAPI 尚未正确安装。');
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储当前不可用，拒绝生成或保存托管网关访问密钥。');
    }
    const existingKey = this.decryptClientKey(current);
    const existingManagementKey = this.decryptManagementKey(current);
    const clientKey = existingKey ?? `sk-claudedock-${randomBytes(32).toString('base64url')}`;
    const managementKey =
      existingManagementKey ?? `mgmt-claudedock-${randomBytes(32).toString('base64url')}`;
    const port = current.port || (await findAvailablePort(DEFAULT_PORT, LAST_PORT, '启动托管网关'));
    const next: PersistedGatewayState = {
      ...current,
      encryptedClientKey: this.safeStorage.encryptString(clientKey).toString('base64'),
      encryptedManagementKey: this.safeStorage.encryptString(managementKey).toString('base64'),
      port,
    };
    mkdirSync(this.authDirectory, { recursive: true });
    writeFileSync(
      this.configPath,
      buildManagedGatewayConfig({
        authDirectory: this.authDirectory,
        clientKey,
        managementKey,
        port,
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    this.persistState(next);
    return next;
  }

  private async login(state: PersistedGatewayState): Promise<void> {
    await this.stopProcessesForState(state, 'OpenAI 授权前无法确认旧托管网关已经停止。');
    const executable = this.executablePath(state);
    const callbackPort = await findAvailablePort(
      OAUTH_DEFAULT_PORT,
      OAUTH_LAST_PORT,
      '启动 OpenAI 授权回调',
    );
    let output: { stderr: string; stdout: string };
    try {
      output = await runProcess(
        executable,
        ['-config', this.configPath, '-codex-login', '-oauth-callback-port', String(callbackPort)],
        buildManagedGatewayEnvironment(),
        {
          cwd: path.dirname(executable),
          maxBuffer: 512 * 1024,
          timeout: LOGIN_TIMEOUT_MS,
        },
      );
    } catch (error) {
      throw new Error(`OpenAI 授权未完成：${safeErrorMessage(error)}`, { cause: error });
    }
    const combined = `${output.stdout}\n${output.stderr}`;
    if (!/Codex authentication successful!/i.test(combined) || !this.hasAuthentication()) {
      throw new Error('OpenAI 授权窗口已结束，但没有收到成功凭据；请重试登录。');
    }
  }

  private async start(state: PersistedGatewayState): Promise<void> {
    const credential = this.decryptClientKey(state);
    if (!credential) {
      throw new Error('托管网关本地访问密钥无法解密。');
    }
    if (await this.probe(state.port, credential)) {
      const processId = this.process?.pid ?? state.processId;
      if (processId && (await this.processMatchesState(state, processId))) {
        if (state.processId !== processId) {
          this.persistState({ ...state, processId });
        }
        return;
      }
      throw new Error(
        `本机端口 ${state.port} 上的托管网关可以响应，但进程身份或运行版本无法确认；已拒绝复用。`,
      );
    }
    if (!(await portIsAvailable(state.port))) {
      throw new Error(
        `本机端口 ${state.port} 已被其他程序占用；请关闭冲突程序后重新启动 Claude Code。`,
      );
    }
    this.stopProcess();
    const executable = this.executablePath(state);
    this.process = spawn(executable, ['-config', this.configPath], {
      cwd: path.dirname(executable),
      env: buildManagedGatewayEnvironment(),
      stdio: 'ignore',
      windowsHide: true,
    });
    this.spawnedExecutablePath = executable;
    const child = this.process;
    if (!child.pid) {
      this.stopProcess();
      throw new Error('CLIProxyAPI 后台没有返回有效进程标识。');
    }
    this.persistState({ ...state, processId: child.pid });
    child.once('exit', () => {
      if (this.process === child) {
        this.process = undefined;
        this.spawnedExecutablePath = undefined;
      }
      this.clearPersistedProcessId(child.pid);
    });
    child.once('error', () => {
      if (this.process === child) {
        this.process = undefined;
        this.spawnedExecutablePath = undefined;
      }
      this.clearPersistedProcessId(child.pid);
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.probe(state.port, credential)) {
        return;
      }
      if (!this.process || child.exitCode !== null) {
        break;
      }
      await delay(250);
    }
    this.stopProcess();
    throw new Error('CLIProxyAPI 未能在 20 秒内启动本机模型接口。');
  }

  private async probe(port: number, credential: string): Promise<boolean> {
    return (await this.availableModels({ port }, credential).catch(() => [])).length > 0;
  }

  private availableModels(
    state: Pick<PersistedGatewayState, 'port'>,
    credential: string,
    timeoutMs = 1_500,
  ): Promise<string[]> {
    return discoverOpenAiModels(
      `http://127.0.0.1:${state.port}`,
      credential,
      this.fetchImplementation,
      timeoutMs,
    );
  }

  private async projectConfiguration(
    state: PersistedGatewayState,
    requestedModel?: string,
  ): Promise<ManagedChatGptGatewayProjectConfig> {
    const credential = this.decryptClientKey(state);
    if (!credential) {
      throw new Error('托管网关本地访问密钥无法解密，请重新执行一键配置。');
    }
    const availableModels = await this.availableModels(state, credential, 15_000);
    if (requestedModel && !availableModels.includes(requestedModel)) {
      throw new Error('所选模型已不在网关实时模型列表中，请重新选择。');
    }
    const model = requestedModel ?? recommendedChatModel(availableModels);
    return {
      availableModels,
      baseUrl: `http://127.0.0.1:${state.port}`,
      credential,
      model,
      modelFast: recommendedFastModel(availableModels, model),
    };
  }

  private hasAuthentication(): boolean {
    try {
      return readdirSync(this.authDirectory, { withFileTypes: true }).some(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'),
      );
    } catch {
      return false;
    }
  }

  private loadState(): PersistedGatewayState | undefined {
    try {
      const parsed = JSON.parse(
        readFileSync(this.statePath, 'utf8'),
      ) as Partial<PersistedGatewayState>;
      if (
        parsed.version !== 1 ||
        typeof parsed.encryptedClientKey !== 'string' ||
        (parsed.encryptedManagementKey !== undefined &&
          typeof parsed.encryptedManagementKey !== 'string') ||
        typeof parsed.executableRelativePath !== 'string' ||
        (parsed.processId !== undefined &&
          (!Number.isInteger(parsed.processId) || parsed.processId! <= 0)) ||
        !/^[0-9a-f]{64}$/.test(parsed.executableSha256 ?? '') ||
        !/^\d+\.\d+\.\d+$/.test(parsed.installedVersion ?? '') ||
        !/^[0-9a-f]{64}$/.test(parsed.releaseDigest ?? '') ||
        !Number.isInteger(parsed.port) ||
        (parsed.port !== 0 && (parsed.port! < DEFAULT_PORT || parsed.port! > LAST_PORT))
      ) {
        return undefined;
      }
      const candidate = parsed as PersistedGatewayState;
      this.executablePath(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }

  private persistState(state: PersistedGatewayState): void {
    mkdirSync(this.rootDirectory, { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, this.statePath);
  }

  private decryptClientKey(state: PersistedGatewayState): string | undefined {
    if (!state.encryptedClientKey || !this.safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      const value = this.safeStorage.decryptString(Buffer.from(state.encryptedClientKey, 'base64'));
      return /^sk-claudedock-[A-Za-z0-9_-]{32,}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private decryptManagementKey(state: PersistedGatewayState): string | undefined {
    if (!state.encryptedManagementKey || !this.safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      const value = this.safeStorage.decryptString(
        Buffer.from(state.encryptedManagementKey, 'base64'),
      );
      return /^mgmt-claudedock-[A-Za-z0-9_-]{32,}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private executablePath(state: PersistedGatewayState): string {
    const resolved = path.resolve(this.rootDirectory, state.executableRelativePath);
    const versionsRoot = path.resolve(this.versionsDirectory);
    if (
      !resolved.toLowerCase().startsWith(`${versionsRoot.toLowerCase()}${path.sep}`) ||
      path.basename(resolved).toLowerCase() !== 'cli-proxy-api.exe'
    ) {
      throw new Error('托管网关可执行文件路径无效。');
    }
    return resolved;
  }

  private executableIsValid(state: PersistedGatewayState): boolean {
    try {
      const executable = this.executablePath(state);
      return (
        existsSync(executable) &&
        lstatSync(executable).isFile() &&
        sha256File(executable) === state.executableSha256
      );
    } catch {
      return false;
    }
  }

  private removeGuardedDirectory(target: string): void {
    const resolved = path.resolve(target);
    const versionsRoot = path.resolve(this.versionsDirectory);
    if (
      path.dirname(resolved).toLowerCase() !== versionsRoot.toLowerCase() ||
      !path.basename(resolved) ||
      path.basename(resolved) === '.'
    ) {
      throw new Error('拒绝清理不在托管网关版本目录内的路径。');
    }
    rmSync(resolved, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
  }

  private clearPersistedProcessId(expectedProcessId?: number): void {
    const current = this.loadState();
    if (
      current?.processId &&
      (expectedProcessId === undefined || current.processId === expectedProcessId)
    ) {
      this.persistState({ ...current, processId: undefined });
    }
  }

  private async processExecutablePath(processId: number): Promise<string | undefined> {
    if (!this.processIsRunning(processId)) {
      return undefined;
    }
    if (this.process?.pid === processId && this.spawnedExecutablePath) {
      return this.spawnedExecutablePath;
    }
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
          '$p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $env:CLAUDEDOCK_GATEWAY_PID); if ($p) { [Console]::Out.Write($p.ExecutablePath) }',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, CLAUDEDOCK_GATEWAY_PID: String(processId) },
          maxBuffer: 64 * 1024,
          timeout: 5_000,
          windowsHide: true,
        },
      );
      return result.stdout.trim() || undefined;
    } catch (error) {
      if (!this.processIsRunning(processId)) {
        return undefined;
      }
      throw error;
    }
  }

  private async processMatchesState(
    state: PersistedGatewayState,
    processId: number,
  ): Promise<boolean> {
    const actualExecutable = await this.processExecutablePath(processId);
    return Boolean(
      actualExecutable &&
      path.resolve(actualExecutable).toLowerCase() ===
        path.resolve(this.executablePath(state)).toLowerCase(),
    );
  }

  private async waitForPortAvailability(port: number): Promise<boolean> {
    if (!port) {
      return true;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (await portIsAvailable(port)) {
        return true;
      }
      await delay(100);
    }
    return portIsAvailable(port);
  }

  private async stopProcessesForState(
    state: PersistedGatewayState,
    occupiedPortMessage: string,
  ): Promise<void> {
    const processIds = new Set<number>();
    if (this.process?.pid) {
      processIds.add(this.process.pid);
    }
    if (state.processId) {
      processIds.add(state.processId);
    }
    let stoppedOwnedProcess = false;
    for (const processId of processIds) {
      stoppedOwnedProcess =
        (await this.stopPersistedProcess(state, processId)) || stoppedOwnedProcess;
    }
    if (this.process?.pid && processIds.has(this.process.pid)) {
      this.process = undefined;
    }
    for (const processId of processIds) {
      this.clearPersistedProcessId(processId);
    }
    // A remembered port is not proof of ownership. If no verified managed process was alive, another
    // application may legitimately own that port and must not block switching to a route that does not use it.
    if (stoppedOwnedProcess && !(await this.waitForPortAvailability(state.port))) {
      throw new Error(occupiedPortMessage);
    }
  }

  private processIsRunning(processId: number): boolean {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return (
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
      );
    }
  }

  private async stopPersistedProcess(
    state: PersistedGatewayState,
    processId: number,
  ): Promise<boolean> {
    if (!this.processIsRunning(processId)) {
      return false;
    }
    const expectedExecutable = path.resolve(this.executablePath(state));
    const actualExecutable = await this.processExecutablePath(processId);
    if (!actualExecutable) {
      if (!this.processIsRunning(processId)) {
        return false;
      }
      throw new Error('托管网关进程身份无法安全确认，已拒绝终止该进程。');
    }
    if (path.resolve(actualExecutable).toLowerCase() !== expectedExecutable.toLowerCase()) {
      throw new Error('托管网关进程身份无法安全确认，已拒绝终止该进程。');
    }
    process.kill(processId, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && this.processIsRunning(processId)) {
      await delay(100);
    }
    if (this.processIsRunning(processId)) {
      throw new Error('ChatGPT 本地网关没有在 10 秒内停止。');
    }
    return true;
  }

  private stopProcess(): void {
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
    }
    this.process = undefined;
    this.spawnedExecutablePath = undefined;
  }
}
