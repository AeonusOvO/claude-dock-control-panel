import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  NetworkPathView,
  NetworkEnvironmentAssessment,
  NetworkPreflightAction,
  NetworkPreflightScope,
  NetworkProbeResult,
  NetworkProviderId,
} from '../../shared/contracts';
import {
  blockingVersionRuleFor,
  compareSemanticVersions,
  getProviderProfile,
  type ProviderEndpointProfile,
  type ProviderProfile,
} from '../../shared/router/provider-profiles';
import { runProcess, runWindowsCommand } from '../infra/windows-command';
import { NetworkPathResolver, type ResolveProxy } from './path-resolver';
import type { NetworkPreflightTarget } from './preflight-target';

type AppFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApplicationEndpointResponse {
  contentType: string;
  redirects: Array<{ host: string; statusCode: number }>;
  status: number;
}

export interface ApplicationRedirectAuthority {
  readonly allowedDomains: readonly string[];
}

export type ApplicationEndpointRequest = (
  url: string,
  signal?: AbortSignal,
  redirectAuthority?: ApplicationRedirectAuthority,
) => Promise<ApplicationEndpointResponse>;

export interface ConnectivityObservation {
  environment?: NetworkEnvironmentAssessment;
  paths: NetworkPathView[];
  probes: NetworkProbeResult[];
}

type DnsLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

type CliRequest = (
  url: string,
  websocket: boolean,
  cwd?: string,
  signal?: AbortSignal,
) => Promise<string>;

type ClientVersion = (
  provider: NetworkProviderId,
  cwd?: string,
  signal?: AbortSignal,
) => Promise<string | undefined>;

export interface ProviderConnectivityProbeOptions {
  appFetch?: AppFetch;
  applicationRequest?: ApplicationEndpointRequest;
  applicationRequestForScope?: (networkScope: NetworkPreflightScope) => ApplicationEndpointRequest;
  applicationProxyUrl?: () => string | undefined;
  cliEnvironment?: () => Record<string, null | string>;
  cliRequest?: CliRequest;
  clientVersion?: ClientVersion;
  dnsLookup?: DnsLookup;
  now?: () => number;
  overallTimeoutMs?: number;
  resolveProxy: ResolveProxy;
}

const REQUEST_TIMEOUT_MS = 8_000;
/**
 * Ceiling for one whole preflight. Individual HTTP probes already abort at REQUEST_TIMEOUT_MS, but
 * DNS resolution and Electron's `session.resolveProxy` are injected dependencies with no timeout of
 * their own — a broken PAC script or a black-holed resolver leaves them pending forever, and the
 * `Promise.all` in `run` then never settles. Sized above the per-request timeout so a slow-but-live
 * endpoint still reports its own result rather than being cut off here.
 */
const OVERALL_TIMEOUT_MS = 20_000;
const MAX_ACTIVE_UNCANCELLABLE_DNS_LOOKUPS = 6;
const MAX_ACTIVE_UNCANCELLABLE_PROXY_LOOKUPS = 2;
const CANCELLABLE_CLEANUP_BUDGET_MS = 6_000;

const TIMED_OUT = Symbol('preflight-timeout');
const ABORTED = Symbol('preflight-aborted');

interface PreflightDeadline {
  race: <T>(work: Promise<T>, onTimeout: () => T) => Promise<T>;
  stop: () => void;
}

/**
 * Node's OS-backed DNS lookup and Electron's PAC resolver expose no force-abort primitive. Keep
 * their late completions side-effect free and cap the number that can remain alive after callers
 * time out or are superseded. Capacity exhaustion rejects immediately instead of retaining an
 * unbounded queue of obsolete work.
 */
class BoundedUncancellableWork {
  private active = 0;

  public constructor(
    private readonly capacity: number,
    private readonly label: string,
  ) {}

  public run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.capacity) {
      return Promise.reject(
        new Error(`${this.label}仍有 ${this.capacity} 个未完成操作，已跳过新的探测。`),
      );
    }
    this.active += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.active -= 1;
      });
  }
}

class CancellableWorkTracker {
  private readonly pending = new Set<Promise<void>>();

  public track<T>(operation: Promise<T>): Promise<T> {
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settlement);
    void settlement.finally(() => this.pending.delete(settlement));
    return operation;
  }

  public async drain(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...this.pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');

/**
 * One shared deadline several concurrent branches can race against. A single timer is used for all
 * of them so the whole preflight is bounded, and it is always cleared in `stop()` so a fast run does
 * not keep the event loop alive. The authoritative signal also wakes every branch immediately while
 * being forwarded to the underlying I/O so cancellation is not merely simulated by this race.
 */
const deadlineTimer = (timeoutMs: number, signal?: AbortSignal): PreflightDeadline => {
  let outcome: typeof ABORTED | typeof TIMED_OUT | undefined = signal?.aborted
    ? ABORTED
    : undefined;
  const waiters = new Set<(result: typeof ABORTED | typeof TIMED_OUT) => void>();
  const wakeAll = (result: typeof ABORTED | typeof TIMED_OUT): void => {
    if (outcome !== undefined) {
      return;
    }
    outcome = result;
    for (const wake of [...waiters]) {
      wake(result);
    }
    waiters.clear();
  };
  const onAbort = (): void => wakeAll(ABORTED);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => wakeAll(TIMED_OUT), timeoutMs);
  timer.unref?.();
  return {
    race: async <T>(work: Promise<T>, onTimeout: () => T): Promise<T> => {
      if (outcome === ABORTED && signal) {
        throw abortReason(signal);
      }
      if (outcome === TIMED_OUT) {
        return onTimeout();
      }
      let wake: ((result: typeof ABORTED | typeof TIMED_OUT) => void) | undefined;
      const deadline = new Promise<typeof ABORTED | typeof TIMED_OUT>((resolve) => {
        wake = resolve;
        waiters.add(resolve);
      });
      try {
        const result = await Promise.race([work, deadline]);
        if (result === ABORTED && signal) {
          throw abortReason(signal);
        }
        return result === TIMED_OUT ? onTimeout() : (result as T);
      } finally {
        if (wake) {
          waiters.delete(wake);
        }
      }
    },
    stop: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      waiters.clear();
    },
  };
};

const MAX_RESPONSE_BYTES = 64 * 1024;
const REACHABLE_HTTP_STATUS = (status: number): boolean =>
  status >= 200 && status < 500 && status !== 407;

const isPrivateIpv4Address = (address: string): boolean => {
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
};

const mappedIpv4Address = (address: string): string | undefined => {
  const dotted = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(
    address,
  );
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1] ?? '', 16);
  const low = Number.parseInt(hexadecimal[2] ?? '', 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
};

const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4Address(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mapped = mappedIpv4Address(normalized);
    return (
      (mapped !== undefined && isPrivateIpv4Address(mapped)) ||
      normalized === '::' ||
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

const abortAfter = (parentSignal?: AbortSignal): { signal: AbortSignal; stop: () => void } => {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  return {
    signal: controller.signal,
    stop: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
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
  if (/abort|timeout|timed out|超时/i.test(diagnostic)) {
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
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const output = await runWindowsCommand(
    provider === 'anthropic-claude' ? 'claude' : 'codex',
    ['--version'],
    { cwd, maxBuffer: 64 * 1024, signal, timeout: 8_000 },
  );
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
};

const defaultCliRequest = async (
  url: string,
  websocket: boolean,
  cwd?: string,
  signal?: AbortSignal,
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
      signal,
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
  private readonly applicationRequestForScope: (
    networkScope: NetworkPreflightScope,
  ) => ApplicationEndpointRequest;
  private readonly cliRequest: CliRequest;
  private readonly clientVersion: ClientVersion;
  private readonly dnsLookup: DnsLookup;
  private readonly dnsLookupWork = new BoundedUncancellableWork(
    MAX_ACTIVE_UNCANCELLABLE_DNS_LOOKUPS,
    'DNS 解析器',
  );
  private readonly now: () => number;
  private readonly overallTimeoutMs: number;
  private readonly pathResolver: NetworkPathResolver;
  private readonly proxyLookupWork = new BoundedUncancellableWork(
    MAX_ACTIVE_UNCANCELLABLE_PROXY_LOOKUPS,
    '系统代理解析器',
  );

  public constructor(options: ProviderConnectivityProbeOptions) {
    const appFetch = options.appFetch;
    const applicationRequest =
      options.applicationRequest ??
      (appFetch
        ? async (url: string, signal?: AbortSignal) => {
            const timeout = abortAfter(signal);
            try {
              const response = await appFetch(url, {
                cache: 'no-store',
                credentials: 'omit',
                method: 'GET',
                redirect: 'follow',
                signal: timeout.signal,
              });
              const result = {
                contentType: response.headers.get('content-type') ?? '',
                redirects: [],
                status: response.status,
              };
              await response.body?.cancel();
              return result;
            } finally {
              timeout.stop();
            }
          }
        : async () => {
            throw new Error('未配置可归属到 Electron Session 的应用请求适配器。');
          });
    this.applicationRequestForScope =
      options.applicationRequestForScope ?? (() => applicationRequest);
    this.cliRequest =
      options.cliRequest ??
      ((url, websocket, cwd, signal) =>
        defaultCliRequest(url, websocket, cwd, signal, options.cliEnvironment?.()));
    this.clientVersion = options.clientVersion ?? defaultClientVersion;
    this.dnsLookup =
      options.dnsLookup ??
      (async (hostname, signal) => {
        signal?.throwIfAborted();
        const addresses = (await lookup(hostname, { all: true, verbatim: true })) as Array<{
          address: string;
          family: 4 | 6;
        }>;
        signal?.throwIfAborted();
        return addresses;
      });
    this.now = options.now ?? Date.now;
    this.overallTimeoutMs = options.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
    this.pathResolver = new NetworkPathResolver(
      (url, networkScope, signal) =>
        this.proxyLookupWork.run(() => options.resolveProxy(url, networkScope, signal)),
      options.applicationProxyUrl,
    );
  }

  public async run(
    provider: NetworkProviderId,
    action: NetworkPreflightAction,
    cwd?: string,
    networkScope: NetworkPreflightScope = 'application',
    target?: NetworkPreflightTarget,
    signal?: AbortSignal,
  ): Promise<ConnectivityObservation> {
    signal?.throwIfAborted();
    const providerProfile = getProviderProfile(provider);
    const profile: ProviderProfile = target
      ? {
          ...providerProfile,
          endpoints: [
            {
              id: 'configured-chat-api',
              kind: 'api',
              label: '已配置的官方聊天 API',
              process: 'application',
              requiredFor: [action],
              url: target.url,
            },
          ],
        }
      : providerProfile;
    /*
     * One deadline is shared by every individual item. Completed DNS hosts and endpoint transports
     * keep their evidence; only siblings still pending at the deadline degrade to skipped/unknown.
     * PAC and OS DNS work cannot be force-aborted, so bounded launchers above fence their late,
     * side-effect-free completions and prevent repeated superseded runs from accumulating forever.
     */
    const deadline = deadlineTimer(this.overallTimeoutMs, signal);
    const cancellableWork = new CancellableWorkTracker();
    try {
      const pathOperation = deadline.race(
        this.pathResolver.resolve(provider, profile.endpoints[0]?.url ?? '', networkScope, signal),
        () => this.timedOutPaths(provider),
      );
      const [paths, dnsProbes, endpointProbes, versionProbe] = await Promise.all([
        pathOperation.then((resolved) =>
          target ? resolved.filter((pathView) => pathView.process === 'application') : resolved,
        ),
        this.probeDns(profile, action, deadline, signal),
        Promise.all(
          profile.endpoints.map((endpoint) =>
            this.probeEndpoint(
              provider,
              profile,
              endpoint,
              action,
              cwd,
              networkScope,
              deadline,
              cancellableWork,
              signal,
            ),
          ),
        ),
        target
          ? Promise.resolve(undefined)
          : deadline.race(
              cancellableWork.track(this.probeClientVersion(provider, action, cwd, signal)),
              () => this.timedOutVersionProbe(provider, action),
            ),
      ]);
      signal?.throwIfAborted();
      return {
        paths,
        probes: [...dnsProbes, ...(versionProbe ? [versionProbe] : []), ...endpointProbes.flat()],
      };
    } finally {
      deadline.stop();
      if (signal?.aborted) {
        await cancellableWork.drain(CANCELLABLE_CLEANUP_BUDGET_MS);
      }
    }
  }

  private timedOutPaths(provider: NetworkProviderId): NetworkPathView[] {
    return this.pathResolver.unknownPaths(provider, 'Electron 系统代理解析超时，PAC 路径未知。');
  }

  private timedOutDnsProbe(host: string, required: boolean): NetworkProbeResult {
    return {
      checkedAt: this.now(),
      detail: 'DNS 解析超时，未能在预检时限内得到结果。',
      id: `dns:${host}`,
      kind: 'dns',
      label: `${host} DNS`,
      process: 'application',
      required,
      status: 'skipped',
      target: host,
    };
  }

  private timedOutApplicationProbe(
    endpoint: ProviderEndpointProfile,
    required: boolean,
  ): NetworkProbeResult {
    return {
      checkedAt: this.now(),
      detail: '应用端点探测超时，未能在预检时限内得到结果。',
      id: `app:${endpoint.id}`,
      kind: endpoint.kind,
      label: `${endpoint.label}（应用）`,
      process: endpoint.kind === 'oauth' ? 'oauth-browser' : 'application',
      required,
      status: 'skipped',
      target: safeTarget(endpoint.url),
    };
  }

  private timedOutCliProbe(
    provider: NetworkProviderId,
    endpoint: ProviderEndpointProfile,
    required: boolean,
  ): NetworkProbeResult {
    return {
      checkedAt: this.now(),
      detail: 'CLI 端点探测超时，未能在预检时限内得到结果。',
      id: `cli:${endpoint.id}`,
      kind: endpoint.kind,
      label: `${endpoint.label}（CLI）`,
      process: provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli',
      required,
      status: 'skipped',
      target: safeTarget(endpoint.url),
    };
  }

  private timedOutVersionProbe(
    provider: NetworkProviderId,
    action: NetworkPreflightAction,
  ): NetworkProbeResult {
    return {
      checkedAt: this.now(),
      detail: '客户端版本检查超时，未能在预检时限内得到结果。',
      id: `version:${provider}`,
      kind: 'version',
      label: `${getProviderProfile(provider).displayName} 版本审计`,
      process: provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli',
      required:
        provider !== 'openai-api' && (action === 'cli-launch' || action === 'first-request'),
      status: 'skipped',
    };
  }

  private async probeDns(
    profile: ProviderProfile,
    action: NetworkPreflightAction,
    deadline: PreflightDeadline,
    signal?: AbortSignal,
  ): Promise<NetworkProbeResult[]> {
    const hosts = [...new Set(profile.endpoints.map((endpoint) => new URL(endpoint.url).hostname))];
    const requiredHosts = new Set(
      profile.endpoints
        .filter((endpoint) => endpoint.requiredFor.includes(action))
        .map((endpoint) => new URL(endpoint.url).hostname),
    );
    return Promise.all(
      hosts.map((host) =>
        deadline.race(
          (async (): Promise<NetworkProbeResult> => {
            const checkedAt = this.now();
            try {
              const addresses = await this.dnsLookupWork.run(() => this.dnsLookup(host, signal));
              signal?.throwIfAborted();
              const containsPrivateAddress = addresses.some((address) =>
                isPrivateAddress(address.address),
              );
              return {
                checkedAt,
                detail: containsPrivateAddress
                  ? '公共官方域名解析结果包含私有地址，可能存在 DNS 重写或门户劫持。'
                  : `解析到 ${addresses.length} 个地址（地址未写入诊断历史）。`,
                id: `dns:${host}`,
                kind: 'dns',
                label: `${host} DNS`,
                process: 'application',
                required: requiredHosts.has(host),
                status: addresses.length > 0 && !containsPrivateAddress ? 'passed' : 'failed',
                target: host,
              };
            } catch (error) {
              signal?.throwIfAborted();
              return {
                checkedAt,
                detail: classifyNetworkError(error),
                id: `dns:${host}`,
                kind: 'dns',
                label: `${host} DNS`,
                process: 'application',
                required: requiredHosts.has(host),
                status: 'failed',
                target: host,
              };
            }
          })(),
          () => this.timedOutDnsProbe(host, requiredHosts.has(host)),
        ),
      ),
    );
  }

  private async probeEndpoint(
    provider: NetworkProviderId,
    profile: ProviderProfile,
    endpoint: ProviderEndpointProfile,
    action: NetworkPreflightAction,
    cwd: string | undefined,
    networkScope: NetworkPreflightScope,
    deadline: PreflightDeadline,
    cancellableWork: CancellableWorkTracker,
    signal?: AbortSignal,
  ): Promise<NetworkProbeResult[]> {
    const required = endpoint.requiredFor.includes(action);
    const applicationRequired = required && endpoint.process !== 'cli';
    const applicationOperation =
      endpoint.kind === 'websocket'
        ? Promise.resolve(undefined)
        : deadline.race(
            cancellableWork.track(
              this.probeApplicationEndpoint(
                profile,
                endpoint,
                applicationRequired,
                networkScope,
                signal,
              ),
            ),
            () => this.timedOutApplicationProbe(endpoint, applicationRequired),
          );
    const cliOperation =
      endpoint.process === 'cli' || endpoint.kind === 'websocket'
        ? deadline.race(
            cancellableWork.track(this.probeCliEndpoint(provider, endpoint, required, cwd, signal)),
            () => this.timedOutCliProbe(provider, endpoint, required),
          )
        : Promise.resolve(undefined);
    const [applicationProbe, cliProbe] = await Promise.all([applicationOperation, cliOperation]);
    return [applicationProbe, cliProbe].filter(
      (probe): probe is NetworkProbeResult => probe !== undefined,
    );
  }

  private async probeApplicationEndpoint(
    profile: ProviderProfile,
    endpoint: ProviderEndpointProfile,
    required: boolean,
    networkScope: NetworkPreflightScope,
    signal?: AbortSignal,
  ): Promise<NetworkProbeResult> {
    const checkedAt = this.now();
    try {
      const trustedRedirectDomains = new Set([
        new URL(endpoint.url).hostname,
        ...profile.authDomains,
        ...profile.requiredDomains,
        ...(endpoint.allowedRedirectDomains ?? []),
      ]);
      const response = await this.applicationRequestForScope(networkScope)(endpoint.url, signal, {
        allowedDomains: [...trustedRedirectDomains],
      });
      signal?.throwIfAborted();
      const uninspectedRedirect = response.status >= 300 && response.status < 400;
      let status: NetworkProbeResult['status'] =
        response.status === 407 || uninspectedRedirect
          ? 'failed'
          : REACHABLE_HTTP_STATUS(response.status)
            ? 'passed'
            : 'warning';
      let detail =
        response.status === 407
          ? 'HTTP 407，代理认证未通过。'
          : uninspectedRedirect
            ? `应用路径最终返回 HTTP ${response.status} 重定向，但未提供可验证的目标。`
            : `HTTP ${response.status}，官方端点可达。`;
      // A protected official API commonly answers an anonymous reachability probe with a
      // 401/403 HTML authentication page. That still proves DNS, TCP and TLS reachability. Only a
      // successful API response returning HTML is credible captive-portal/content-substitution
      // evidence.
      const unexpectedApiHtml =
        endpoint.kind === 'api' &&
        response.status >= 200 &&
        response.status < 300 &&
        response.contentType.toLowerCase().includes('text/html');
      if (unexpectedApiHtml) {
        status = 'failed';
        detail = 'API 端点返回非预期 HTML，可能存在认证门户或内容劫持。';
      }
      const unexpectedRedirect = response.redirects.find(
        ({ host }) =>
          ![...trustedRedirectDomains].some(
            (domain) => host === domain || host.endsWith(`.${domain}`),
          ),
      );
      if (unexpectedRedirect) {
        status = 'failed';
        detail = `检测到非预期跨域重定向：${unexpectedRedirect.host}。`;
      } else if (response.redirects.length > 0 && !unexpectedApiHtml && !uninspectedRedirect) {
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
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      const redirectCancelled = /redirect was cancelled/i.test(message);
      const exactTarget = endpoint.id === 'configured-chat-api';
      return {
        checkedAt,
        detail:
          redirectCancelled && !exactTarget
            ? '官方端点已返回重定向响应；应用为避免跟随未验证目标而停止，但该网络路径已确认可达。'
            : classifyNetworkError(error),
        id: `app:${endpoint.id}`,
        kind: endpoint.kind,
        label: `${endpoint.label}（应用）`,
        process: endpoint.kind === 'oauth' ? 'oauth-browser' : 'application',
        required,
        status: redirectCancelled && !exactTarget ? 'warning' : 'failed',
        target: safeTarget(endpoint.url),
      };
    }
  }

  private async probeCliEndpoint(
    provider: NetworkProviderId,
    endpoint: ProviderEndpointProfile,
    required: boolean,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<NetworkProbeResult> {
    const checkedAt = this.now();
    try {
      const output = await this.cliRequest(
        endpoint.url,
        endpoint.kind === 'websocket',
        cwd,
        signal,
      );
      signal?.throwIfAborted();
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
      const uninspectedRedirect = parsed.httpStatus >= 300 && parsed.httpStatus < 400;
      const unexpectedApiHtml =
        endpoint.kind === 'api' &&
        parsed.httpStatus >= 200 &&
        parsed.httpStatus < 300 &&
        parsed.contentType.toLowerCase().includes('text/html');
      const reachable =
        websocketEstablished ||
        (endpoint.kind !== 'websocket' && REACHABLE_HTTP_STATUS(parsed.httpStatus));
      const status: NetworkProbeResult['status'] =
        parsed.sslVerifyResult > 0 || redirectUnexpected || uninspectedRedirect || unexpectedApiHtml
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
            : uninspectedRedirect
              ? `CLI 路径返回 HTTP ${parsed.httpStatus} 重定向，但未跟随并验证目标。`
              : unexpectedApiHtml
                ? 'CLI API 路径返回非预期 HTML，可能存在认证门户或内容劫持。'
                : endpoint.kind === 'websocket'
                  ? websocketEstablished
                    ? 'WebSocket 握手成功。'
                    : [401, 403, 426].includes(parsed.httpStatus)
                      ? `端点已响应 HTTP ${parsed.httpStatus}；无登录上下文的探测不能确认会话 WebSocket，不能据此判断网络受限。`
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
      signal?.throwIfAborted();
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
    signal?: AbortSignal,
  ): Promise<NetworkProbeResult> {
    const checkedAt = this.now();
    const profile = getProviderProfile(provider);
    const hasVersionPolicy =
      profile.minimumSecureClientVersion !== undefined || profile.versionRules.length > 0;
    const required = hasVersionPolicy && (action === 'cli-launch' || action === 'first-request');
    if (!hasVersionPolicy) {
      return {
        checkedAt,
        detail: `${profile.displayName} 当前没有需要执行的本机 CLI 版本规则。`,
        id: `version:${provider}`,
        kind: 'version',
        label: `${profile.displayName} 版本审计`,
        process: 'application',
        required: false,
        status: 'skipped',
      };
    }
    try {
      const version = await this.clientVersion(provider, cwd, signal);
      signal?.throwIfAborted();
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
      signal?.throwIfAborted();
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
