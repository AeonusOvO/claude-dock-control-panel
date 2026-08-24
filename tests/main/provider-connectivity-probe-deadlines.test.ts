import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectivityProbe } from '../../src/main/network/provider-connectivity-probe';
import { createProbe, deferred } from '../helpers/provider-connectivity-probe-fixture';

describe('ProviderConnectivityProbe deadlines', () => {
  it('preserves completed DNS and endpoint siblings when only some items time out', async () => {
    const pendingDns = new Promise<never>(() => undefined);
    const pendingApplication = new Promise<never>(() => undefined);
    const probe = new ProviderConnectivityProbe({
      applicationRequest: (url) =>
        url === 'https://claude.ai/'
          ? pendingApplication
          : Promise.resolve({ contentType: 'application/json', redirects: [], status: 204 }),
      cliRequest: async (url) => `401|${url}|0|application/json`,
      clientVersion: async () => '2.1.200',
      dnsLookup: (host) =>
        host === 'claude.ai'
          ? pendingDns
          : Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      overallTimeoutMs: 20,
      resolveProxy: async () => 'DIRECT',
    });

    const result = await probe.run('anthropic-claude', 'first-request');

    expect(result.probes.find(({ id }) => id === 'dns:claude.ai')?.status).toBe('skipped');
    expect(result.probes.find(({ id }) => id === 'app:anthropic-claude-auth')?.status).toBe(
      'skipped',
    );
    expect(result.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dns:platform.claude.com', status: 'passed' }),
        expect.objectContaining({ id: 'dns:api.anthropic.com', status: 'passed' }),
        expect.objectContaining({ id: 'app:anthropic-console-auth', status: 'passed' }),
        expect.objectContaining({ id: 'app:anthropic-api', status: 'passed' }),
        expect.objectContaining({ id: 'cli:anthropic-api', status: 'passed' }),
      ]),
    );
  });

  it('starts independent application and CLI transports concurrently in stable result order', async () => {
    const targetUrl = 'https://chatgpt.com/backend-api/codex';
    const applicationOutcome = deferred<{
      contentType: string;
      redirects: never[];
      status: number;
    }>();
    const cliOutcome = deferred<string>();
    const applicationRequest = vi.fn((url: string) =>
      url === targetUrl
        ? applicationOutcome.promise
        : Promise.resolve({ contentType: 'application/json', redirects: [], status: 204 }),
    );
    const cliRequest = vi.fn((url: string, websocket: boolean) =>
      url === targetUrl
        ? cliOutcome.promise
        : Promise.resolve(
            websocket
              ? `101|${url.replace(/^wss:/, 'https:')}|0|`
              : `401|${url}|0|application/json`,
          ),
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      cliRequest,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      overallTimeoutMs: 1_000,
      resolveProxy: async () => 'DIRECT',
    });
    const operation = probe.run('openai-codex', 'cli-launch');

    try {
      await vi.waitFor(() => {
        expect(applicationRequest).toHaveBeenCalledWith(
          targetUrl,
          undefined,
          expect.objectContaining({
            allowedDomains: expect.arrayContaining(['chatgpt.com', 'auth.openai.com']),
          }),
        );
        expect(cliRequest).toHaveBeenCalledWith(targetUrl, false, undefined, undefined);
      });
      cliOutcome.resolve(`401|${targetUrl}|0|application/json`);
      applicationOutcome.resolve({ contentType: 'application/json', redirects: [], status: 204 });
      const result = await operation;
      const applicationIndex = result.probes.findIndex(({ id }) => id === 'app:openai-codex-api');
      const cliIndex = result.probes.findIndex(({ id }) => id === 'cli:openai-codex-api');
      expect(applicationIndex).toBeGreaterThanOrEqual(0);
      expect(cliIndex).toBeGreaterThan(applicationIndex);
    } finally {
      cliOutcome.resolve(`401|${targetUrl}|0|application/json`);
      applicationOutcome.resolve({ contentType: 'application/json', redirects: [], status: 204 });
    }
  });

  it('bounds repeated hung OS DNS lookups without retaining an unbounded queue', async () => {
    const dnsLookup = vi.fn(() => new Promise<never>(() => undefined));
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => ({
        contentType: 'application/json',
        redirects: [],
        status: 204,
      }),
      dnsLookup,
      overallTimeoutMs: 10,
      resolveProxy: async () => 'DIRECT',
    });
    const target = {
      process: 'application' as const,
      url: 'https://api.openai.com/v1/chat/completions',
    };

    await Promise.all(
      Array.from({ length: 10 }, () =>
        probe.run('openai-api', 'first-request', undefined, 'application', target),
      ),
    );
    expect(dnsLookup).toHaveBeenCalledTimes(6);

    await probe.run('openai-api', 'first-request', undefined, 'application', target);
    expect(dnsLookup).toHaveBeenCalledTimes(6);
  });

  it('bounds repeated hung Electron PAC lookups without retaining an unbounded queue', async () => {
    const resolveProxy = vi.fn(() => new Promise<never>(() => undefined));
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => ({
        contentType: 'application/json',
        redirects: [],
        status: 204,
      }),
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      overallTimeoutMs: 10,
      resolveProxy,
    });
    const target = {
      process: 'application' as const,
      url: 'https://api.openai.com/v1/chat/completions',
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        probe.run('openai-api', 'first-request', undefined, 'application', target),
      ),
    );
    expect(resolveProxy).toHaveBeenCalledTimes(2);
    expect(
      results.every(({ paths }) => paths.every(({ proxyKind }) => proxyKind === 'unknown')),
    ).toBe(true);

    await probe.run('openai-api', 'first-request', undefined, 'application', target);
    expect(resolveProxy).toHaveBeenCalledTimes(2);
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
    expect(
      result.paths
        .filter(({ process }) => ['application', 'renderer'].includes(process))
        .every(({ proxyKind }) => proxyKind === 'unknown'),
    ).toBe(true);
    expect(
      result.paths
        .filter(({ process }) => ['codex-cli', 'terminal'].includes(process))
        .every(({ proxyKind }) => proxyKind !== 'unknown'),
    ).toBe(true);
  });
});
