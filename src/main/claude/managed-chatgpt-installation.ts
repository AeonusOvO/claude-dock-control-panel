import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { DownloadEngine } from '../download/engine';
import type { runProcess } from '../infra/windows-command';
import { buildManagedGatewayEnvironment } from './managed-chatgpt-config';
import type { ManagedChatGptSetupReporter } from './managed-chatgpt-gateway-types';
import {
  archiveEntriesAreSafe,
  type CliProxyApiRelease,
  limitedResponseBody,
  MAX_ARCHIVE_BYTES,
  MAX_RELEASE_BYTES,
  parseCliProxyApiRelease,
  RELEASE_API,
} from './managed-chatgpt-release';
import { sha256File, type PersistedGatewayState } from './managed-chatgpt-state';

type RunProcess = typeof runProcess;

export interface ManagedGatewayInstallationOptions {
  readonly current: PersistedGatewayState | undefined;
  readonly downloadEngine: Pick<DownloadEngine, 'start'>;
  readonly downloadsDirectory: string;
  readonly executableIsValid: (state: PersistedGatewayState) => boolean;
  readonly extractRelease: (archivePath: string, version: string) => Promise<string>;
  readonly latest: () => Promise<CliProxyApiRelease>;
  readonly persistState: (state: PersistedGatewayState) => void;
  readonly report?: ManagedChatGptSetupReporter;
  readonly rootDirectory: string;
  readonly stopCurrent: (state: PersistedGatewayState) => Promise<void>;
  readonly versionsDirectory: string;
}

export const fetchLatestManagedGatewayRelease = async (
  fetchImplementation: typeof fetch,
): Promise<CliProxyApiRelease> => {
  const response = await fetchImplementation(RELEASE_API, {
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
};

export const removeManagedGatewayVersionDirectory = (
  target: string,
  versionsDirectory: string,
): void => {
  const resolved = path.resolve(target);
  const versionsRoot = path.resolve(versionsDirectory);
  if (
    path.dirname(resolved).toLowerCase() !== versionsRoot.toLowerCase() ||
    !path.basename(resolved) ||
    path.basename(resolved) === '.'
  ) {
    throw new Error('拒绝清理不在托管网关版本目录内的路径。');
  }
  rmSync(resolved, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
};

export const extractManagedGatewayRelease = async (
  archivePath: string,
  version: string,
  rootDirectory: string,
  versionsDirectory: string,
  runProcessImplementation: RunProcess,
): Promise<string> => {
  const environment = buildManagedGatewayEnvironment();
  const list = await runProcessImplementation('tar.exe', ['-tf', archivePath], environment, {
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
  const staging = path.join(versionsDirectory, `.staging-${version}-${Date.now()}`);
  const finalDirectory = path.join(versionsDirectory, version);
  mkdirSync(staging, { recursive: true });
  try {
    await runProcessImplementation('tar.exe', ['-xf', archivePath, '-C', staging], environment, {
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
    removeManagedGatewayVersionDirectory(finalDirectory, versionsDirectory);
    renameSync(staging, finalDirectory);
    return path.relative(rootDirectory, path.join(finalDirectory, ...executableSegments));
  } catch (error) {
    removeManagedGatewayVersionDirectory(staging, versionsDirectory);
    throw error;
  }
};

export const installLatestManagedGateway = async ({
  current,
  downloadEngine,
  downloadsDirectory,
  executableIsValid,
  extractRelease,
  latest,
  persistState,
  report,
  rootDirectory,
  stopCurrent,
  versionsDirectory,
}: ManagedGatewayInstallationOptions): Promise<PersistedGatewayState | undefined> => {
  let release: CliProxyApiRelease;
  try {
    release = await latest();
  } catch (error) {
    if (current && executableIsValid(current)) return current;
    throw error;
  }
  if (current?.installedVersion === release.version && executableIsValid(current)) {
    report?.(3, `CLIProxyAPI ${release.version} 已安装，正在复用现有文件。`);
    return current;
  }
  report?.(3, `正在下载并校验 CLIProxyAPI ${release.version}。`);
  mkdirSync(downloadsDirectory, { recursive: true });
  mkdirSync(versionsDirectory, { recursive: true });
  const archivePath = path.join(downloadsDirectory, release.fileName);
  await downloadEngine.start({
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
  const relativeExecutable = await extractRelease(archivePath, release.version);
  const executableSha256 = sha256File(path.resolve(rootDirectory, relativeExecutable));
  if (current) {
    report?.(4, `正在停止 CLIProxyAPI ${current.installedVersion}，准备切换版本。`);
    await stopCurrent(current);
  }
  const next: PersistedGatewayState = {
    authorization: current?.authorization,
    encryptedClientKey: current?.encryptedClientKey ?? '',
    encryptedManagementKey: current?.encryptedManagementKey,
    executableRelativePath: relativeExecutable,
    executableSha256,
    installedVersion: release.version,
    port: current?.port ?? 0,
    releaseDigest: release.digest,
    version: 1,
  };
  persistState(next);
  report?.(4, `CLIProxyAPI ${release.version} 已校验并安装完成。`);
  return next;
};
