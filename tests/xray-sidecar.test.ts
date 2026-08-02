import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BusyRegistry } from '../src/main/busy-registry';
import type { DownloadEngine } from '../src/main/download-engine';
import {
  buildXrayConfig,
  probeHttpInbound,
  redactProxyLog,
  XraySidecar,
  XRAY_CORE_RELEASE,
} from '../src/main/proxy/xray-sidecar';

const profile = {
  address: 'proxy.example',
  credentials: { password: 'synthetic-secret' },
  hasCredentials: true,
  id: 'trojan-one',
  port: 443,
  protocol: 'trojan' as const,
  remark: 'Synthetic',
  security: 'tls' as const,
  serverName: 'sni.example',
  tls: true,
  transport: 'ws' as const,
  transportPath: '/socket',
  updatedAt: 1,
};

/** The user-reported self-hosted node: VLESS + REALITY + XTLS vision over plain TCP. */
const realityProfile = {
  address: '64.64.253.190',
  credentials: { uuid: 'cdd66f7e-3d8e-4751-c22f-069f198f7539' },
  fingerprint: 'firefox',
  flow: 'xtls-rprx-vision',
  hasCredentials: true,
  id: 'vless-reality',
  port: 443,
  protocol: 'vless' as const,
  publicKey: '21GGhV4uBlCJ16U3-i8dTvR6S88dhp2qkBKqbR3xLy4',
  remark: 'vless-reality',
  security: 'reality' as const,
  serverName: 'iosapps.itunes.apple.com',
  tls: true,
  transport: 'tcp' as const,
  updatedAt: 1,
};

describe('Xray sidecar configuration', () => {
  it('pins the official Windows asset with exact integrity metadata', () => {
    expect(XRAY_CORE_RELEASE).toEqual({
      bytes: 20_913_304,
      fileName: 'Xray-windows-64.zip',
      sha256: 'd004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad',
      version: 'v26.3.27',
    });
  });

  /*
   * The in-flight ceiling used to be the pinned asset size exactly, so a release republished even a
   * byte larger tripped 「下载内容超过安全上限」 immediately and unrecoverably — the download never got a
   * chance to auto-resume, which is what "the core always fails to download" actually looked like.
   * Exactness belongs to expectedBytes + expectedSha256 at completion; the ceiling only bounds damage.
   */
  it('gives the core download headroom over the pinned asset size', () => {
    const source = readFileSync(
      new URL('../src/main/proxy/xray-sidecar.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('maxBytes: MAX_CORE_ARCHIVE_BYTES,');
    expect(source).not.toContain('maxBytes: XRAY_CORE_RELEASE.bytes,');
    expect(source).toContain('expectedBytes: XRAY_CORE_RELEASE.bytes,');
    expect(source).toContain('expectedSha256: XRAY_CORE_RELEASE.sha256,');
    const ceiling = /const MAX_CORE_ARCHIVE_BYTES = (\d+) \* 1024 \* 1024;/.exec(source);
    expect(ceiling).not.toBeNull();
    expect(Number(ceiling?.[1]) * 1024 * 1024).toBeGreaterThan(XRAY_CORE_RELEASE.bytes * 2);
  });

  it('binds both inbounds to loopback and blocks IPv6 egress inside the tunnel', () => {
    const config = buildXrayConfig(profile, 41001, 41002) as {
      dns: { queryStrategy: string };
      inbounds: Array<{ listen: string; port: number; protocol: string }>;
      outbounds: Array<{
        protocol: string;
        settings: unknown;
        streamSettings?: Record<string, unknown>;
        tag: string;
      }>;
      routing: { domainStrategy: string; rules: Array<{ ip: string[]; outboundTag: string }> };
    };
    expect(config.inbounds).toEqual([
      expect.objectContaining({ listen: '127.0.0.1', port: 41001, protocol: 'http' }),
      expect.objectContaining({ listen: '127.0.0.1', port: 41002, protocol: 'socks' }),
    ]);
    expect(JSON.stringify(config)).not.toContain('0.0.0.0');
    expect(config.dns.queryStrategy).toBe('UseIPv4');
    expect(config.outbounds[0]?.streamSettings?.sockopt).toEqual({ domainStrategy: 'UseIPv4' });
    expect(config.outbounds).toContainEqual(
      expect.objectContaining({ protocol: 'blackhole', tag: 'block' }),
    );
    expect(config.routing.domainStrategy).toBe('IPIfNonMatch');
    expect(config.routing.rules[0]).toEqual({ ip: ['::/0'], outboundTag: 'block', type: 'field' });
  });

  it('redacts raw and URL-encoded credentials from the diagnostic ring', () => {
    expect(
      redactProxyLog('failed synthetic-secret synthetic%2Dsecret', ['synthetic-secret']),
    ).not.toContain('synthetic-secret');
  });

  it('emits realitySettings (never tlsSettings) and keeps XTLS flow for a REALITY node', () => {
    const config = buildXrayConfig(realityProfile, 41001, 41002) as {
      outbounds: Array<{
        settings: { vnext: Array<{ users: Array<{ encryption: string; flow?: string }> }> };
        streamSettings: Record<string, unknown>;
      }>;
    };
    const outbound = config.outbounds[0]!;
    expect(outbound.streamSettings).toEqual({
      network: 'tcp',
      realitySettings: {
        fingerprint: 'firefox',
        publicKey: '21GGhV4uBlCJ16U3-i8dTvR6S88dhp2qkBKqbR3xLy4',
        serverName: 'iosapps.itunes.apple.com',
        shortId: '',
        show: false,
        spiderX: '',
      },
      security: 'reality',
      sockopt: { domainStrategy: 'UseIPv4' },
    });
    expect(outbound.streamSettings.tlsSettings).toBeUndefined();
    expect(outbound.settings.vnext[0]!.users[0]).toEqual({
      encryption: 'none',
      flow: 'xtls-rprx-vision',
      id: 'cdd66f7e-3d8e-4751-c22f-069f198f7539',
    });
  });
});

const temporaryRoots: string[] = [];

const makeSidecar = (
  fetchImpl: (url: string) => Promise<Response>,
): { sidecar: XraySidecar; userDataPath: string } => {
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-xray-'));
  temporaryRoots.push(userDataPath);
  return {
    sidecar: new XraySidecar({
      busyRegistry: new BusyRegistry(),
      downloadEngine: {
        cancel: () => undefined,
        start: async () => {
          throw new Error('该测试不应触发真实下载。');
        },
      } as unknown as DownloadEngine,
      fetchImpl,
      userDataPath,
    }),
    userDataPath,
  };
};

const unreachable = async (): Promise<Response> => {
  throw new Error('getaddrinfo ENOTFOUND');
};

describe('Xray core installation and route selection', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('reports a missing core with every built-in route listed but untested', () => {
    const { sidecar } = makeSidecar(unreachable);
    const view = sidecar.getCoreView();
    expect(view).toMatchObject({
      installed: false,
      installedVersion: undefined,
      probing: false,
      requiredVersion: XRAY_CORE_RELEASE.version,
    });
    expect(view.lastProbedAt).toBeUndefined();
    expect(view.sources.length).toBeGreaterThan(1);
    expect(view.sources.every((source) => source.status === 'unknown')).toBe(true);
    expect(view.sources.at(-1)?.kind).toBe('official');
  });

  it('adds user mirrors to the probe list without touching the built-in ones', () => {
    const { sidecar } = makeSidecar(unreachable);
    const builtIn = sidecar.getCoreView().sources.length;
    const withCustom = new XraySidecar({
      busyRegistry: new BusyRegistry(),
      downloadEngine: { cancel: () => undefined } as unknown as DownloadEngine,
      fetchImpl: unreachable,
      mirrorHosts: () => ['gh.example.com', 'not a host'],
      userDataPath: mkdtempSync(path.join(tmpdir(), 'claudedock-xray-')),
    }).getCoreView().sources;
    expect(withCustom).toHaveLength(builtIn + 1);
    expect(withCustom.at(-1)).toMatchObject({ kind: 'custom', status: 'unknown' });
  });

  it('records why each route failed after a probe instead of leaving them unknown', async () => {
    const { sidecar } = makeSidecar(unreachable);
    const view = await sidecar.probeSources();
    expect(view.probing).toBe(false);
    expect(typeof view.lastProbedAt).toBe('number');
    expect(view.sources.every((source) => source.status === 'failed')).toBe(true);
    expect(view.sources[0]?.detail).toContain('ENOTFOUND');
  });

  /*
   * The old behaviour was 12 automatic resume attempts against a single unreachable host, which read
   * to the user as a three-minute hang ending in 「下载失败」. When no route answers there is nothing
   * to retry, so the start has to stop immediately and say what to do instead.
   */
  it('fails a start with an actionable route report rather than retrying a dead download', async () => {
    const { sidecar } = makeSidecar(unreachable);
    await expect(sidecar.start({ ...profile, hasCredentials: false })).rejects.toThrow(
      '所有 Xray-core 下载线路都不可用',
    );
    const runtime = sidecar.getView();
    expect(runtime.status).toBe('stopped');
    expect(runtime.error).toContain('引导代理');
    expect(runtime.error).toContain('拖入');
  });

  it('refuses files that cannot be an Xray-core kernel', async () => {
    const { sidecar, userDataPath } = makeSidecar(unreachable);
    const junk = path.join(userDataPath, 'notes.txt');
    writeFileSync(junk, 'not a kernel');
    await expect(sidecar.installCoreFromFile(junk)).rejects.toThrow(
      '只接受 Xray-core 的 .zip 安装包或名为 xray.exe 的可执行文件。',
    );
    await expect(
      sidecar.installCoreFromFile(path.join(userDataPath, 'absent.zip')),
    ).rejects.toThrow('找不到该文件。');
    expect(sidecar.getCoreView().installed).toBe(false);
  });

  /*
   * Staging matters: a file that is named right but cannot run must not replace a kernel that works,
   * so the swap only happens after `xray.exe version` succeeds.
   */
  it('leaves no kernel behind when the dropped executable cannot run', async () => {
    const { sidecar, userDataPath } = makeSidecar(unreachable);
    const fake = path.join(userDataPath, 'xray.exe');
    writeFileSync(fake, 'MZ-but-not-really');
    await expect(sidecar.installCoreFromFile(fake)).rejects.toThrow(
      '该文件无法作为 Xray-core 运行，可能已损坏或架构不匹配。',
    );
    const view = sidecar.getCoreView();
    expect(view.installed).toBe(false);
    expect(view.executablePath).toBeUndefined();
  });

  it('stages installs and only swaps a proven kernel into place', () => {
    const source = readFileSync(
      new URL('../src/main/proxy/xray-sidecar.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('public async installCoreFromFile');
    const body = source.slice(start, source.indexOf('\n  public async start', start));
    expect(body.indexOf('await readCoreVersion(stagedExecutable)')).toBeLessThan(
      body.indexOf('renameSync(staging, this.coreDirectory)'),
    );
    expect(body).toContain('（官方固定版本）');
    expect(body).toContain('（用户自备）');
  });
});

/*
 * Xray binds its inbound well after `spawn` resolves, so the health check races the process it is
 * checking. Taking the first `ECONNREFUSED` as the answer made 启动 fail in under 50 ms — before the
 * kernel had even parsed its config — which reads to the user as "the proxy still doesn't work".
 */
describe('local inbound health check', () => {
  const listeners: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      listeners.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  /** A stand-in for Xray's HTTP inbound, which answers CONNECT before it dials the outbound. */
  const listen = (port: number, status: string): Promise<void> =>
    new Promise((resolve) => {
      const server = createServer((socket) => {
        socket.on('data', () => socket.end(`HTTP/1.1 ${status}\r\n\r\n`));
      });
      listeners.push(server);
      server.listen(port, '127.0.0.1', () => resolve());
    });

  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });

  it('keeps knocking until the inbound comes up instead of failing on the first refusal', async () => {
    const port = await freePort();
    const pending = probeHttpInbound(port, () => true, 4_000);
    setTimeout(() => void listen(port, '200 Connection established'), 400);
    await expect(pending).resolves.toBeUndefined();
  });

  it('stops immediately once the kernel it is waiting for has exited', async () => {
    const port = await freePort();
    await expect(probeHttpInbound(port, () => false, 4_000)).rejects.toThrow(
      'Xray 在完成健康检查前就退出了，请查看下方日志。',
    );
  });

  it('does not retry an answer that retrying cannot change', async () => {
    const port = await freePort();
    await listen(port, '502 Bad Gateway');
    const startedAt = Date.now();
    await expect(probeHttpInbound(port, () => true, 4_000)).rejects.toThrow(
      '本地代理已启动，但选中节点未通过联网探测。',
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
