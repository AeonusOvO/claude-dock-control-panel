import { describe, expect, it } from 'vitest';
import { buildXrayConfig, redactProxyLog, XRAY_CORE_RELEASE } from '../src/main/proxy/xray-sidecar';

const profile = {
  address: 'proxy.example',
  credentials: { password: 'synthetic-secret' },
  hasCredentials: true,
  id: 'trojan-one',
  port: 443,
  protocol: 'trojan' as const,
  remark: 'Synthetic',
  serverName: 'sni.example',
  tls: true,
  transport: 'ws' as const,
  transportPath: '/socket',
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

  it('binds both inbounds only to loopback and keeps remote DNS resolution', () => {
    const config = buildXrayConfig(profile, 41001, 41002) as {
      inbounds: Array<{ listen: string; port: number; protocol: string }>;
      outbounds: Array<{ settings: unknown }>;
      routing: { domainStrategy: string };
    };
    expect(config.inbounds).toEqual([
      expect.objectContaining({ listen: '127.0.0.1', port: 41001, protocol: 'http' }),
      expect.objectContaining({ listen: '127.0.0.1', port: 41002, protocol: 'socks' }),
    ]);
    expect(JSON.stringify(config)).not.toContain('0.0.0.0');
    expect(config.routing.domainStrategy).toBe('AsIs');
  });

  it('redacts raw and URL-encoded credentials from the diagnostic ring', () => {
    expect(
      redactProxyLog('failed synthetic-secret synthetic%2Dsecret', ['synthetic-secret']),
    ).not.toContain('synthetic-secret');
  });
});
