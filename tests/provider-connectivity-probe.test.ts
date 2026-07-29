import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectivityProbe } from '../src/main/provider-connectivity-probe';

const createProbe = (cliRequest?: (url: string, websocket: boolean) => Promise<string>) => {
  const appFetch = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }),
  );
  return {
    appFetch,
    probe: new ProviderConnectivityProbe({
      appFetch,
      cliRequest:
        cliRequest ??
        (async (url, websocket) =>
          websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`),
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    }),
  };
};

describe('ProviderConnectivityProbe', () => {
  it('uses only metadata requests and controlled CLI probes in privacy mode', async () => {
    const { appFetch, probe } = createProbe();
    const result = await probe.run('openai-codex', 'background', true);

    expect(result.egress).toBeUndefined();
    expect(result.probes.some((item) => item.kind === 'dns' && item.status === 'passed')).toBe(
      true,
    );
    expect(
      result.probes.some((item) => item.kind === 'websocket' && item.status === 'passed'),
    ).toBe(true);
    expect(appFetch).toHaveBeenCalled();
    expect(
      appFetch.mock.calls.every(
        ([, init]) => init.method === 'HEAD' && init.credentials === 'omit',
      ),
    ).toBe(true);
  });

  it('detects captive-portal HTML on the required CLI API path', async () => {
    const { probe } = createProbe(async (url, websocket) =>
      websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `200|${url}|0|text/html`,
    );
    const result = await probe.run('openai-codex', 'cli-launch', true);
    const apiProbe = result.probes.find((item) => item.id === 'cli:openai-codex-api');

    expect(apiProbe?.status).toBe('failed');
    expect(apiProbe?.detail).toContain('非预期 HTML');
  });

  it('flags public-domain DNS rewrites to private addresses', async () => {
    const { appFetch } = createProbe();
    const probe = new ProviderConnectivityProbe({
      appFetch,
      cliRequest: async (url) => `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '192.168.1.1', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });
    const result = await probe.run('openai-codex', 'background', true);

    expect(result.probes.filter((item) => item.kind === 'dns')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.stringContaining('DNS 重写'),
          status: 'failed',
        }),
      ]),
    );
  });

  it('caps third-party JSON and keeps reputation flags auxiliary', async () => {
    const appFetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'HEAD') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('ipapi.co')) {
        return new Response('{}', {
          headers: { 'content-length': String(64 * 1024 + 1) },
          status: 200,
        });
      }
      if (url.includes('ipwho.is')) {
        return Response.json({
          connection: { org: 'Example Hosting' },
          country: 'United States',
          country_code: 'US',
          ip: '203.0.113.10',
          security: { hosting: true, vpn: true },
        });
      }
      return Response.json({
        ip: url.includes('api6') ? '2001:db8::10' : '203.0.113.10',
      });
    });
    const probe = new ProviderConnectivityProbe({
      appFetch,
      cliRequest: async (url, websocket) =>
        websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });

    const result = await probe.run('openai-codex', 'background', false);

    expect(result.egress).toMatchObject({
      riskFlags: ['VPN', '托管/数据中心'],
      sourceCount: 1,
      sources: ['ipwho.is'],
      sourcesAgree: false,
    });
  });
});
