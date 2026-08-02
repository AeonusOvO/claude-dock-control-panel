import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import type {
  ProxyCoreSourceView,
  ProxyCoreView,
  ProxyCredentialInput,
  ProxyProfileView,
  ProxyRuntimeView,
} from '../../shared/contracts';
import type { BusyRegistry } from '../busy-registry';
import type { DownloadEngine } from '../download-engine';
import {
  buildXrayCoreSources,
  describeProbeFailure,
  pickFastestSource,
  probeXrayCoreSources,
  type XrayCoreFetch,
  type XrayCoreProbeResult,
  type XrayCoreSource,
} from './xray-core-sources';

export const XRAY_CORE_RELEASE = Object.freeze({
  bytes: 20_913_304,
  fileName: 'Xray-windows-64.zip',
  sha256: 'd004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad',
  version: 'v26.3.27',
});

/*
 * The safety ceiling deliberately is not `XRAY_CORE_RELEASE.bytes`. `maxBytes` exists to stop an
 * unbounded or hostile response from filling the disk, and it is enforced mid-transfer against
 * `getTotalBytes()`; pinning it to the exact asset size means a release republished even one byte
 * larger fails instantly and unrecoverably, which reads to the user as "the core never downloads".
 * Exactness is already guaranteed at the end by `expectedBytes` plus `expectedSha256`, so the
 * in-flight ceiling only needs to be tight enough to bound the damage.
 */
const MAX_CORE_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * How long a route probe stays authoritative. Long enough that clicking 「测试下载线路」 and then
 * 「启动」 does not pay for the same four seconds twice, short enough that a route which died in the
 * meantime is not trusted on faith.
 */
const PROBE_CACHE_MS = 30_000;

interface XrayProfile extends ProxyProfileView {
  credentials?: ProxyCredentialInput;
}

type XrayListener = (view: ProxyRuntimeView) => void;

export interface XraySidecarOptions {
  busyRegistry: BusyRegistry;
  downloadEngine: DownloadEngine;
  /**
   * Runs on the app session so a probe travels exactly the path a download will, including whatever
   * bootstrap proxy the user configured. Injected rather than imported so this module stays free of
   * Electron and testable in plain Node.
   */
  fetchImpl: XrayCoreFetch;
  /** User-added mirror hostnames, read fresh on every probe so edits take effect immediately. */
  mirrorHosts?: () => readonly string[];
  onChange?: XrayListener;
  userDataPath: string;
}

const LOG_LIMIT = 200;

const reserveLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error || port === 0) {
          reject(error ?? new Error('无法分配本地代理端口。'));
        } else {
          resolve(port);
        }
      });
    });
  });

/** Share links pack comma-separated lists (`alpn`, `host`) into a single query value. */
const commaList = (value?: string): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Mirrors v2rayN's `V2rayOutboundService.FillBoundStreamSettings`. `security` picks exactly one of
 * `realitySettings` / `tlsSettings` — Xray ignores the other, and emitting `tls` for a REALITY node
 * makes the handshake fail with a certificate error instead of negotiating.
 */
const streamSettings = (profile: XrayProfile): Record<string, unknown> => {
  const security = profile.security ?? (profile.tls ? 'tls' : 'none');
  const hosts = commaList(profile.host);
  const serverName = profile.serverName || hosts[0] || profile.address;
  const settings: Record<string, unknown> = { network: profile.transport, security };
  if (security === 'reality') {
    settings.realitySettings = {
      // Xray rejects an empty fingerprint; v2rayN falls back to chrome for the same reason.
      fingerprint: profile.fingerprint || 'chrome',
      publicKey: profile.publicKey ?? '',
      serverName,
      shortId: profile.shortId ?? '',
      show: false,
      spiderX: profile.spiderX ?? '',
    };
  } else if (security === 'tls') {
    const alpn = commaList(profile.alpn);
    settings.tlsSettings = {
      allowInsecure: profile.allowInsecure === true,
      alpn: alpn.length > 0 ? alpn : undefined,
      fingerprint: profile.fingerprint || undefined,
      serverName,
    };
  }
  if (profile.transport === 'ws') {
    settings.wsSettings = {
      headers: hosts[0] ? { Host: hosts[0] } : undefined,
      path: profile.transportPath || '/',
    };
  } else if (profile.transport === 'grpc') {
    settings.grpcSettings = {
      multiMode: profile.headerType === 'multi',
      serviceName: profile.transportPath || '',
    };
  } else if (profile.transport === 'http') {
    settings.httpSettings = {
      host: hosts.length > 0 ? hosts : undefined,
      path: profile.transportPath || '/',
    };
  } else if (profile.headerType === 'http') {
    settings.tcpSettings = {
      header: {
        request: {
          headers: { Host: hosts.length > 0 ? hosts : [serverName] },
          path: [profile.transportPath || '/'],
        },
        type: 'http',
      },
    };
  }
  return settings;
};

const outboundSettings = (profile: XrayProfile): Record<string, unknown> => {
  const credentials = profile.credentials ?? {};
  switch (profile.protocol) {
    case 'vmess':
      return {
        vnext: [
          {
            address: profile.address,
            port: profile.port,
            users: [
              {
                alterId: credentials.alterId ?? 0,
                id: credentials.uuid,
                security: credentials.method || 'auto',
              },
            ],
          },
        ],
      };
    case 'vless':
      return {
        vnext: [
          {
            address: profile.address,
            port: profile.port,
            users: [
              {
                // Xray requires the literal `none` when the node negotiates no VLESS encryption.
                encryption: profile.encryption || 'none',
                // XTLS flow only exists on top of a TLS or REALITY handshake.
                flow: profile.security !== 'none' ? profile.flow || undefined : undefined,
                id: credentials.uuid,
              },
            ],
          },
        ],
      };
    case 'trojan':
      return {
        servers: [{ address: profile.address, password: credentials.password, port: profile.port }],
      };
    case 'shadowsocks':
      return {
        servers: [
          {
            address: profile.address,
            method: credentials.method,
            password: credentials.password,
            port: profile.port,
          },
        ],
      };
    case 'socks':
    case 'http':
      return {
        servers: [
          {
            address: profile.address,
            port: profile.port,
            users:
              credentials.username || credentials.password
                ? [{ pass: credentials.password ?? '', user: credentials.username ?? '' }]
                : undefined,
          },
        ],
      };
  }
};

export const buildXrayConfig = (
  profile: XrayProfile,
  httpPort: number,
  socksPort: number,
): Record<string, unknown> => ({
  inbounds: [
    {
      listen: '127.0.0.1',
      port: httpPort,
      protocol: 'http',
      settings: { allowTransparent: false },
      tag: 'claudedock-http',
    },
    {
      listen: '127.0.0.1',
      port: socksPort,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true },
      tag: 'claudedock-socks',
    },
  ],
  log: { loglevel: 'warning' },
  outbounds: [
    {
      protocol: profile.protocol,
      settings: outboundSettings(profile),
      streamSettings: streamSettings(profile),
      tag: 'selected-proxy',
    },
    { protocol: 'freedom', settings: { domainStrategy: 'AsIs' }, tag: 'direct' },
  ],
  routing: {
    domainStrategy: 'AsIs',
    rules: [{ ip: ['geoip:private'], outboundTag: 'direct', type: 'field' }],
  },
});

export const redactProxyLog = (line: string, secrets: string[]): string =>
  secrets
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) =>
        redacted
          .replaceAll(secret, '[REDACTED]')
          .replaceAll(encodeURIComponent(secret), '[REDACTED]'),
      line,
    )
    .slice(0, 4096);

const waitForProcess = (child: ChildProcessWithoutNullStreams, label: string): Promise<void> =>
  new Promise((resolve, reject) => {
    /*
     * The child's own complaint is the whole diagnosis. Dropping it is how a broken `Expand-Archive`
     * invocation survived as an opaque 「退出码 1」 instead of the parameter-validation error it was.
     */
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(0, 2_000);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const reason = stderr.trim().split(/\r?\n/)[0];
        reject(
          new Error(
            `${label} 失败（退出码 ${code ?? '未知'}）。${reason ? `\n${reason}` : ''}`.trim(),
          ),
        );
      }
    });
  });

/**
 * Doubles as the "is this actually a working kernel" check after an install: a wrong-architecture,
 * truncated or renamed executable fails here rather than at 启动, when the failure would be reported
 * as a proxy error instead of a bad file.
 */
const readCoreVersion = (executablePath: string, timeoutMs = 5_000): Promise<string | undefined> =>
  new Promise((resolve) => {
    let output = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executablePath, ['version'], { windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    const capture = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0);
      resolve(code === 0 && firstLine ? firstLine.trim().slice(0, 120) : undefined);
    });
  });

const hashFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });

const attemptHttpInbound = (port: number, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy(new Error('代理健康检查超时。'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(
        'CONNECT www.cloudflare.com:443 HTTP/1.1\r\nHost: www.cloudflare.com:443\r\nConnection: close\r\n\r\n',
      );
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (/^HTTP\/1\.[01] 2\d\d/m.test(response)) {
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      } else if (/^HTTP\/1\.[01] [45]\d\d/m.test(response)) {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error('本地代理已启动，但选中节点未通过联网探测。'));
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

const isInboundNotUpYet = (error: Error): boolean =>
  ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );

/**
 * Xray binds its inbound some way *after* `spawn` returns, so the first connect attempt almost always
 * lands before anything is listening. Treating that `ECONNREFUSED` as a verdict is what made a
 * correctly downloaded kernel still report 启动失败 within 50 ms — far too fast for the process to
 * have even parsed its config. The probe therefore keeps knocking until the deadline, and only stops
 * early for answers that retrying cannot change: a real HTTP status, or a child that has exited.
 */
export const probeHttpInbound = async (
  port: number,
  isRunning: () => boolean,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    if (!isRunning()) {
      throw new Error('Xray 在完成健康检查前就退出了，请查看下方日志。');
    }
    try {
      await attemptHttpInbound(port, Math.max(deadline - Date.now(), 250));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isInboundNotUpYet(lastError)) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw lastError ?? new Error('代理健康检查超时。');
};

export class XraySidecar {
  private readonly busyRegistry: BusyRegistry;
  private child?: ChildProcessWithoutNullStreams;
  private readonly coreDirectory: string;
  private readonly downloadEngine: DownloadEngine;
  private readonly fetchImpl: XrayCoreFetch;
  /** Memoised so the per-log-line state broadcasts never spawn `xray.exe version`. */
  private installedVersion?: string;
  private readonly listeners = new Set<XrayListener>();
  private readonly logs: string[] = [];
  private readonly mirrorHosts: () => readonly string[];
  private readonly pidPath: string;
  private probeResults: XrayCoreProbeResult[] = [];
  private probedAt?: number;
  private probing = false;
  private readonly runtimeDirectory: string;
  /**
   * Bumped by every `stop()`. A start that is still fetching or extracting the core compares it
   * across each await, so pressing 停止 mid-download actually abandons the attempt instead of
   * letting it finish and silently re-enter `ready`.
   */
  private startGeneration = 0;
  private readonly userDataPath: string;
  private view: ProxyRuntimeView = {
    coreVersion: XRAY_CORE_RELEASE.version,
    logs: [],
    status: 'stopped',
  };

  public constructor(options: XraySidecarOptions) {
    this.busyRegistry = options.busyRegistry;
    this.downloadEngine = options.downloadEngine;
    this.fetchImpl = options.fetchImpl;
    this.mirrorHosts = options.mirrorHosts ?? (() => []);
    this.userDataPath = options.userDataPath;
    this.coreDirectory = path.join(
      options.userDataPath,
      'proxy',
      'core',
      XRAY_CORE_RELEASE.version,
    );
    this.runtimeDirectory = path.join(options.userDataPath, 'proxy', 'runtime');
    this.pidPath = path.join(this.runtimeDirectory, 'xray.pid');
    if (options.onChange) {
      this.listeners.add(options.onChange);
    }
    this.cleanupOrphan();
  }

  public getView(): ProxyRuntimeView {
    return { ...this.view, logs: [...this.logs] };
  }

  /**
   * Everything the panel needs to explain "why can't I start the proxy" before the user presses
   * 启动 — whether a kernel is present at all, and which download routes are usable right now.
   */
  public getCoreView(): ProxyCoreView {
    const executablePath = path.join(this.coreDirectory, 'xray.exe');
    const installed = existsSync(executablePath);
    const resultsById = new Map(this.probeResults.map((result) => [result.id, result]));
    const sources: ProxyCoreSourceView[] = this.buildSources().map((source) => {
      const result = resultsById.get(source.id);
      return {
        detail: result?.detail,
        id: source.id,
        kind: source.kind,
        label: source.label,
        latencyMs: result?.latencyMs,
        status: result?.status ?? 'unknown',
        throughputBps: result?.throughputBps,
        url: source.url,
      };
    });
    return {
      executablePath: installed ? executablePath : undefined,
      installed,
      installedVersion: installed ? this.installedVersion : undefined,
      lastProbedAt: this.probedAt,
      probing: this.probing,
      requiredVersion: XRAY_CORE_RELEASE.version,
      sources,
    };
  }

  public onChange(listener: XrayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Backs 「测试下载线路」; also refreshes the memoised installed version. */
  public async probeSources(): Promise<ProxyCoreView> {
    await this.refreshInstalledVersion();
    if (this.probing) {
      return this.getCoreView();
    }
    this.probing = true;
    this.notify();
    try {
      await this.runProbe();
    } finally {
      this.probing = false;
      this.notify();
    }
    return this.getCoreView();
  }

  /**
   * The escape hatch for users whose network cannot reach any route: download the archive on another
   * machine, drop it into the panel. Accepts the official zip or a bare `xray.exe`; the file is
   * staged, proven runnable, and only then swapped into place, so a bad drop never leaves a broken
   * kernel behind.
   */
  public async installCoreFromFile(filePath: string): Promise<ProxyCoreView> {
    const resolved = path.resolve(filePath);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error('找不到该文件。');
    }
    const extension = path.extname(resolved).toLowerCase();
    if (extension !== '.zip' && path.basename(resolved).toLowerCase() !== 'xray.exe') {
      throw new Error('只接受 Xray-core 的 .zip 安装包或名为 xray.exe 的可执行文件。');
    }
    if (statSync(resolved).size > MAX_CORE_ARCHIVE_BYTES) {
      throw new Error('文件超过 64 MB 安全上限，已拒绝安装。');
    }
    const releaseBusy = this.busyRegistry.acquire({
      cancellable: false,
      id: 'proxy:install-core',
      kind: 'proxy',
      label: '安装 Xray-core 内核',
      severity: 'resumable',
    });
    const staging = path.join(this.userDataPath, 'proxy', 'core', '.staging');
    try {
      rmSync(staging, { force: true, recursive: true });
      mkdirSync(staging, { recursive: true });
      if (extension === '.zip') {
        await this.extractArchive(resolved, staging);
      } else {
        copyFileSync(resolved, path.join(staging, 'xray.exe'));
      }
      const stagedExecutable = path.join(staging, 'xray.exe');
      if (!existsSync(stagedExecutable)) {
        throw new Error('安装包里没有 xray.exe。');
      }
      const version = await readCoreVersion(stagedExecutable);
      if (!version) {
        throw new Error('该文件无法作为 Xray-core 运行，可能已损坏或架构不匹配。');
      }
      rmSync(this.coreDirectory, { force: true, recursive: true });
      mkdirSync(path.dirname(this.coreDirectory), { recursive: true });
      renameSync(staging, this.coreDirectory);
      this.installedVersion =
        extension === '.zip' && (await hashFile(resolved)) === XRAY_CORE_RELEASE.sha256
          ? `${version}（官方固定版本）`
          : `${version}（用户自备）`;
      this.notify();
      return this.getCoreView();
    } catch (error) {
      rmSync(staging, { force: true, recursive: true });
      throw error instanceof Error ? error : new Error('安装 Xray-core 失败。');
    } finally {
      releaseBusy();
    }
  }

  public async start(profile: XrayProfile, manualCorePath?: string): Promise<ProxyRuntimeView> {
    const releaseBusy = this.busyRegistry.acquire({
      cancellable: false,
      id: 'proxy:sidecar',
      kind: 'proxy',
      label: `启动内置代理 · ${profile.remark}`,
      severity: 'blocking',
    });
    try {
      await this.stop();
      const generation = ++this.startGeneration;
      this.setView({ error: undefined, profileId: profile.id, status: 'starting' });
      const corePath = manualCorePath
        ? this.validateManualCorePath(manualCorePath)
        : await this.ensureCore();
      this.assertCurrentStart(generation);
      const [httpPort, socksPort] = await Promise.all([
        reserveLoopbackPort(),
        reserveLoopbackPort(),
      ]);
      this.assertCurrentStart(generation);
      mkdirSync(this.runtimeDirectory, { recursive: true });
      const configPath = path.join(this.runtimeDirectory, 'config.json');
      this.atomicWrite(configPath, buildXrayConfig(profile, httpPort, socksPort));
      const child = spawn(corePath, ['run', '-config', configPath], {
        cwd: this.runtimeDirectory,
        env: { ...process.env },
        windowsHide: true,
      });
      this.child = child;
      const secrets = Object.values(profile.credentials ?? {}).map(String);
      const capture = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) {
          this.logs.push(redactProxyLog(line, secrets));
        }
        this.logs.splice(0, Math.max(0, this.logs.length - LOG_LIMIT));
        this.notify();
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.once('exit', (code) => {
        if (this.child !== child) {
          return;
        }
        this.child = undefined;
        this.removePidFile();
        if (this.view.status !== 'stopping') {
          this.setView({
            error: `Xray 意外退出（退出码 ${code ?? '未知'}）。`,
            httpProxyUrl: undefined,
            socksProxyUrl: undefined,
            status: 'error',
          });
        }
      });
      if (child.pid) {
        this.atomicWrite(this.pidPath, { pid: child.pid, version: 1 });
      }
      await probeHttpInbound(httpPort, () => this.child === child && !child.killed);
      this.assertCurrentStart(generation);
      this.setView({
        httpProxyUrl: `http://127.0.0.1:${httpPort}`,
        socksProxyUrl: `socks5://127.0.0.1:${socksPort}`,
        status: 'ready',
      });
      return this.getView();
    } catch (error) {
      // A failed or cancelled start leaves nothing running, so the state has to say `stopped` — the
      // error text is kept for the log, but the panel must offer 启动 again rather than 停止.
      await this.stop();
      this.setView({
        error: error instanceof Error ? error.message : '内置代理启动失败。',
        status: 'stopped',
      });
      throw error;
    } finally {
      releaseBusy();
    }
  }

  public async stop(): Promise<ProxyRuntimeView> {
    const wasStarting = this.view.status === 'starting';
    this.startGeneration += 1;
    if (wasStarting) {
      // Abandoning a start also means abandoning the core download it is waiting on.
      try {
        this.downloadEngine.cancel(`xray-core-${XRAY_CORE_RELEASE.version}`);
      } catch {
        // No download in flight is the common case when the core is already installed.
      }
    }
    const child = this.child;
    if (!child) {
      this.removePidFile();
      this.setView({ httpProxyUrl: undefined, socksProxyUrl: undefined, status: 'stopped' });
      return this.getView();
    }
    this.setView({ status: 'stopping' });
    this.child = undefined;
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2_000);
      forceTimer.unref();
      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });
      if (!child.kill()) {
        clearTimeout(forceTimer);
        resolve();
      }
    });
    this.removePidFile();
    this.setView({
      error: undefined,
      httpProxyUrl: undefined,
      profileId: undefined,
      socksProxyUrl: undefined,
      status: 'stopped',
    });
    return this.getView();
  }

  private assertCurrentStart(generation: number): void {
    if (this.startGeneration !== generation) {
      throw new Error('内置代理启动已取消。');
    }
  }

  private buildSources(): XrayCoreSource[] {
    return buildXrayCoreSources(XRAY_CORE_RELEASE, this.mirrorHosts());
  }

  private async runProbe(): Promise<{
    results: XrayCoreProbeResult[];
    sources: XrayCoreSource[];
  }> {
    const sources = this.buildSources();
    const results = await probeXrayCoreSources(sources, {
      fetchImpl: this.fetchImpl,
      release: XRAY_CORE_RELEASE,
    });
    this.probeResults = results;
    this.probedAt = Date.now();
    return { results, sources };
  }

  private async refreshInstalledVersion(): Promise<void> {
    const executablePath = path.join(this.coreDirectory, 'xray.exe');
    if (!existsSync(executablePath)) {
      this.installedVersion = undefined;
      return;
    }
    this.installedVersion ??= (await readCoreVersion(executablePath)) ?? XRAY_CORE_RELEASE.version;
  }

  private async extractArchive(archivePath: string, destination: string): Promise<void> {
    mkdirSync(destination, { recursive: true });
    /*
     * The paths travel as environment variables, not as trailing arguments: `powershell.exe -Command`
     * appends anything after the command string to the command text itself and leaves `$args` empty,
     * so the obvious `$args[0]` form fails parameter validation every single time. `$env:` lookups are
     * substituted as literal values rather than re-parsed, which also keeps a path containing quotes
     * or `;` from turning into a second statement.
     */
    const extraction = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:CLAUDEDOCK_CORE_ARCHIVE -DestinationPath $env:CLAUDEDOCK_CORE_DESTINATION -Force',
      ],
      {
        env: {
          ...process.env,
          CLAUDEDOCK_CORE_ARCHIVE: archivePath,
          CLAUDEDOCK_CORE_DESTINATION: destination,
        },
        windowsHide: true,
      },
    );
    await waitForProcess(extraction, '解压 Xray-core');
  }

  /**
   * Probes every route before committing to one. The old single-source version pointed only at
   * GitHub's release CDN, which is precisely the host a user without working connectivity cannot
   * reach — so the feature that exists to provide connectivity could not install itself. Probing
   * first also means a dead route fails in four seconds with a list of what was tried, instead of
   * burning twelve auto-resume attempts against a host that was never going to answer.
   */
  private async ensureCore(): Promise<string> {
    const executablePath = path.join(this.coreDirectory, 'xray.exe');
    if (existsSync(executablePath)) {
      await this.refreshInstalledVersion();
      return executablePath;
    }
    const fresh =
      this.probedAt !== undefined &&
      Date.now() - this.probedAt < PROBE_CACHE_MS &&
      this.probeResults.some((result) => result.status === 'ok');
    const sources = this.buildSources();
    const results = fresh ? this.probeResults : (await this.runProbe()).results;
    this.notify();
    const source = pickFastestSource(sources, results);
    if (!source) {
      throw new Error(describeProbeFailure(sources, results));
    }
    const archivePath = path.join(
      this.userDataPath,
      'proxy',
      'downloads',
      `${XRAY_CORE_RELEASE.version}-${XRAY_CORE_RELEASE.fileName}`,
    );
    await this.downloadEngine.start({
      allowedHosts: source.allowedHosts,
      allowedPathPrefixes: source.allowedPathPrefixes,
      expectedBytes: XRAY_CORE_RELEASE.bytes,
      expectedSha256: XRAY_CORE_RELEASE.sha256,
      finalPath: archivePath,
      id: `xray-core-${XRAY_CORE_RELEASE.version}`,
      label: `Xray-core ${XRAY_CORE_RELEASE.version} · ${source.label}`,
      maxBytes: MAX_CORE_ARCHIVE_BYTES,
      url: source.url,
    });
    await this.extractArchive(archivePath, this.coreDirectory);
    if (!existsSync(executablePath)) {
      throw new Error('Xray-core 安装包中缺少 xray.exe。');
    }
    await this.refreshInstalledVersion();
    return executablePath;
  }

  private validateManualCorePath(candidate: string): string {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved) || path.basename(resolved).toLowerCase() !== 'xray.exe') {
      throw new Error('手动指定的 Xray-core 路径必须指向现有的 xray.exe。');
    }
    return resolved;
  }

  private cleanupOrphan(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.pidPath, 'utf8')) as { pid?: unknown };
      if (
        Number.isInteger(parsed.pid) &&
        Number(parsed.pid) > 0 &&
        Number(parsed.pid) !== process.pid
      ) {
        process.kill(Number(parsed.pid), 'SIGTERM');
      }
    } catch {
      // A missing, stale, or already-dead process is the desired state.
    }
    this.removePidFile();
  }

  private removePidFile(): void {
    try {
      unlinkSync(this.pidPath);
    } catch {
      // Missing is already clean.
    }
  }

  private setView(update: Partial<ProxyRuntimeView>): void {
    this.view = { ...this.view, ...update };
    this.notify();
  }

  private notify(): void {
    const view = this.getView();
    for (const listener of this.listeners) {
      listener(view);
    }
  }

  private atomicWrite(targetPath: string, value: unknown): void {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, targetPath);
  }
}
