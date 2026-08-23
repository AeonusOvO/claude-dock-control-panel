import type {
  ClaudeInstallationStatus,
  ClaudeRouterManagementState,
  SoftwareUpdateState,
} from '../../shared/contracts';
import { runWindowsCommand } from '../infra/windows-command';

const OFFICIAL_REGISTRY = 'https://registry.npmjs.org';
const CHINA_REGISTRY = 'https://registry.npmmirror.com';
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const ROUTER_PACKAGE = '@musistudio/claude-code-router';
type SoftwareUpdateFetch = typeof fetch;
const CLAUDE_REGISTRY_SAMPLE_BYTES = 128 * 1024;

interface ClaudeRegistryCandidate {
  label: string;
  registry: string;
}

export interface ClaudeRegistryProbe {
  bytesPerSecond?: number;
  label: string;
  latencyMs: number;
  registry: string;
}

export interface SoftwareUpdateProgress {
  line?: string;
  stage: string;
}

export interface SoftwareUpdateOperationOptions {
  fetchImpl?: SoftwareUpdateFetch;
  onProgress?: (progress: SoftwareUpdateProgress) => void;
}

export const sanitizeSoftwareUpdateLine = (rawLine: string): string | undefined => {
  const normalized = [...rawLine]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32;
    })
    .filter((character) => character.codePointAt(0) !== 127)
    .join('')
    .trim();
  if (!normalized) return undefined;
  const redacted = normalized
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+@)/gi, '$1[credentials]@')
    .replace(/([?&](?:token|key|secret|password|auth)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\s]+/g, '[local path]')
    .replace(/\b(?:npm_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]');
  return redacted.slice(0, 500);
};

const CLAUDE_REGISTRIES: readonly ClaudeRegistryCandidate[] = Object.freeze([
  { label: 'npm 官方源', registry: OFFICIAL_REGISTRY },
  { label: 'npmmirror 国内镜像', registry: CHINA_REGISTRY },
]);

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
    // Start both trusted registries together and accept the first valid version envelope so a known-
    // slow route cannot delay the healthy source.
    return await Promise.any([fetchRegistry(OFFICIAL_REGISTRY), fetchRegistry(CHINA_REGISTRY)]);
  } catch {
    // Version discovery is advisory; the caller renders an unavailable state without blocking use.
    return undefined;
  }
};

export const checkSoftwareUpdates = async (
  installation: ClaudeInstallationStatus,
  router: ClaudeRouterManagementState,
  fetchImpl: SoftwareUpdateFetch = fetch,
): Promise<SoftwareUpdateState> => {
  const [latestClaude, latestRouter] = await Promise.all([
    fetchLatestVersion(CLAUDE_PACKAGE, fetchImpl),
    fetchLatestVersion(ROUTER_PACKAGE, fetchImpl),
  ]);
  const claudeUpdateAvailable = isNewerVersion(latestClaude, installation.version);
  const routerUpdateAvailable = isNewerVersion(latestRouter, router.version);
  return {
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
        ? '尚未安装 CCR CLI，可由 ClaudeDock 在后台通过 npm 自动安装。'
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
  installation: ClaudeInstallationStatus,
  options: SoftwareUpdateOperationOptions = {},
): Promise<string> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const report = (stage: string, rawLine?: string): void => {
    const line = rawLine === undefined ? undefined : sanitizeSoftwareUpdateLine(rawLine);
    options.onProgress?.({ line, stage });
  };
  const onLine = (line: string): void => report('执行安装命令', line);
  report('检测安装方式');
  if (!installation.installed) {
    report('通过 WinGet 安装');
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
        onLine,
        timeout: 10 * 60_000,
      },
    );
    report('校验安装结果');
    return '已通过 Anthropic 的 WinGet 包安装 Claude Code 原生版。';
  }

  if (installation.installationKind !== 'npm') {
    report('运行 Claude 官方更新器');
    await runWindowsCommand('claude', ['update'], {
      maxBuffer: 16 * 1024 * 1024,
      onLine,
      timeout: 10 * 60_000,
    });
    report('校验更新结果');
    return installation.installationKind === 'native'
      ? 'Claude Code 原生安装已通过官方更新器更新。'
      : '已沿用当前 Claude Code 安装方式执行官方更新；未创建重复安装。';
  }

  report('测试 npm 下载源');
  const selected = await selectFastestClaudeRegistry(fetchImpl);
  report(`已选择 ${selected.label}`);
  await runWindowsCommand(
    'npm',
    ['install', '--global', `${CLAUDE_PACKAGE}@latest`, '--registry', selected.registry],
    {
      maxBuffer: 16 * 1024 * 1024,
      onLine,
      timeout: 10 * 60_000,
    },
  );
  report('校验更新结果');
  const rate = selected.bytesPerSecond
    ? `，采样速度 ${(selected.bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s`
    : `，响应延迟 ${selected.latencyMs} ms`;
  return `已自动选择 ${selected.label}${rate}，并完成 Claude Code npm 安装更新。`;
};

const probeClaudeRegistry = async (
  candidate: ClaudeRegistryCandidate,
  fetchImpl: SoftwareUpdateFetch,
): Promise<ClaudeRegistryProbe> => {
  const startedAt = performance.now();
  const metadataResponse = await fetchImpl(registryPackageUrl(candidate.registry, CLAUDE_PACKAGE), {
    headers: { accept: 'application/json', 'user-agent': 'ClaudeDock/registry-speed-test' },
    redirect: 'error',
    signal: AbortSignal.timeout(6_000),
  });
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (
    !metadataResponse.ok ||
    Number(metadataResponse.headers.get('content-length') ?? 0) > 1024 * 1024
  ) {
    throw new Error(`${candidate.label} 元数据不可用。`);
  }
  const metadata = (await metadataResponse.json()) as {
    dist?: { tarball?: unknown };
    version?: unknown;
  };
  if (typeof metadata.version !== 'string' || !parseVersion(metadata.version)) {
    throw new Error(`${candidate.label} 返回了无效版本。`);
  }
  if (typeof metadata.dist?.tarball !== 'string') {
    return { label: candidate.label, latencyMs, registry: candidate.registry };
  }
  const tarball = new URL(metadata.dist.tarball);
  const registryHost = new URL(candidate.registry).hostname;
  if (tarball.protocol !== 'https:' || tarball.hostname !== registryHost) {
    return { label: candidate.label, latencyMs, registry: candidate.registry };
  }

  const sampleStartedAt = performance.now();
  const sampleResponse = await fetchImpl(tarball.toString(), {
    headers: {
      accept: 'application/octet-stream',
      range: `bytes=0-${CLAUDE_REGISTRY_SAMPLE_BYTES - 1}`,
      'user-agent': 'ClaudeDock/registry-speed-test',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(6_000),
  });
  if (!sampleResponse.ok || !sampleResponse.body) {
    await sampleResponse.body?.cancel().catch(() => undefined);
    return { label: candidate.label, latencyMs, registry: candidate.registry };
  }
  const reader = sampleResponse.body.getReader();
  let bytes = 0;
  try {
    while (bytes < CLAUDE_REGISTRY_SAMPLE_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += Math.min(chunk.value.byteLength, CLAUDE_REGISTRY_SAMPLE_BYTES - bytes);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const seconds = Math.max((performance.now() - sampleStartedAt) / 1000, 0.001);
  return {
    bytesPerSecond: bytes > 0 ? Math.round(bytes / seconds) : undefined,
    label: candidate.label,
    latencyMs,
    registry: candidate.registry,
  };
};

export const selectFastestClaudeRegistry = async (
  fetchImpl: SoftwareUpdateFetch = fetch,
): Promise<ClaudeRegistryProbe> => {
  const probes = await Promise.all(
    CLAUDE_REGISTRIES.map((candidate) =>
      probeClaudeRegistry(candidate, fetchImpl).catch(() => undefined),
    ),
  );
  const available = probes.filter((probe): probe is ClaudeRegistryProbe => Boolean(probe));
  if (available.length === 0) {
    throw new Error('npm 官方源与 npmmirror 均无法通过安全测速，请检查网络后重试。');
  }
  return available.sort((left, right) => {
    const speedDifference = (right.bytesPerSecond ?? 0) - (left.bytesPerSecond ?? 0);
    return speedDifference || left.latencyMs - right.latencyMs;
  })[0]!;
};
