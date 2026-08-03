import type {
  ClaudeCodeInstallSource,
  ClaudeInstallationStatus,
  ClaudeRouterManagementState,
  SoftwareUpdateState,
} from '../shared/contracts';
import { runWindowsCommand } from './windows-command';

const OFFICIAL_REGISTRY = 'https://registry.npmjs.org';
const CHINA_REGISTRY = 'https://registry.npmmirror.com';
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const ROUTER_PACKAGE = '@musistudio/claude-code-router';
const APPLICATION_RELEASE_API =
  'https://api.github.com/repos/AeonusOvO/claude-dock-control-panel/releases/latest';
type SoftwareUpdateFetch = typeof fetch;

const parseVersion = (value: string | undefined): number[] | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value?.trim() ?? '');
  return match ? match.slice(1).map(Number) : undefined;
};

export const isNewerVersion = (
  latestVersion: string | undefined,
  currentVersion: string | undefined,
): boolean => {
  const latest = parseVersion(latestVersion);
  const current = parseVersion(currentVersion);
  if (!latest || !current) {
    return false;
  }
  for (let index = 0; index < latest.length; index += 1) {
    if (latest[index] !== current[index]) {
      return latest[index]! > current[index]!;
    }
  }
  return false;
};

const registryPackageUrl = (registry: string, packageName: string): string =>
  `${registry}/${packageName.replace('/', '%2f')}/latest`;

const fetchLatestVersion = async (
  packageName: string,
  fetchImpl: SoftwareUpdateFetch,
): Promise<string | undefined> => {
  const fetchRegistry = async (registry: string): Promise<string> => {
    const response = await fetchImpl(registryPackageUrl(registry, packageName), {
      headers: { accept: 'application/json', 'user-agent': 'ClaudeDock/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) {
      throw new Error(`${registry} unavailable`);
    }
    const payload = (await response.json()) as { version?: unknown };
    if (typeof payload.version !== 'string' || !parseVersion(payload.version)) {
      throw new Error(`${registry} returned an invalid version`);
    }
    return payload.version;
  };
  try {
    // V2RayN's source tests do not wait for a known-slow route before trying the next one. Start both
    // trusted registries together and accept the first valid version envelope.
    return await Promise.any([fetchRegistry(OFFICIAL_REGISTRY), fetchRegistry(CHINA_REGISTRY)]);
  } catch {
    return undefined;
  }
};

const fetchLatestApplicationVersion = async (
  fetchImpl: SoftwareUpdateFetch,
): Promise<string | undefined> => {
  try {
    const response = await fetchImpl(APPLICATION_RELEASE_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'ClaudeDock/update-check',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) {
      return undefined;
    }
    const payload = (await response.json()) as { tag_name?: unknown };
    return typeof payload.tag_name === 'string' && parseVersion(payload.tag_name)
      ? payload.tag_name.replace(/^v/, '')
      : undefined;
  } catch {
    return undefined;
  }
};

export const checkSoftwareUpdates = async (
  installation: ClaudeInstallationStatus,
  router: ClaudeRouterManagementState,
  applicationVersion?: string,
  fetchImpl: SoftwareUpdateFetch = fetch,
): Promise<SoftwareUpdateState> => {
  const [latestApplication, latestClaude, latestRouter] = await Promise.all([
    fetchLatestApplicationVersion(fetchImpl),
    fetchLatestVersion(CLAUDE_PACKAGE, fetchImpl),
    fetchLatestVersion(ROUTER_PACKAGE, fetchImpl),
  ]);
  const claudeUpdateAvailable = isNewerVersion(latestClaude, installation.version);
  const routerUpdateAvailable = isNewerVersion(latestRouter, router.version);
  const applicationUpdateAvailable = isNewerVersion(latestApplication, applicationVersion);
  return {
    application: {
      currentVersion: applicationVersion,
      installed: true,
      latestVersion: latestApplication,
      message: latestApplication
        ? applicationUpdateAvailable
          ? `发现 ClaudeDock ${latestApplication}。`
          : 'ClaudeDock 已是当前可检测到的最新版本。'
        : '暂时无法从发行通道读取 ClaudeDock 最新版本。',
      updateAvailable: applicationUpdateAvailable,
    },
    checkedAt: Date.now(),
    claudeCode: {
      currentVersion: installation.version,
      installed: installation.installed,
      latestVersion: latestClaude,
      message: !installation.installed
        ? '尚未安装 Claude Code，可选择安装源一键安装。'
        : latestClaude
          ? claudeUpdateAvailable
            ? `发现 Claude Code ${latestClaude}。`
            : 'Claude Code 已是当前可检测到的最新版本。'
          : '暂时无法读取 Claude Code 最新版本。',
      updateAvailable: claudeUpdateAvailable,
    },
    router: {
      currentVersion: router.version,
      installed: router.installed,
      latestVersion: latestRouter,
      message: !router.installed
        ? '尚未安装路由器，可从官方安装包、npm 或国内镜像中选择。'
        : latestRouter
          ? routerUpdateAvailable
            ? `发现路由器 ${latestRouter}。`
            : '路由器已是当前可检测到的最新版本。'
          : '暂时无法读取路由器最新版本。',
      updateAvailable: routerUpdateAvailable,
    },
  };
};

export const installOrUpdateClaudeCode = async (
  source: ClaudeCodeInstallSource,
  installed: boolean,
): Promise<string> => {
  if (source === 'native') {
    if (installed) {
      await runWindowsCommand('claude', ['update'], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60_000,
      });
      return 'Claude Code 原生安装已更新。';
    }
    await runWindowsCommand(
      'winget',
      [
        'install',
        '--id',
        'Anthropic.ClaudeCode',
        '--exact',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ],
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
    );
    return 'Claude Code 原生版已安装。';
  }

  const registry = source === 'npmmirror' ? CHINA_REGISTRY : OFFICIAL_REGISTRY;
  await runWindowsCommand(
    'npm',
    ['install', '--global', `${CLAUDE_PACKAGE}@latest`, '--registry', registry],
    {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    },
  );
  return source === 'npmmirror'
    ? '已通过 npmmirror 安装或更新 Claude Code。'
    : '已通过 npm 官方源安装或更新 Claude Code。';
};
