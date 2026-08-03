import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ClaudeConfigurationHint,
  ClaudeGatewayCandidate,
  ClaudeGatewayDiagnostics,
} from '../shared/contracts';
import type { NormalizedClaudeConfig } from './claude-configuration';

const execFileAsync = promisify(execFile);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const DIAGNOSTICS_CACHE_MS = 3_000;
const INSTALLATION_CACHE_MS = 30_000;

interface InstallationFlags {
  ccr: boolean;
  ccrConfig: boolean;
  litellm: boolean;
}

interface CachedDiagnostics {
  checkedAt: number;
  key: string;
  value: ClaudeGatewayDiagnostics;
}

const probePort = (port: number, host = '127.0.0.1'): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });

const probeHttpStatus = async (url: string): Promise<number | undefined> => {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(1_500),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
};

const commandExists = async (command: string): Promise<boolean> => {
  try {
    await execFileAsync('where.exe', [command], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
};

const normalizedVisibleUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    parsed.search = '';
    parsed.hash = '';
    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return undefined;
  }
};

const readSettingsHint = (
  settingsPath: string,
  label: string,
  source: ClaudeConfigurationHint['source'],
): ClaudeConfigurationHint | undefined => {
  if (!existsSync(settingsPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      apiKeyHelper?: unknown;
      env?: Record<string, unknown>;
    };
    const baseUrl = normalizedVisibleUrl(parsed.env?.ANTHROPIC_BASE_URL);
    const authConfigured = Boolean(
      parsed.env?.ANTHROPIC_API_KEY || parsed.env?.ANTHROPIC_AUTH_TOKEN,
    );
    const apiKeyHelperConfigured =
      typeof parsed.apiKeyHelper === 'string' && parsed.apiKeyHelper.trim().length > 0;
    if (!baseUrl && !authConfigured && !apiKeyHelperConfigured) {
      return undefined;
    }
    return { apiKeyHelperConfigured, authConfigured, baseUrl, label, source };
  } catch {
    return undefined;
  }
};

const loopbackLocation = (baseUrl: string): { host: string; port: number } | undefined => {
  try {
    const parsed = new URL(baseUrl);
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return undefined;
    }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65_535
      ? { host: parsed.hostname === '[::1]' ? '::1' : parsed.hostname, port }
      : undefined;
  } catch {
    return undefined;
  }
};

const authRequiredFromStatus = (status: number | undefined): boolean =>
  status === 401 || status === 403;

export class ClaudeGatewayDetector {
  private cachedDiagnostics?: CachedDiagnostics;
  private cachedInstallations?: { checkedAt: number; value: InstallationFlags };

  public async detect(
    cwd: string,
    config: NormalizedClaudeConfig,
  ): Promise<ClaudeGatewayDiagnostics> {
    const cacheKey = `${cwd.toLocaleLowerCase()}\n${config.baseUrl}`;
    if (
      this.cachedDiagnostics &&
      this.cachedDiagnostics.key === cacheKey &&
      Date.now() - this.cachedDiagnostics.checkedAt < DIAGNOSTICS_CACHE_MS
    ) {
      return this.cachedDiagnostics.value;
    }

    const [ccrApiOpen, ccrUiOpen, liteLlmOpen, installations] = await Promise.all([
      probePort(3456),
      probePort(3458),
      probePort(4000),
      this.getInstallationFlags(),
    ]);
    const candidates: ClaudeGatewayCandidate[] = [];

    if (ccrApiOpen || ccrUiOpen || installations.ccr || installations.ccrConfig) {
      const modelStatus = ccrApiOpen
        ? await probeHttpStatus('http://127.0.0.1:3456/v1/models')
        : undefined;
      const detectedBy = [
        ...(ccrApiOpen ? ['3456 模型接口正在监听'] : []),
        ...(ccrUiOpen ? ['3458 管理页面正在监听'] : []),
        ...(installations.ccr ? ['已找到 ccr 命令'] : []),
        ...(installations.ccrConfig ? ['已找到 CCR 本地配置'] : []),
      ];
      candidates.push({
        apiBaseUrl: 'http://127.0.0.1:3456',
        authRequired: authRequiredFromStatus(modelStatus),
        detail: ccrApiOpen
          ? authRequiredFromStatus(modelStatus)
            ? '转换接口已运行，并要求单独的路由器访问密钥。3458 只是管理页。'
            : '转换接口已运行；Claude Code 应连接 3456，3458 只用于管理。'
          : ccrUiOpen
            ? '管理页已运行，但模型接口 3456 尚未就绪；请在管理页启动服务。'
            : '已检测到安装或配置，但服务当前没有运行。',
        detectedBy,
        id: 'claude-code-router',
        kind: 'claude-code-router',
        label: 'Claude Code 路由器',
        managementUrl: ccrUiOpen ? 'http://127.0.0.1:3458/' : undefined,
        status: ccrApiOpen ? 'ready' : ccrUiOpen ? 'partial' : 'offline',
      });
    }

    if (liteLlmOpen || installations.litellm) {
      const modelStatus = liteLlmOpen
        ? await probeHttpStatus('http://127.0.0.1:4000/v1/models')
        : undefined;
      candidates.push({
        apiBaseUrl: 'http://127.0.0.1:4000',
        authRequired: authRequiredFromStatus(modelStatus),
        detail: liteLlmOpen
          ? 'LiteLLM 常用端口 4000 正在监听，可继续进行 Anthropic /v1/messages 实测。'
          : '已找到 litellm 命令，但 4000 端口当前没有运行。',
        detectedBy: [
          ...(liteLlmOpen ? ['4000 端口正在监听'] : []),
          ...(installations.litellm ? ['已找到 litellm 命令'] : []),
        ],
        id: 'litellm',
        kind: 'litellm',
        label: 'LiteLLM 代理',
        status: liteLlmOpen ? 'ready' : 'offline',
      });
    }

    const configuredLoopback = loopbackLocation(config.baseUrl);
    if (
      config.provider === 'gateway' &&
      configuredLoopback &&
      ![3456, 4000].includes(configuredLoopback.port)
    ) {
      const open = await probePort(configuredLoopback.port, configuredLoopback.host);
      candidates.push({
        apiBaseUrl: config.baseUrl,
        authRequired: config.authMode !== 'none',
        detail: open
          ? '当前项目保存的本机地址正在监听；服务类型未知，建议继续执行真实接口测试。'
          : '当前项目保存了这个本机地址，但对应端口现在没有运行。',
        detectedBy: ['当前项目已保存'],
        id: `custom-${configuredLoopback.host}-${configuredLoopback.port}`,
        kind: 'custom',
        label: '当前项目的自定义本机服务',
        status: open ? 'partial' : 'offline',
      });
    }

    const configurationHints = this.getConfigurationHints(cwd);
    const readyCount = candidates.filter((candidate) => candidate.status === 'ready').length;
    const value: ClaudeGatewayDiagnostics = {
      candidates,
      checkedAt: Date.now(),
      configurationHints,
      message:
        readyCount > 0
          ? `发现 ${readyCount} 个正在运行的本地模型接口。`
          : candidates.length > 0
            ? '发现了网关安装或配置，但暂时没有可直接使用的模型接口。'
            : '未发现常见本地转换器；仍可使用官方或远程 Anthropic 兼容地址。',
    };
    this.cachedDiagnostics = { checkedAt: Date.now(), key: cacheKey, value };
    return value;
  }

  private async getInstallationFlags(): Promise<InstallationFlags> {
    if (
      this.cachedInstallations &&
      Date.now() - this.cachedInstallations.checkedAt < INSTALLATION_CACHE_MS
    ) {
      return this.cachedInstallations.value;
    }

    const appData =
      process.env.APPDATA ?? process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
    const currentCcrRoot = path.join(appData, 'claude-code-router');
    const legacyCcrRoot = path.join(homedir(), '.claude-code-router');
    const [ccr, litellm] = await Promise.all([commandExists('ccr'), commandExists('litellm')]);
    const value = {
      ccr,
      ccrConfig: [
        path.join(currentCcrRoot, 'config.sqlite'),
        path.join(currentCcrRoot, 'gateway.config.json'),
        path.join(legacyCcrRoot, 'config.json'),
      ].some((candidate) => existsSync(candidate)),
      litellm,
    };
    this.cachedInstallations = { checkedAt: Date.now(), value };
    return value;
  }

  private getConfigurationHints(cwd: string): ClaudeConfigurationHint[] {
    const hints: ClaudeConfigurationHint[] = [];
    const environmentBaseUrl = normalizedVisibleUrl(process.env.ANTHROPIC_BASE_URL);
    const environmentAuth = Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    );
    if (environmentBaseUrl || environmentAuth) {
      hints.push({
        authConfigured: environmentAuth,
        baseUrl: environmentBaseUrl,
        label: '启动 ClaudeDock 时继承的环境变量',
        source: 'environment',
      });
    }

    const settingsCandidates: Array<[string, string, ClaudeConfigurationHint['source']]> = [
      [path.join(homedir(), '.claude', 'settings.json'), 'Claude Code 用户设置', 'user-settings'],
      [path.join(cwd, '.claude', 'settings.json'), '当前项目共享设置', 'project-settings'],
      [path.join(cwd, '.claude', 'settings.local.json'), '当前项目本地设置', 'project-settings'],
    ];
    for (const [settingsPath, label, source] of settingsCandidates) {
      const hint = readSettingsHint(settingsPath, label, source);
      if (hint) {
        hints.push(hint);
      }
    }
    return hints;
  }
}
