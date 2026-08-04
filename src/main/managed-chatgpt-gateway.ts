import { spawn, type ChildProcess } from 'node:child_process';
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
import type { ManagedChatGptGatewayState } from '../shared/contracts';
import type { BusyRegistry } from './busy-registry';
import type { DownloadEngine } from './download-engine';
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

interface SafeStorageLike {
  decryptString: (encrypted: Buffer) => string;
  encryptString: (plainText: string) => Buffer;
  isEncryptionAvailable: () => boolean;
}

interface PersistedGatewayState {
  encryptedClientKey: string;
  executableRelativePath: string;
  executableSha256: string;
  installedVersion: string;
  port: number;
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
  baseUrl: string;
  credential: string;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const sha256File = (filePath: string): string =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

const cleanEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
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
  port: number;
}): string => {
  if (
    !path.isAbsolute(input.authDirectory) ||
    !/^sk-claudedock-[A-Za-z0-9_-]{32,}$/.test(input.clientKey) ||
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
    '  secret-key: ""',
    '  disable-control-panel: true',
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
    const running = Boolean(
      !busy && persisted && clientKey && (await this.probe(persisted.port, clientKey)),
    );
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
      authenticated,
      busy,
      checkedAt: Date.now(),
      endpoint,
      installed,
      message,
      phase,
      running,
      version: installed ? persisted?.installedVersion : undefined,
    };
  }

  public async setup(forceLogin = false): Promise<ManagedChatGptGatewayProjectConfig> {
    if (this.setupInFlight) {
      return this.setupInFlight;
    }
    const operation = this.setupInternal(forceLogin);
    this.setupInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.setupInFlight === operation) {
        this.setupInFlight = undefined;
      }
    }
  }

  private async setupInternal(forceLogin: boolean): Promise<ManagedChatGptGatewayProjectConfig> {
    const releaseBusy = this.busyRegistry.acquire({
      cancellable: false,
      id: 'managed-gateway:chatgpt-setup',
      kind: 'configure',
      label: '正在安装并配置 ChatGPT 托管网关',
      severity: 'blocking',
    });
    try {
      let persisted = await this.installLatest();
      persisted = await this.ensureConfiguration(persisted);
      if (forceLogin || !this.hasAuthentication()) {
        await this.login(persisted);
      }
      await this.start(persisted);
      const credential = this.decryptClientKey(persisted);
      if (!credential) {
        throw new Error('托管网关本地访问密钥无法解密，请重新执行一键配置。');
      }
      return {
        baseUrl: `http://127.0.0.1:${persisted.port}`,
        credential,
      };
    } finally {
      releaseBusy();
    }
  }

  public async ensureRunning(): Promise<void> {
    const persisted = this.loadState();
    if (!persisted || !this.executableIsValid(persisted) || !this.hasAuthentication()) {
      throw new Error('ChatGPT 托管网关尚未完成一键安装与 OpenAI 授权。');
    }
    await this.start(persisted);
  }

  public shutdown(): void {
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

  private async installLatest(): Promise<PersistedGatewayState | undefined> {
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
      return current;
    }
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
    const next: PersistedGatewayState = {
      encryptedClientKey: current?.encryptedClientKey ?? '',
      executableRelativePath: relativeExecutable,
      executableSha256,
      installedVersion: release.version,
      port: current?.port ?? 0,
      releaseDigest: release.digest,
      version: 1,
    };
    this.persistState(next);
    return next;
  }

  private async extractRelease(archivePath: string, version: string): Promise<string> {
    const environment = cleanEnvironment();
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
    const clientKey = existingKey ?? `sk-claudedock-${randomBytes(32).toString('base64url')}`;
    const port = current.port || (await findAvailablePort(DEFAULT_PORT, LAST_PORT, '启动托管网关'));
    const next: PersistedGatewayState = {
      ...current,
      encryptedClientKey: this.safeStorage.encryptString(clientKey).toString('base64'),
      port,
    };
    mkdirSync(this.authDirectory, { recursive: true });
    writeFileSync(
      this.configPath,
      buildManagedGatewayConfig({ authDirectory: this.authDirectory, clientKey, port }),
      { encoding: 'utf8', mode: 0o600 },
    );
    this.persistState(next);
    return next;
  }

  private async login(state: PersistedGatewayState): Promise<void> {
    this.stopProcess();
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
        cleanEnvironment(),
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
      return;
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
      env: cleanEnvironment(),
      stdio: 'ignore',
      windowsHide: true,
    });
    const child = this.process;
    child.once('exit', () => {
      if (this.process === child) {
        this.process = undefined;
      }
    });
    child.once('error', () => {
      if (this.process === child) {
        this.process = undefined;
      }
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
    try {
      const response = await this.fetchImplementation(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${credential}` },
        redirect: 'error',
        signal: AbortSignal.timeout(1_500),
      });
      return response.ok;
    } catch {
      return false;
    }
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
        typeof parsed.executableRelativePath !== 'string' ||
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

  private stopProcess(): void {
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
    }
    this.process = undefined;
  }
}
