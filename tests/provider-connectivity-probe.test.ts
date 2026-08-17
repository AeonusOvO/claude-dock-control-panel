import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConnectivityProbe,
  type ApplicationEndpointRequest,
} from '../src/main/provider-connectivity-probe';

const createProbe = (
  cliRequest?: (url: string, websocket: boolean) => Promise<string>,
  applicationRequest?: ApplicationEndpointRequest,
) => {
  const appFetch = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }),
  );
  return {
    appFetch,
    probe: new ProviderConnectivityProbe({
      appFetch,
      applicationRequest,
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
  it('uses only metadata requests and controlled CLI probes', async () => {
    const { appFetch, probe } = createProbe();
    const result = await probe.run('openai-codex', 'background');

    expect(result.probes.some((item) => item.kind === 'dns' && item.status === 'passed')).toBe(
      true,
    );
    expect(
      result.probes.some((item) => item.kind === 'websocket' && item.status === 'passed'),
    ).toBe(true);
    expect(appFetch).toHaveBeenCalled();
    expect(
      appFetch.mock.calls.every(
        ([, init]) =>
          init.method === 'HEAD' && init.credentials === 'omit' && init.redirect === 'follow',
      ),
    ).toBe(true);
  });

  it('follows and validates trusted application redirect chains', async () => {
    const applicationRequest = vi.fn(async (url: string) => ({
      contentType: 'text/html',
      redirects: url.includes('chatgpt.com')
        ? [
            { host: 'auth.openai.com', statusCode: 302 },
            { host: 'chatgpt.com', statusCode: 302 },
          ]
        : [],
      status: 200,
    }));
    const { probe } = createProbe(undefined, applicationRequest);
    const result = await probe.run('openai-codex', 'background');
    const chatgptProbe = result.probes.find((item) => item.id === 'app:openai-chatgpt');

    expect(chatgptProbe).toMatchObject({
      status: 'passed',
      detail: expect.stringContaining('2 次受信任重定向'),
    });
  });

  it('flags application redirects outside the provider allowlist', async () => {
    const { probe } = createProbe(undefined, async (url) => ({
      contentType: 'text/html',
      redirects: url.includes('chatgpt.com') ? [{ host: 'portal.example', statusCode: 302 }] : [],
      status: 200,
    }));
    const result = await probe.run('openai-codex', 'background');
    const chatgptProbe = result.probes.find((item) => item.id === 'app:openai-chatgpt');

    expect(chatgptProbe).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('portal.example'),
    });
  });

  it('treats a legacy redirect cancellation as inconclusive instead of unreachable', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new Error('Redirect was cancelled');
    });
    const result = await probe.run('openai-codex', 'background');
    const chatgptProbe = result.probes.find((item) => item.id === 'app:openai-chatgpt');

    expect(chatgptProbe).toMatchObject({
      required: true,
      status: 'warning',
      detail: expect.stringContaining('不证明网络失败'),
    });
  });

  it('detects captive-portal HTML on the required CLI API path', async () => {
    const { probe } = createProbe(async (url, websocket) =>
      websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `200|${url}|0|text/html`,
    );
    const result = await probe.run('openai-codex', 'cli-launch');
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
    const result = await probe.run('openai-codex', 'background');

    expect(result.probes.filter((item) => item.kind === 'dns')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.stringContaining('DNS 重写'),
          status: 'failed',
        }),
      ]),
    );
  });

  it('settles under an overall deadline when DNS never resolves', async () => {
    const { appFetch } = createProbe();
    const probe = new ProviderConnectivityProbe({
      appFetch,
      cliRequest: async (url) => `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      // A DNS lookup that never settles used to hang the whole preflight forever, because run()
      // awaits Promise.all with no deadline of its own.
      dnsLookup: () => new Promise(() => undefined),
      overallTimeoutMs: 20,
      resolveProxy: async () => 'DIRECT',
    });

    const result = await probe.run('openai-codex', 'background');

    // Timing out must degrade to an explicit unknown/skipped probe, which the risk engine treats as
    // a required failure — never a silent pass.
    const dnsProbe = result.probes.find((item) => item.kind === 'dns');
    expect(dnsProbe?.status).toBe('skipped');
    expect(dnsProbe?.detail).toContain('超时');
  });

  it('settles under an overall deadline when the proxy lookup never resolves', async () => {
    const { appFetch } = createProbe();
    const probe = new ProviderConnectivityProbe({
      appFetch,
      cliRequest: async (url) => `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      overallTimeoutMs: 20,
      // Electron's session.resolveProxy can hang indefinitely on a broken PAC script.
      resolveProxy: () => new Promise(() => undefined),
    });

    const result = await probe.run('openai-codex', 'background');

    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.paths.every((path) => path.proxyKind === 'unknown')).toBe(true);
  });
});
