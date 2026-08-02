import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import type {
  ProxyCredentialInput,
  ProxyProfileView,
  ProxyRuntimeView,
} from '../../shared/contracts';
import type { BusyRegistry } from '../busy-registry';
import type { DownloadEngine } from '../download-engine';

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

interface XrayProfile extends ProxyProfileView {
  credentials?: ProxyCredentialInput;
}

type XrayListener = (view: ProxyRuntimeView) => void;

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
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label}失败（退出码 ${code ?? '未知'}）。`));
      }
    });
  });

const probeHttpInbound = (port: number, timeoutMs = 8_000): Promise<void> =>
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

export class XraySidecar {
  private child?: ChildProcessWithoutNullStreams;
  private readonly coreDirectory: string;
  private readonly listeners = new Set<XrayListener>();
  private readonly logs: string[] = [];
  private readonly pidPath: string;
  private readonly runtimeDirectory: string;
  /**
   * Bumped by every `stop()`. A start that is still fetching or extracting the core compares it
   * across each await, so pressing 停止 mid-download actually abandons the attempt instead of
   * letting it finish and silently re-enter `ready`.
   */
  private startGeneration = 0;
  private view: ProxyRuntimeView = {
    coreVersion: XRAY_CORE_RELEASE.version,
    logs: [],
    status: 'stopped',
  };

  public constructor(
    private readonly userDataPath: string,
    private readonly downloadEngine: DownloadEngine,
    private readonly busyRegistry: BusyRegistry,
    onChange?: XrayListener,
  ) {
    this.coreDirectory = path.join(userDataPath, 'proxy', 'core', XRAY_CORE_RELEASE.version);
    this.runtimeDirectory = path.join(userDataPath, 'proxy', 'runtime');
    this.pidPath = path.join(this.runtimeDirectory, 'xray.pid');
    if (onChange) {
      this.listeners.add(onChange);
    }
    this.cleanupOrphan();
  }

  public getView(): ProxyRuntimeView {
    return { ...this.view, logs: [...this.logs] };
  }

  public onChange(listener: XrayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      await probeHttpInbound(httpPort);
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

  private async ensureCore(): Promise<string> {
    const executablePath = path.join(this.coreDirectory, 'xray.exe');
    if (existsSync(executablePath)) {
      return executablePath;
    }
    const archivePath = path.join(
      this.userDataPath,
      'proxy',
      'downloads',
      `${XRAY_CORE_RELEASE.version}-${XRAY_CORE_RELEASE.fileName}`,
    );
    await this.downloadEngine.start({
      allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
      allowedPathPrefixes: [`/XTLS/Xray-core/releases/download/${XRAY_CORE_RELEASE.version}/`, '/'],
      expectedBytes: XRAY_CORE_RELEASE.bytes,
      expectedSha256: XRAY_CORE_RELEASE.sha256,
      finalPath: archivePath,
      id: `xray-core-${XRAY_CORE_RELEASE.version}`,
      label: `Xray-core ${XRAY_CORE_RELEASE.version}`,
      maxBytes: MAX_CORE_ARCHIVE_BYTES,
      url: `https://github.com/XTLS/Xray-core/releases/download/${XRAY_CORE_RELEASE.version}/${XRAY_CORE_RELEASE.fileName}`,
    });
    mkdirSync(this.coreDirectory, { recursive: true });
    const extraction = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        archivePath,
        this.coreDirectory,
      ],
      { windowsHide: true },
    );
    await waitForProcess(extraction, '解压 Xray-core');
    if (!existsSync(executablePath)) {
      throw new Error('Xray-core 安装包中缺少 xray.exe。');
    }
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
