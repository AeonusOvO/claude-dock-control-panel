import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CcSwitchInstallationState } from '../shared/contracts';
import type { BusyRegistry } from './busy-registry';
import type { DownloadEngine } from './download-engine';

const execFileAsync = promisify(execFile);
const RELEASE_API = 'https://api.github.com/repos/farion1231/cc-switch/releases/latest';
const MAX_RELEASE_BYTES = 2 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 256 * 1024 * 1024;
const DATA_DIRECTORY_NAMES = ['com.ccswitch.desktop', 'cc-switch'] as const;

interface CcSwitchRelease {
  digest: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  version: string;
}

export interface CcSwitchProviderExportInput {
  authMode: 'apiKey' | 'authToken' | 'existing' | 'none';
  baseUrl: string;
  credential?: string;
  model: string;
  modelFast?: string;
  name: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const parseCcSwitchRelease = (value: unknown): CcSwitchRelease => {
  if (!isRecord(value)) {
    throw new Error('CC Switch 发布元数据格式无效。');
  }
  const tag = optionalString(value.tag_name);
  const assets = Array.isArray(value.assets) ? value.assets : [];
  const asset = assets.find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.name === 'string' &&
      /^CC-Switch-v\d+\.\d+\.\d+-Windows\.msi$/.test(candidate.name),
  );
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || !asset || !isRecord(asset)) {
    throw new Error('CC Switch 最新发布没有可验证的 Windows x64 MSI。');
  }
  const version = tag.slice(1);
  const fileName = optionalString(asset.name) ?? '';
  const downloadUrl = optionalString(asset.browser_download_url) ?? '';
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(optionalString(asset.digest) ?? '')?.[1];
  const size = typeof asset.size === 'number' ? asset.size : 0;
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new Error('CC Switch 安装包下载地址无效。');
  }
  if (
    fileName !== `CC-Switch-v${version}-Windows.msi` ||
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    !parsed.pathname.startsWith(`/farion1231/cc-switch/releases/download/${tag}/`) ||
    !digest ||
    !Number.isInteger(size) ||
    size <= 0 ||
    size > MAX_INSTALLER_BYTES
  ) {
    throw new Error('CC Switch 安装包未通过来源、版本、大小或 SHA-256 元数据检查。');
  }
  return { digest: digest.toLowerCase(), downloadUrl, fileName, size, version };
};

export const buildCcSwitchProviderDeepLink = (input: CcSwitchProviderExportInput): string => {
  const name = input.name.trim();
  if (!name || name.length > 80 || /[\r\n]/.test(name)) {
    throw new Error('导出名称无效。');
  }
  if (input.credential && (input.credential.length > 4096 || /[\r\n]/.test(input.credential))) {
    throw new Error('导出凭据无效。');
  }
  const env: Record<string, string> = {};
  if (input.baseUrl) {
    env.ANTHROPIC_BASE_URL = input.baseUrl;
  }
  if (input.credential) {
    env[input.authMode === 'apiKey' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] =
      input.credential;
  }
  if (input.model !== 'default') {
    env.ANTHROPIC_MODEL = input.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = input.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = input.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.modelFast || input.model;
  }
  const config = Buffer.from(JSON.stringify({ env }), 'utf8').toString('base64');
  const url = new URL('ccswitch://v1/import');
  url.searchParams.set('resource', 'provider');
  url.searchParams.set('app', 'claude');
  url.searchParams.set('name', name);
  url.searchParams.set('configFormat', 'json');
  url.searchParams.set('config', config);
  return url.toString();
};

const safeExec = async (file: string, args: string[], timeout = 5_000): Promise<string> => {
  try {
    const result = await execFileAsync(file, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    return '';
  }
};

const fileSha256 = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};

const registryValue = (output: string, name: string): string | undefined =>
  new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'im').exec(output)?.[1]?.trim();

const executableFromRegistry = (output: string): string | undefined => {
  const command = registryValue(output, '(?:\\(Default\\)|默认)') ?? output;
  const quoted = /"([A-Za-z]:\\[^"]+\.exe)"/i.exec(command)?.[1];
  const bare = /([A-Za-z]:\\[^\r\n]+?\.exe)(?:\s|$)/i.exec(command)?.[1];
  return quoted ?? bare;
};

export class CcSwitchAdapter {
  private readonly installerDirectory: string;

  public constructor(
    userDataPath: string,
    private readonly downloadEngine: DownloadEngine,
    private readonly busyRegistry: BusyRegistry,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.installerDirectory = path.join(userDataPath, 'installers', 'cc-switch');
  }

  public async getState(): Promise<CcSwitchInstallationState> {
    const [userProtocol, machineProtocol, userUninstall, machineUninstall, tasks] =
      await Promise.all([
        safeExec('reg.exe', ['query', 'HKCU\\Software\\Classes\\ccswitch', '/s']),
        safeExec('reg.exe', ['query', 'HKCR\\ccswitch', '/s']),
        safeExec('reg.exe', [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          '/s',
          '/f',
          'CC Switch',
          '/d',
        ]),
        safeExec('reg.exe', [
          'query',
          'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          '/s',
          '/f',
          'CC Switch',
          '/d',
        ]),
        safeExec('tasklist.exe', ['/FO', 'CSV', '/NH']),
      ]);
    const protocolOutput = `${userProtocol}\n${machineProtocol}`;
    const uninstallOutput = `${userUninstall}\n${machineUninstall}`;
    const candidates = [
      executableFromRegistry(protocolOutput),
      registryValue(uninstallOutput, 'DisplayIcon')?.replace(/^"|"$/g, '').split(',')[0],
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Programs', 'CC Switch', 'CC Switch.exe')
        : undefined,
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, 'CC Switch', 'CC Switch.exe')
        : undefined,
    ].filter((candidate): candidate is string => Boolean(candidate));
    const executable = candidates.find((candidate) => existsSync(candidate));
    const protocolRegistered = /ccswitch/i.test(protocolOutput);
    const version = registryValue(uninstallOutput, 'DisplayVersion');
    const uninstallCommand = registryValue(uninstallOutput, 'UninstallString');
    const installed = Boolean(executable || uninstallCommand || protocolRegistered);
    const running = /"(?:cc-switch|CC Switch)\.exe"/i.test(tasks);
    const residuals = this.residualPaths().filter((candidate) => existsSync(candidate));
    return {
      checkedAt: Date.now(),
      executable,
      installed,
      message: installed
        ? `CC Switch ${version ? `v${version}` : ''}${running ? ' 正在运行' : ' 已安装'}。`
        : residuals.length > 0
          ? 'CC Switch 程序未安装，但仍检测到数据目录。'
          : '尚未安装 CC Switch。',
      protocolRegistered,
      residuals,
      running,
      uninstallable: Boolean(uninstallCommand),
      version,
    };
  }

  public async install(): Promise<CcSwitchInstallationState> {
    // DownloadEngine owns a resumable lease while the MSI is transferred. Only the irreversible
    // Windows Installer phase blocks application exit.
    const installer = await this.downloadLatestInstaller();
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: 'router:cc-switch-install',
      kind: 'install',
      label: '正在安装 CC Switch',
      severity: 'blocking',
    });
    try {
      await execFileAsync('msiexec.exe', ['/i', installer, '/passive', '/norestart'], {
        timeout: 10 * 60_000,
        windowsHide: true,
      });
      return this.getState();
    } finally {
      release();
    }
  }

  public async uninstall(purgeData: boolean): Promise<CcSwitchInstallationState> {
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: 'router:cc-switch-uninstall',
      kind: 'uninstall',
      label: '正在彻底卸载 CC Switch',
      severity: 'blocking',
    });
    try {
      const output = `${await safeExec('reg.exe', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        '/s',
        '/f',
        'CC Switch',
        '/d',
      ])}\n${await safeExec('reg.exe', [
        'query',
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        '/s',
        '/f',
        'CC Switch',
        '/d',
      ])}`;
      const command = registryValue(output, 'UninstallString');
      const productCode = command
        ? /\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}/i.exec(command)?.[0]
        : undefined;
      if (productCode) {
        await execFileAsync('msiexec.exe', ['/x', productCode, '/passive', '/norestart'], {
          timeout: 10 * 60_000,
          windowsHide: true,
        });
      } else if ((await this.getState()).installed) {
        throw new Error('检测到 CC Switch，但未找到受支持的 MSI 卸载入口。');
      }
      if (purgeData) {
        for (const dataPath of this.residualPaths()) {
          this.removeGuardedDataDirectory(dataPath);
        }
      }
      return this.getState();
    } finally {
      release();
    }
  }

  public async exportProvider(input: CcSwitchProviderExportInput): Promise<void> {
    const state = await this.getState();
    if (!state.installed || !state.protocolRegistered) {
      throw new Error('CC Switch 尚未安装或 ccswitch:// 协议未注册。');
    }
    await this.openExternal(buildCcSwitchProviderDeepLink(input));
  }

  private async downloadLatestInstaller(): Promise<string> {
    const response = await this.fetchImplementation(RELEASE_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'ClaudeDock/3',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`无法读取 CC Switch 官方发布信息：HTTP ${response.status}。`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RELEASE_BYTES) {
      throw new Error('CC Switch 发布元数据超过允许大小。');
    }
    const release = parseCcSwitchRelease(JSON.parse(bytes.toString('utf8')) as unknown);
    mkdirSync(this.installerDirectory, { recursive: true });
    const finalPath = path.join(this.installerDirectory, release.fileName);
    if (
      existsSync(finalPath) &&
      statSync(finalPath).size === release.size &&
      (await fileSha256(finalPath)) === release.digest
    ) {
      return finalPath;
    }
    await this.downloadEngine.start({
      allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
      allowedPathPrefixes: [`/farion1231/cc-switch/releases/download/v${release.version}/`, '/'],
      expectedBytes: release.size,
      expectedSha256: release.digest,
      finalPath,
      id: `cc-switch-installer-${release.version}`,
      label: 'CC Switch 官方安装包',
      maxBytes: MAX_INSTALLER_BYTES,
      url: release.downloadUrl,
    });
    return finalPath;
  }

  private residualPaths(): string[] {
    const roots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter((value): value is string =>
      Boolean(value),
    );
    return roots.flatMap((root) => DATA_DIRECTORY_NAMES.map((name) => path.join(root, name)));
  }

  private removeGuardedDataDirectory(target: string): void {
    const resolved = path.resolve(target);
    const parent = path.dirname(resolved);
    const allowedRoot = [process.env.APPDATA, process.env.LOCALAPPDATA]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value))
      .includes(parent);
    if (!allowedRoot || !DATA_DIRECTORY_NAMES.includes(path.basename(resolved) as never)) {
      throw new Error('拒绝清理不在 CC Switch 数据路径牢笼内的目录。');
    }
    rmSync(resolved, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
  }
}
