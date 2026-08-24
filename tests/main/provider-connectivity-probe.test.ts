import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectivityProbe } from '../../src/main/network/provider-connectivity-probe';
import { RiskDecisionEngine } from '../../src/main/network/risk-decision-engine';
import { createProbe, withProxyEnvironment } from '../helpers/provider-connectivity-probe-fixture';

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
          init.method === 'GET' && init.credentials === 'omit' && init.redirect === 'follow',
      ),
    ).toBe(true);
  });

  it('requires the exact Codex service endpoint for background provider authority', async () => {
    const { probe } = createProbe(
      async () => {
        throw new Error('synthetic CLI endpoint failure');
      },
      async () => {
        throw new Error('synthetic application endpoint failure');
      },
    );

    const observation = await probe.run('openai-codex', 'background');
    const codexService = observation.probes.find(
      (candidate) => candidate.id === 'cli:openai-codex-api',
    );
    const result = new RiskDecisionEngine().evaluate(
      'openai-codex',
      'background',
      observation,
      1,
      2,
    );

    expect(codexService).toMatchObject({ required: true, status: 'failed' });
    expect(result.providerConnectivity.status).toBe('blocked');
    expect(result.featureAccess).toEqual([
      expect.objectContaining({ action: 'background', allowed: false }),
    ]);
  });

  it('keeps a CLI action available when its exact HTTP-proxied endpoint passes despite local DNS failure', async () => {
    const probe = new ProviderConnectivityProbe({
      appFetch: async () => new Response(null, { status: 204 }),
      applicationProxyUrl: () => 'http://127.0.0.1:43123',
      cliRequest: async (url) => `401|${url}|0|application/json`,
      clientVersion: async () => '2.1.197',
      dnsLookup: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
      },
      resolveProxy: async () => 'DIRECT',
    });

    const observation = await probe.run('anthropic-claude', 'cli-launch');
    const dnsProbe = observation.probes.find(
      (candidate) => candidate.id === 'dns:api.anthropic.com',
    );
    const endpointProbe = observation.probes.find(
      (candidate) => candidate.id === 'cli:anthropic-api',
    );
    const result = new RiskDecisionEngine().evaluate(
      'anthropic-claude',
      'cli-launch',
      observation,
      1,
      2,
    );

    expect(dnsProbe).toMatchObject({ required: false, status: 'failed' });
    expect(endpointProbe).toMatchObject({ required: true, status: 'passed' });
    expect(result.providerConnectivity.status).toBe('allowed_with_notice');
    expect(result.featureAccess).toEqual([{ action: 'cli-launch', allowed: true }]);
  });

  it('keeps Electron-only OAuth failures advisory when the exact Codex login transport passes', async () => {
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => {
        throw new Error('Electron application route unavailable');
      },
      cliRequest: async (url, websocket) =>
        websocket ? `403|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });

    const observation = await probe.run('openai-codex', 'login');
    const result = new RiskDecisionEngine().evaluate('openai-codex', 'login', observation, 1, 2);

    expect(observation.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'app:openai-auth',
          process: 'application',
          required: false,
          status: 'failed',
        }),
        expect.objectContaining({
          id: 'app:openai-chatgpt',
          process: 'application',
          required: false,
          status: 'failed',
        }),
        expect.objectContaining({
          id: 'cli:openai-codex-api',
          process: 'codex-cli',
          required: true,
          status: 'passed',
        }),
      ]),
    );
    expect(observation.paths.some(({ process }) => process === 'oauth-browser')).toBe(false);
    expect(result.providerConnectivity.status).toBe('allowed_with_notice');
    expect(result.featureAccess).toEqual([{ action: 'login', allowed: true }]);
  });

  it('resolves destination-specific PAC transport before applying local DNS authority', async () => {
    const resolveProxy = vi.fn(async (url: string) =>
      url === 'https://chatgpt.com/' ? 'PROXY 127.0.0.1:7890' : 'DIRECT',
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => ({
        contentType: 'application/json',
        redirects: [],
        status: 204,
      }),
      cliRequest: async (url) => `401|${url}|0|application/json`,
      clientVersion: async () => undefined,
      dnsLookup: async (host) => {
        if (host === 'chatgpt.com') throw new Error('getaddrinfo ENOTFOUND chatgpt.com');
        return [{ address: '203.0.113.10', family: 4 }];
      },
      resolveProxy,
    });

    const observation = await probe.run('ai-services', 'background');
    const chatgptDns = observation.probes.find((candidate) => candidate.id === 'dns:chatgpt.com');
    const result = new RiskDecisionEngine().evaluate(
      'ai-services',
      'background',
      observation,
      1,
      2,
    );

    expect(resolveProxy).toHaveBeenCalledWith('https://chatgpt.com/', 'application', undefined);
    expect(resolveProxy).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex',
      'application',
      undefined,
    );
    expect(observation.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          process: 'application',
          proxyConfigured: true,
          target: 'https://chatgpt.com/',
        }),
        expect.objectContaining({
          process: 'application',
          proxyConfigured: false,
          target: 'https://chatgpt.com/backend-api/codex',
        }),
      ]),
    );
    expect(chatgptDns).toMatchObject({ required: true, status: 'failed' });
    expect(result.providerConnectivity.status).toBe('blocked');
  });

  it.each([
    ['SOCKS5', 'socks5://127.0.0.1:1080', true, 'blocked'],
    ['SOCKS5H', 'socks5h://127.0.0.1:1080', false, 'allowed_with_notice'],
  ] as const)(
    'preserves %s destination-DNS authority for a successful Codex transport',
    async (_case, proxyUrl, dnsRequired, expectedStatus) => {
      await withProxyEnvironment({ ALL_PROXY: proxyUrl }, async () => {
        const probe = new ProviderConnectivityProbe({
          applicationRequest: async () => ({
            contentType: 'application/json',
            redirects: [],
            status: 204,
          }),
          cliRequest: async (url) => `401|${url}|0|application/json`,
          clientVersion: async () => '0.146.0',
          dnsLookup: async () => {
            throw new Error('getaddrinfo ENOTFOUND chatgpt.com');
          },
          resolveProxy: async () => 'DIRECT',
        });

        const observation = await probe.run('openai-codex', 'cli-launch');
        const dnsProbe = observation.probes.find((candidate) => candidate.id === 'dns:chatgpt.com');
        const result = new RiskDecisionEngine().evaluate(
          'openai-codex',
          'cli-launch',
          observation,
          1,
          2,
        );

        expect(
          observation.paths.find(
            (path) =>
              path.process === 'codex-cli' &&
              path.target === 'https://chatgpt.com/backend-api/codex',
          ),
        ).toMatchObject({ proxyKind: dnsRequired ? 'socks' : 'socks5h' });
        expect(dnsProbe).toMatchObject({ required: dnsRequired, status: 'failed' });
        expect(result.providerConnectivity.status).toBe(expectedStatus);
        expect(result.featureAccess).toEqual([
          expect.objectContaining({ action: 'cli-launch', allowed: !dnsRequired }),
        ]);
      });
    },
  );

  it('keeps unproxied required DNS failures authoritative', async () => {
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => ({
        contentType: 'application/json',
        redirects: [],
        status: 204,
      }),
      cliRequest: async (url) => `401|${url}|0|application/json`,
      dnsLookup: async () => {
        throw new Error('getaddrinfo ENOTFOUND direct-provider-host');
      },
      resolveProxy: async () => 'DIRECT',
    });

    const observation = await probe.run('openai-codex', 'login');
    const result = new RiskDecisionEngine().evaluate('openai-codex', 'login', observation, 1, 2);

    expect(
      observation.probes.filter((candidate) => candidate.kind === 'dns' && candidate.required),
    ).not.toHaveLength(0);
    expect(result.providerConnectivity.status).toBe('blocked');
    expect(result.featureAccess).toEqual([
      expect.objectContaining({ action: 'login', allowed: false }),
    ]);
  });

  it('uses the selected Electron request and proxy resolver for conversation scope', async () => {
    const appFetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }),
    );
    const applicationRequest = vi.fn(async () => ({
      contentType: 'application/json',
      redirects: [],
      status: 204,
    }));
    const conversationRequest = vi.fn(async () => ({
      contentType: 'application/json',
      redirects: [],
      status: 204,
    }));
    const applicationRequestForScope = vi.fn((scope: 'application' | 'conversation') =>
      scope === 'conversation' ? conversationRequest : applicationRequest,
    );
    const resolveProxy = vi.fn(async () => 'DIRECT');
    const probe = new ProviderConnectivityProbe({
      appFetch,
      applicationRequestForScope,
      cliRequest: async (url, websocket) =>
        websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy,
    });

    await probe.run('openai-codex', 'background', undefined, 'conversation');

    expect(applicationRequestForScope).toHaveBeenCalledWith('conversation');
    expect(conversationRequest).toHaveBeenCalled();
    expect(applicationRequest).not.toHaveBeenCalled();
    expect(resolveProxy).toHaveBeenCalledWith(expect.any(String), 'conversation', undefined);
  });

  it('resolves and publishes the exact action target for destination-specific path evidence', async () => {
    const resolveProxy = vi.fn(async () => 'DIRECT');
    const probe = new ProviderConnectivityProbe({
      appFetch: async () => new Response(null, { status: 204 }),
      cliRequest: async (url, websocket) =>
        websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy,
    });

    const cliLaunch = await probe.run('openai-codex', 'cli-launch');
    expect(resolveProxy).toHaveBeenLastCalledWith(
      'https://chatgpt.com/backend-api/codex',
      'application',
      undefined,
    );
    expect(
      cliLaunch.paths.every((path) => path.target === 'https://chatgpt.com/backend-api/codex'),
    ).toBe(true);

    const login = await probe.run('openai-codex', 'login', undefined, 'conversation');
    expect(resolveProxy).toHaveBeenLastCalledWith(
      'https://chatgpt.com/backend-api/codex',
      'conversation',
      undefined,
    );
    expect(
      login.paths.every(
        (path) =>
          path.networkScope === 'conversation' &&
          path.target === 'https://chatgpt.com/backend-api/codex',
      ),
    ).toBe(true);

    const configuredTarget = 'https://gateway.example.test/v1/chat/completions';
    const custom = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: configuredTarget,
    });
    expect(resolveProxy).toHaveBeenLastCalledWith(configuredTarget, 'application', undefined);
    expect(custom.paths).toEqual([
      expect.objectContaining({
        networkScope: 'application',
        process: 'application',
        target: configuredTarget,
      }),
    ]);
  });

  it('checks an exact direct-chat endpoint only through the selected application scope', async () => {
    const appFetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }),
    );
    const applicationRequest = vi.fn(async () => ({
      contentType: 'application/json',
      redirects: [],
      status: 204,
    }));
    const conversationRequest = vi.fn(async () => ({
      contentType: 'application/json',
      redirects: [],
      status: 401,
    }));
    const applicationRequestForScope = vi.fn((scope: 'application' | 'conversation') =>
      scope === 'conversation' ? conversationRequest : applicationRequest,
    );
    const cliRequest = vi.fn(async () => '401|https://unused.example|0|application/json');
    const clientVersion = vi.fn(async () => '2.1.200');
    const dnsLookup = vi.fn(async () => [{ address: '203.0.113.10', family: 4 as const }]);
    const resolveProxy = vi.fn(async () => 'DIRECT');
    const probe = new ProviderConnectivityProbe({
      appFetch,
      applicationRequestForScope,
      cliRequest,
      clientVersion,
      dnsLookup,
      resolveProxy,
    });
    const url = 'https://api.anthropic.com/v1/messages';

    const result = await probe.run('anthropic-claude', 'first-request', undefined, 'conversation', {
      process: 'application',
      url,
    });

    expect(applicationRequestForScope).toHaveBeenCalledOnce();
    expect(applicationRequestForScope).toHaveBeenCalledWith('conversation');
    expect(conversationRequest).toHaveBeenCalledOnce();
    expect(conversationRequest).toHaveBeenCalledWith(url, undefined, {
      allowedDomains: ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com'],
    });
    expect(applicationRequest).not.toHaveBeenCalled();
    expect(appFetch).not.toHaveBeenCalled();
    expect(cliRequest).not.toHaveBeenCalled();
    expect(clientVersion).not.toHaveBeenCalled();
    expect(dnsLookup).toHaveBeenCalledOnce();
    expect(dnsLookup).toHaveBeenCalledWith('api.anthropic.com', undefined);
    expect(resolveProxy).toHaveBeenCalledOnce();
    expect(resolveProxy).toHaveBeenCalledWith(url, 'conversation', undefined);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.process).toBe('application');
    expect(result.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dns:api.anthropic.com', required: true }),
        expect.objectContaining({
          id: 'app:configured-chat-api',
          process: 'application',
          required: true,
          status: 'passed',
          target: url,
        }),
      ]),
    );
    expect(
      result.probes.some(
        (item) =>
          item.kind === 'version' || item.kind === 'websocket' || item.process.endsWith('-cli'),
      ),
    ).toBe(false);
  });

  it('uses exact Claude CLI transport authority for a custom Messages gateway', async () => {
    const applicationRequest = vi.fn(async () => ({
      contentType: 'application/json',
      redirects: [],
      status: 204,
    }));
    const cliRequest = vi.fn(async (url: string) => `401|${url}|0|application/json`);
    const dnsLookup = vi.fn(async () => [{ address: '203.0.113.10', family: 4 as const }]);
    const resolveProxy = vi.fn(async () => 'DIRECT');
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      cliRequest,
      dnsLookup,
      resolveProxy,
    });
    const url = 'https://gateway.example.test/tenant/v1/messages';

    const observation = await probe.run(
      'anthropic-claude',
      'cli-launch',
      'D:\\Project',
      'application',
      { process: 'claude-cli', url },
    );
    const result = new RiskDecisionEngine().evaluate(
      'anthropic-claude',
      'cli-launch',
      observation,
      1,
      2,
    );

    expect(cliRequest).toHaveBeenCalledOnce();
    expect(cliRequest).toHaveBeenCalledWith(url, false, 'D:\\Project', undefined);
    expect(resolveProxy).toHaveBeenCalledWith(url, 'application', undefined);
    expect(observation.paths).toEqual([
      expect.objectContaining({ process: 'claude-cli', target: url }),
    ]);
    expect(observation.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cli:configured-chat-api',
          process: 'claude-cli',
          required: true,
          status: 'passed',
          target: url,
        }),
        expect.objectContaining({
          id: 'app:configured-chat-api',
          process: 'application',
          required: false,
        }),
      ]),
    );
    expect(result.providerConnectivity.status).toBe('allowed');
  });

  it('fails closed when no Session-owned application request adapter is configured', async () => {
    const probe = new ProviderConnectivityProbe({
      cliRequest: async (url, websocket) =>
        websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });

    const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });

    expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
      detail: expect.stringContaining('Electron Session'),
      required: true,
      status: 'failed',
    });
  });

  it('classifies a locally generated Chinese timeout as a timeout', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new Error('连接超时。');
    });

    const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });

    expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
      detail: '连接超时。',
      required: true,
      status: 'failed',
    });
  });

  it('treats Electron manual-redirect cancellation on a known provider endpoint as reachable', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new TypeError('Redirect was cancelled');
    });

    const result = await probe.run('openai-codex', 'background');
    const applicationProbes = result.probes.filter((item) => item.id.startsWith('app:'));

    expect(applicationProbes.length).toBeGreaterThan(0);
    expect(applicationProbes.every((item) => item.status === 'warning')).toBe(true);
    expect(applicationProbes[0]?.detail).toContain('网络路径已确认可达');
  });

  it('does not use an unvalidated Electron OAuth redirect as system-browser login authority', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new TypeError('Redirect was cancelled');
    });

    const observation = await probe.run('openai-codex', 'login');
    const applicationProbes = observation.probes.filter((candidate) =>
      candidate.id.startsWith('app:'),
    );
    const result = new RiskDecisionEngine().evaluate('openai-codex', 'login', observation, 1, 2);

    expect(applicationProbes.length).toBeGreaterThan(0);
    expect(applicationProbes).toEqual(
      applicationProbes.map((candidate) =>
        expect.objectContaining({
          id: candidate.id,
          process: 'application',
          required: false,
          status: 'warning',
        }),
      ),
    );
    expect(result.providerConnectivity.status).toBe('allowed_with_notice');
    expect(result.featureAccess).toEqual([{ action: 'login', allowed: true }]);
  });

  it('still rejects a redirect cancellation from an exact configured API target', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new TypeError('Redirect was cancelled');
    });

    const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });

    expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
      detail: expect.stringContaining('未验证的重定向'),
      required: true,
      status: 'failed',
    });
  });

  it('fails a required application endpoint on HTTP 407', async () => {
    const { probe } = createProbe(undefined, async () => ({
      contentType: 'text/plain',
      redirects: [],
      status: 407,
    }));

    const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });

    expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
      detail: expect.stringContaining('HTTP 407'),
      required: true,
      status: 'failed',
    });
  });

  it('blocks a required application endpoint on HTTP 503', async () => {
    const { probe } = createProbe(undefined, async () => ({
      contentType: 'text/plain',
      redirects: [],
      status: 503,
    }));

    const observation = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });
    const endpointProbe = observation.probes.find(
      (candidate) => candidate.id === 'app:configured-chat-api',
    );
    const result = new RiskDecisionEngine().evaluate(
      'openai-api',
      'first-request',
      observation,
      1,
      2,
    );

    expect(endpointProbe).toMatchObject({
      detail: expect.stringContaining('HTTP 503'),
      required: true,
      status: 'failed',
    });
    expect(result.providerConnectivity.status).toBe('blocked');
    expect(result.featureAccess).toEqual([
      expect.objectContaining({ action: 'first-request', allowed: false }),
    ]);
  });

  it.each([401, 403, 405])(
    'keeps HTTP %i application authentication and method responses endpoint-reachable',
    async (status) => {
      const { probe } = createProbe(undefined, async () => ({
        contentType: 'application/json',
        redirects: [],
        status,
      }));

      const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      });

      expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
        required: true,
        status: 'passed',
      });
    },
  );

  it.each([401, 403])(
    'accepts protected HTTP %i HTML as authentication-edge reachability',
    async (status) => {
      const { probe } = createProbe(undefined, async () => ({
        contentType: 'text/html; charset=utf-8',
        redirects: [],
        status,
      }));

      const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      });

      expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
        detail: expect.stringContaining(`HTTP ${status}`),
        required: true,
        status: 'passed',
      });
    },
  );

  it('fails a final application redirect without a validated target', async () => {
    const { probe } = createProbe(undefined, async () => ({
      contentType: 'text/plain',
      redirects: [],
      status: 302,
    }));

    const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });

    expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
      detail: expect.stringContaining('未提供可验证的目标'),
      required: true,
      status: 'failed',
    });
  });

  it('fails a required CLI endpoint on HTTP 407', async () => {
    const { probe } = createProbe(async (url, websocket) =>
      websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `407|${url}|0|text/plain`,
    );

    const result = await probe.run('openai-codex', 'cli-launch');

    expect(result.probes.find((item) => item.id === 'cli:openai-codex-api')).toMatchObject({
      detail: expect.stringContaining('HTTP 407'),
      required: true,
      status: 'failed',
    });
  });

  it.each([401, 403, 405])(
    'keeps HTTP %i CLI authentication and method responses endpoint-reachable',
    async (status) => {
      const { probe } = createProbe(async (url, websocket) =>
        websocket
          ? `101|${url.replace(/^wss:/, 'https:')}|0|`
          : `${status}|${url}|0|application/json`,
      );

      const result = await probe.run('openai-codex', 'cli-launch');

      expect(result.probes.find((item) => item.id === 'cli:openai-codex-api')).toMatchObject({
        required: true,
        status: 'passed',
      });
    },
  );

  it('fails closed when an exact endpoint redirect cannot be inspected', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new Error('Redirect was cancelled');
    });

    const result = await probe.run('openai-api', 'first-request', undefined, 'conversation', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });

    expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
      required: true,
      status: 'failed',
    });
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

  it('treats Electron redirect cancellation as reachable without following it', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new Error('Redirect was cancelled');
    });
    const result = await probe.run('openai-codex', 'background');
    const chatgptProbe = result.probes.find((item) => item.id === 'app:openai-chatgpt');

    expect(chatgptProbe).toMatchObject({
      required: false,
      status: 'warning',
      detail: expect.stringContaining('网络路径已确认可达'),
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

  it('fails an uninspected required CLI redirect even when curl reports the original URL', async () => {
    const { probe } = createProbe(async (url, websocket) =>
      websocket ? `403|${url.replace(/^wss:/, 'https:')}|0|` : `302|${url}|0|text/html`,
    );
    const result = await probe.run('openai-codex', 'cli-launch');
    const apiProbe = result.probes.find((item) => item.id === 'cli:openai-codex-api');

    expect(apiProbe).toMatchObject({
      detail: expect.stringContaining('未跟随并验证'),
      required: true,
      status: 'failed',
    });
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

  it.each([
    [
      'mixed public and private answers',
      [
        { address: '203.0.113.10', family: 4 as const },
        { address: '10.0.0.12', family: 4 as const },
      ],
    ],
    ['an IPv4-mapped private IPv6 answer', [{ address: '::ffff:127.0.0.1', family: 6 as const }]],
    [
      'an expanded IPv4-mapped private IPv6 answer',
      [{ address: '0:0:0:0:0:ffff:7f00:1', family: 6 as const }],
    ],
  ])('flags %s as a suspicious DNS rewrite', async (_label, addresses) => {
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => ({
        contentType: 'application/json',
        redirects: [],
        status: 204,
      }),
      cliRequest: async (url) => `401|${url}|0|application/json`,
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [...addresses],
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
});
