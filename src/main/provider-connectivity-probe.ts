import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  NetworkPathView,
  NetworkPreflightAction,
  NetworkProbeResult,
  NetworkProviderId,
} from '../shared/contracts';
import {
  blockingVersionRuleFor,
  compareSemanticVersions,
  getProviderProfile,
  type ProviderEndpointProfile,
  type ProviderProfile,
} from '../shared/provider-profiles';
import { runProcess, runWindowsCommand } from './windows-command';
import { NetworkPathResolver, type ResolveProxy } from './network-path-resolver';

type AppFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApplicationEndpointResponse {
  contentType: string;
  redirects: Array<{ host: string; statusCode: number }>;
  status: number;
}

export type ApplicationEndpointRequest = (url: string) => Promise<ApplicationEndpointResponse>;

export interface ConnectivityObservation {
  paths: NetworkPathView[];
  probes: NetworkProbeResult[];
}

type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface ProviderConnectivityProbeOptions {
  appFetch: AppFetch;
  applicationRequest?: ApplicationEndpointRequest;
  applicationProxyUrl?: () => string | undefined;
  cliEnvironment?: () => Record<string, null | string>;
  cliRequest?: (url: string, websocket: boolean, cwd?: string) => Promise<string>;
  clientVersion?: (provider: NetworkProviderId, cwd?: string) => Promise<string | undefined>;
  dnsLookup?: DnsLookup;
  now?: () => number;
  resolveProxy: ResolveProxy;
}

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REACHABLE_HTTP_STATUS = (status: number): boolean => status >= 200 && status < 500;

const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }
  return false;
};

const abortAfter = (): { signal: AbortSignal; stop: () => void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  return {
    signal: controller.signal,
    stop: () => clearTimeout(timer),
  };
};

const safeTarget = (rawUrl: string): string => {
  const parsed = new URL(rawUrl.replace(/^wss:/, 'https:'));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
};

const classifyNetworkError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    error && typeof error === 'object' && typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';
  const diagnostic = `${message}\n${stderr}`;
  if (/certificate|cert_|self signed|unable to verify|ssl/i.test(diagnostic)) {
    return 'TLS 证书校验失败。';
  }
  if (/abort|timeout|timed out/i.test(diagnostic)) {
    return '连接超时。';
  }
  if (/ENOTFOUND|name.*not.*resolved|could not resolve|dns/i.test(diagnostic)) {
    return 'DNS 解析失败。';
  }
  return `连接失败：${message.slice(0, 240)}`;
};

const parseCurlOutput = (
  output: string,
):
  | {
      contentType: string;
      effectiveUrl: string;
      httpStatus: number;
      sslVerifyResult: number;
    }
  | undefined => {
  const [statusRaw, effectiveUrl = '', sslRaw = '', contentType = ''] = output.trim().split('|');
  const httpStatus = Number(statusRaw);
  const sslVerifyResult = Number(sslRaw);
  if (!Number.isInteger(httpStatus)) {
    return undefined;
  }
  return {
    contentType,
    effectiveUrl,
    httpStatus,
    sslVerifyResult: Number.isInteger(sslVerifyResult) ? sslVerifyResult : -1,
  };
};

const defaultClientVersion = async (
  provider: NetworkProviderId,
  cwd?: string,
): Promise<string | undefined> => {
  const output = await runWindowsCommand(
    provider === 'anthropic-claude' ? 'claude' : 'codex',
    ['--version'],
    { cwd, maxBuffer: 64 * 1024, timeout: 8_000 },
  );
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
};

const defaultCliRequest = async (
  url: string,
  websocket: boolean,
  cwd?: string,
  overrides: Record<string, null | string> = {},
): Promise<string> => {
  const requestUrl = url.replace(/^wss:/, 'https:');
  const argumentsList = [
    '--silent',
    '--show-error',
    '--output',
    'NUL',
    '--connect-timeout',
    '5',
    '--max-time',
    '8',
    '--request',
    'GET',
  ];
  if (websocket) {
    argumentsList.push(
      '--http1.1',
      '--header',
      'Connection: Upgrade',
      '--header',
      'Upgrade: websocket',
      '--header',
      'Sec-WebSocket-Version: 13',
      '--header',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    );
  }
  argumentsList.push(
    '--write-out',
    '%{http_code}|%{url_effective}|%{ssl_verify_result}|%{content_type}',
    requestUrl,
  );
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const result = await runProcess('curl.exe', argumentsList, environment, {
      cwd,
      maxBuffer: MAX_RESPONSE_BYTES,
      timeout: REQUEST_TIMEOUT_MS + 1_000,
    });
    return result.stdout;
  } catch (error) {
    const stdout =
      error &&
      typeof error === 'object' &&
      typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout
        : '';
    if (websocket && parseCurlOutput(stdout)?.httpStatus === 101) {
      return stdout;
    }
    throw error;
  }
};

export class ProviderConnectivityProbe {
  private readonly appFetch: AppFetch;
  private readonly applicationRequest: ApplicationEndpointRequest;
  private readonly cliRequest: (url: string, websocket: boolean, cwd?: string) => Promise<string>;
  private readonly clientVersion: (
    provider: NetworkProviderId,
    cwd?: string,
  ) => Promise<string | undefined>;
  private readonly dnsLookup: DnsLookup;
  private readonly now: () => number;
  private readonly pathResolver: NetworkPathResolver;

  public constructor(options: ProviderConnectivityProbeOptions) {
    this.appFetch = options.appFetch;
    this.applicationRequest =
      options.applicationRequest ??
      (async (url) => {
        const timeout = abortAfter();
        try {
          const response = await this.appFetch(url, {
            cache: 'no-store',
            credentials: 'omit',
            method: 'HEAD',
            redirect: 'follow',
            signal: timeout.signal,
          });
          return {
            contentType: response.headers.get('content-type') ?? '',
            redirects: [],
            status: response.status,
          };
        } finally {
          timeout.stop();
        }
      });
    this.cliRequest =
      options.cliRequest ??
      ((url, websocket, cwd) => defaultCliRequest(url, websocket, cwd, options.cliEnvironment?.()));
    this.clientVersion = options.clientVersion ?? defaultClientVersion;
    this.dnsLookup =
      options.dnsLookup ??
      ((hostname) =>
        lookup(hostname, { all: true, verbatim: true }) as Promise<
          Array<{ address: string; family: 4 | 6 }>
        >);
    this.now = options.now ?? Date.now;
    this.pathResolver = new NetworkPathResolver(options.resolveProxy, options.applicationProxyUrl);
  }

  public async run(
    provider: NetworkProviderId,
    action: NetworkPreflightAction,
    cwd?: string,
  ): Promise<ConnectivityObservation> {
    const profile = getProviderProfile(provider);
    const pathsPromise = this.pathResolver.resolve(provider, profile.endpoints[0]?.url ?? '');
    const dnsProbesPromise = this.probeDns(profile, action);
    const endpointProbesPromise = Promise.all(
      profile.endpoints.map((endpoint) =>
        this.probeEndpoint(provider, profile, endpoint, action, cwd),
      ),
    );
    const versionProbePromise = this.probeClientVersion(provider, action, cwd);
    const [paths, dnsProbes, endpointProbes, versionProbe] = await Promise.all([
      pathsPromise,
      dnsProbesPromise,
      endpointProbesPromise,
      versionProbePromise,
    ]);
    return {
      paths,
      probes: [...dnsProbes, versionProbe, ...endpointProbes.flat()],
    };
  }

  private async probeDns(
    profile: ProviderProfile,
    action: NetworkPreflightAction,
  ): Promise<NetworkProbeResult[]> {
    const hosts = [...new Set(profile.endpoints.map((endpoint) => new URL(endpoint.url).hostname))];
    const requiredHosts = new Set(
      profile.endpoints
        .filter((endpoint) => endpoint.requiredFor.includes(action))
        .map((endpoint) => new URL(endpoint.url).hostname),
    );
    return Promise.all(
      hosts.map(async (host) => {
        const checkedAt = this.now();
        try {
          const addresses = await this.dnsLookup(host);
          const rewrittenToPrivate =
            addresses.length > 0 && addresses.every((address) => isPrivateAddress(address.address));
          return {
            checkedAt,
            detail: rewrittenToPrivate
              ? '公共官方域名只解析到私有地址，可能存在 DNS 重写或门户劫持。'
              : `解析到 ${addresses.length} 个地址（地址未写入诊断历史）。`,
            id: `dns:${host}`,
            kind: 'dns' as const,
            label: `${host} DNS`,
            process: 'application' as const,
            required: requiredHosts.has(host),
            status:
              addresses.length > 0 && !rewrittenToPrivate
                ? ('passed' as const)
                : ('failed' as const),
            target: host,
          };
        } catch (error) {
          return {
            checkedAt,
            detail: classifyNetworkError(error),
            id: `dns:${host}`,
            kind: 'dns' as const,
            label: `${host} DNS`,
            process: 'application' as const,
            required: requiredHosts.has(host),
            status: 'failed' as const,
            target: host,
          };
        }
      }),
    );
  }

  private async probeEndpoint(
    provider: NetworkProviderId,
    profile: ProviderProfile,
    endpoint: ProviderEndpointProfile,
    action: NetworkPreflightAction,
    cwd?: string,
  ): Promise<NetworkProbeResult[]> {
    const required = endpoint.requiredFor.includes(action);
    const applicationProbe =
      endpoint.kind === 'websocket'
        ? undefined
        : await this.probeApplicationEndpoint(
            profile,
            endpoint,
            required && endpoint.process !== 'cli',
          );
    const cliProbe =
      endpoint.process === 'cli' || endpoint.kind === 'websocket'
        ? await this.probeCliEndpoint(provider, endpoint, required, cwd)
        : undefined;
    return [applicationProbe, cliProbe].filter(
      (probe): probe is NetworkProbeResult => probe !== undefined,
    );
  }

  private async probeApplicationEndpoint(
    profile: ProviderProfile,
    endpoint: ProviderEndpointProfile,
    required: boolean,
  ): Promise<NetworkProbeResult> {
    const checkedAt = this.now();
    try {
      const response = await this.applicationRequest(endpoint.url);
      let status: NetworkProbeResult['status'] = REACHABLE_HTTP_STATUS(response.status)
        ? 'passed'
        : 'warning';
      let detail = `HTTP ${response.status}，官方端点可达。`;
      const unexpectedApiHtml =
        endpoint.kind === 'api' &&
        response.status === 200 &&
        response.contentType.toLowerCase().includes('text/html');
      if (unexpectedApiHtml) {
        status = 'failed';
        detail = 'API 端点返回非预期 HTML，可能存在认证门户或内容劫持。';
      }
      const trustedRedirectDomains = new Set([
        new URL(endpoint.url).hostname,
        ...profile.authDomains,
        ...profile.requiredDomains,
        ...(endpoint.allowedRedirectDomains ?? []),
      ]);
      const unexpectedRedirect = response.redirects.find(
        ({ host }) =>
          ![...trustedRedirectDomains].some(
            (domain) => host === domain || host.endsWith(`.${domain}`),
          ),
      );
      if (unexpectedRedirect) {
        status = 'failed';
        detail = `检测到非预期跨域重定向：${unexpectedRedirect.host}。`;
      } else if (response.redirects.length > 0 && !unexpectedApiHtml) {
        detail = `跟随 ${response.redirects.length} 次受信任重定向后返回 HTTP ${response.status}，官方端点可达。`;
      }
      return {
        checkedAt,
        detail,
        id: `app:${endpoint.id}`,
        kind: endpoint.kind,
        label: `${endpoint.label}（应用）`,
        process: endpoint.kind === 'oauth' ? 'oauth-browser' : 'application',
        required,
        status,
        target: safeTarget(endpoint.url),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redirectCancelled = /redirect was cancelled/i.test(message);
      return {
        checkedAt,
        detail: redirectCancelled
          ? '应用探测器取消了重定向；这不证明网络失败，请结合 CLI 真实端点结果判断。'
          : classifyNetworkError(error),
        id: `app:${endpoint.id}`,
        kind: endpoint.kind,
        label: `${endpoint.label}（应用）`,
        process: endpoint.kind === 'oauth' ? 'oauth-browser' : 'application',
        required,
        status: redirectCancelled ? 'warning' : 'failed',
        target: safeTarget(endpoint.url),
      };
    }
  }

  private async probeCliEndpoint(
    provider: NetworkProviderId,
    endpoint: ProviderEndpointProfile,
    required: boolean,
    cwd?: string,
  ): Promise<NetworkProbeResult> {
    const checkedAt = this.now();
    try {
      const output = await this.cliRequest(endpoint.url, endpoint.kind === 'websocket', cwd);
      const parsed = parseCurlOutput(output);
      if (!parsed) {
        throw new Error('CLI 探测返回了无法识别的结果。');
      }
      const expectedHost = new URL(endpoint.url).hostname;
      const effectiveHost = parsed.effectiveUrl
        ? new URL(parsed.effectiveUrl.replace(/^wss:/, 'https:')).hostname
        : expectedHost;
      const redirectUnexpected =
        effectiveHost !== expectedHost &&
        !effectiveHost.endsWith(`.${expectedHost}`) &&
        !expectedHost.endsWith(`.${effectiveHost}`);
      const websocketEstablished = endpoint.kind === 'websocket' && parsed.httpStatus === 101;
      const unexpectedApiHtml =
        endpoint.kind === 'api' &&
        parsed.httpStatus === 200 &&
        parsed.contentType.toLowerCase().includes('text/html');
      const reachable =
        websocketEstablished ||
        (endpoint.kind !== 'websocket' && REACHABLE_HTTP_STATUS(parsed.httpStatus));
      const status: NetworkProbeResult['status'] =
        parsed.sslVerifyResult > 0 || redirectUnexpected || unexpectedApiHtml
          ? 'failed'
          : reachable
            ? 'passed'
            : endpoint.kind === 'websocket' && [401, 403, 426].includes(parsed.httpStatus)
              ? 'warning'
              : 'failed';
      const detail =
        parsed.sslVerifyResult > 0
          ? `TLS 证书校验失败（curl ${parsed.sslVerifyResult}）。`
          : redirectUnexpected
            ? `CLI 路径被重定向到非预期域名 ${effectiveHost}。`
            : unexpectedApiHtml
              ? 'CLI API 路径返回非预期 HTML，可能存在认证门户或内容劫持。'
              : endpoint.kind === 'websocket'
                ? websocketEstablished
                  ? 'WebSocket 握手成功。'
                  : `WebSocket 握手返回 HTTP ${parsed.httpStatus}。`
                : `CLI 路径返回 HTTP ${parsed.httpStatus}。`;
      return {
        checkedAt,
        detail,
        id: `cli:${endpoint.id}`,
        kind: endpoint.kind,
        label: `${endpoint.label}（CLI）`,
        process: provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli',
        required,
        status,
        target: safeTarget(endpoint.url),
      };
    } catch (error) {
      return {
        checkedAt,
        detail: classifyNetworkError(error),
        id: `cli:${endpoint.id}`,
        kind: endpoint.kind,
        label: `${endpoint.label}（CLI）`,
        process: provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli',
        required,
        status: 'failed',
        target: safeTarget(endpoint.url),
      };
    }
  }

  private async probeClientVersion(
    provider: NetworkProviderId,
    action: NetworkPreflightAction,
    cwd?: string,
  ): Promise<NetworkProbeResult> {
    const checkedAt = this.now();
    const profile = getProviderProfile(provider);
    const required = action === 'cli-launch' || action === 'first-request';
    if (provider === 'openai-api') {
      return {
        checkedAt,
        detail: 'OpenAI API 独立对话不依赖本机 Codex CLI 版本。',
        id: `version:${provider}`,
        kind: 'version',
        label: `${profile.displayName} 版本审计`,
        process: 'application',
        required: false,
        status: 'skipped',
      };
    }
    try {
      const version = await this.clientVersion(provider, cwd);
      if (!version) {
        throw new Error('未能识别 CLI 版本。');
      }
      const matchingRule = blockingVersionRuleFor(profile, version);
      const belowSecureMinimum =
        profile.minimumSecureClientVersion &&
        compareSemanticVersions(version, profile.minimumSecureClientVersion) < 0;
      const blocked = Boolean(matchingRule) || Boolean(belowSecureMinimum);
      return {
        checkedAt,
        detail: blocked
          ? (matchingRule?.reason ??
            `当前版本低于安全基线 ${profile.minimumSecureClientVersion ?? '未知'}。`)
          : `检测到 CLI ${version}，未命中已配置的高风险版本规则。`,
        id: `version:${provider}`,
        kind: 'version',
        label: `${profile.displayName} 版本审计`,
        process: provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli',
        required,
        status: blocked ? 'failed' : 'passed',
      };
    } catch (error) {
      return {
        checkedAt,
        detail: classifyNetworkError(error),
        id: `version:${provider}`,
        kind: 'version',
        label: `${profile.displayName} 版本审计`,
        process: provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli',
        required,
        status: required ? 'failed' : 'warning',
      };
    }
  }
}
