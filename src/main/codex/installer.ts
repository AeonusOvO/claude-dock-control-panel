import path from 'node:path';
import type { BusyRegistry } from '../coordination/busy-registry';
import type { DownloadEngine } from '../download/engine';
import { runProcess } from '../infra/windows-command';

interface GitHubAsset {
  browser_download_url?: unknown;
  digest?: unknown;
  name?: unknown;
  size?: unknown;
}

interface GitHubRelease {
  assets?: unknown;
  tag_name?: unknown;
}

export interface CodexReleaseInstaller {
  digest: string;
  downloadUrl: string;
  size: number;
  version: string;
}

type FetchLike = typeof fetch;

const RELEASE_API = 'https://api.github.com/repos/openai/codex/releases/latest';
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024;

const readLimitedResponse = async (response: Response, maximumBytes: number): Promise<Buffer> => {
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）。`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('下载内容超过安全上限。');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maximumBytes) {
    throw new Error('下载内容超过安全上限。');
  }
  return buffer;
};

export const parseCodexReleaseInstaller = (value: unknown): CodexReleaseInstaller => {
  if (!value || typeof value !== 'object') {
    throw new Error('Codex 发布信息格式无效。');
  }
  const release = value as GitHubRelease;
  if (
    typeof release.tag_name !== 'string' ||
    !/^rust-v\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+)*)?$/.test(release.tag_name)
  ) {
    throw new Error('Codex 发布版本格式无效。');
  }
  if (!Array.isArray(release.assets)) {
    throw new Error('Codex 发布信息缺少安装脚本。');
  }
  const asset = release.assets.find(
    (candidate): candidate is GitHubAsset =>
      Boolean(candidate) &&
      typeof candidate === 'object' &&
      (candidate as GitHubAsset).name === 'install.ps1',
  );
  if (
    !asset ||
    typeof asset.browser_download_url !== 'string' ||
    typeof asset.digest !== 'string' ||
    typeof asset.size !== 'number'
  ) {
    throw new Error('Codex 发布信息缺少可验证的 Windows 安装脚本。');
  }
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.pathname !== `/openai/codex/releases/download/${release.tag_name}/install.ps1`
  ) {
    throw new Error('Codex 安装脚本来源不受信任。');
  }
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1]?.toLowerCase();
  if (!digest || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) {
    throw new Error('Codex 安装脚本校验信息无效。');
  }
  return {
    digest,
    downloadUrl: asset.browser_download_url,
    size: asset.size,
    version: release.tag_name.slice('rust-v'.length),
  };
};

export const compareVersions = (left: string, right: string): number => {
  const parse = (value: string): number[] =>
    value
      .replace(/^rust-v|^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export class CodexInstaller {
  public constructor(
    private readonly userDataPath: string,
    private readonly downloadEngine: DownloadEngine,
    private readonly busyRegistry: BusyRegistry,
    private readonly onInstallLine: (line: string, stream: 'stderr' | 'stdout') => void,
    private readonly fetchImplementation: FetchLike = fetch,
  ) {}

  public async latest(): Promise<CodexReleaseInstaller> {
    const response = await this.fetchImplementation(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ClaudeDock',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    });
    const metadata = await readLimitedResponse(response, MAX_METADATA_BYTES);
    return parseCodexReleaseInstaller(JSON.parse(metadata.toString('utf8')));
  }

  public async installLatest(): Promise<{ message: string; version: string }> {
    const release = await this.latest();
    const directory = path.join(this.userDataPath, 'claude', 'codex-installers', release.version);
    const installerPath = path.join(directory, 'install.ps1');
    await this.downloadEngine.start({
      allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
      allowedPathPrefixes: [
        `/openai/codex/releases/download/rust-v${release.version}/install.ps1`,
        '/',
      ],
      expectedBytes: release.size,
      expectedSha256: release.digest,
      finalPath: installerPath,
      id: `codex-installer-${release.version}`,
      label: 'Codex 官方安装脚本',
      maxBytes: MAX_INSTALLER_BYTES,
      url: release.downloadUrl,
    });

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: 'true',
      CODEX_NON_INTERACTIVE: '1',
      CODEX_RELEASE: release.version,
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const releaseBusy = this.busyRegistry.acquire({
      cancellable: false,
      id: `install:codex-${release.version}`,
      kind: 'install',
      label: `安装 Codex CLI ${release.version}`,
      severity: 'blocking',
    });
    let output: Awaited<ReturnType<typeof runProcess>>;
    try {
      output = await runProcess(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          installerPath,
        ],
        environment,
        {
          maxBuffer: 2 * 1024 * 1024,
          onLine: this.onInstallLine,
          timeout: 15 * 60_000,
        },
      );
    } finally {
      releaseBusy();
    }
    const lastLine = output.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return {
      message: lastLine ?? `Codex CLI ${release.version} 已通过官方安装器完成安装。`,
      version: release.version,
    };
  }
}
