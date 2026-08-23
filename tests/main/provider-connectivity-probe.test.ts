import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConnectivityProbe,
  type ApplicationEndpointRequest,
} from '../../src/main/network/provider-connectivity-probe';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

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
          init.method === 'GET' && init.credentials === 'omit' && init.redirect === 'follow',
      ),
    ).toBe(true);
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

  it('forwards one authoritative signal to every probe branch and removes its deadline listener', async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const applicationRequest = vi.fn(async (_url: string, _signal?: AbortSignal) => ({
      contentType: 'application/json',
      redirects: [],
      status: 204,
    }));
    const cliRequest = vi.fn(
      async (url: string, websocket: boolean, _cwd?: string, _signal?: AbortSignal) =>
        websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`,
    );
    const clientVersion = vi.fn(
      async (_provider: string, _cwd?: string, _signal?: AbortSignal) => '0.146.0',
    );
    const dnsLookup = vi.fn(async (_host: string, _signal?: AbortSignal) => [
      { address: '203.0.113.10', family: 4 as const },
    ]);
    const resolveProxy = vi.fn(
      async (_url: string, _scope: string, _signal?: AbortSignal) => 'DIRECT',
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      cliRequest,
      clientVersion,
      dnsLookup,
      resolveProxy,
    });

    await probe.run(
      'openai-codex',
      'background',
      undefined,
      'conversation',
      undefined,
      controller.signal,
    );

    expect(applicationRequest).toHaveBeenCalled();
    expect(applicationRequest.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(
      true,
    );
    expect(cliRequest).toHaveBeenCalled();
    expect(cliRequest.mock.calls.every(([, , , signal]) => signal === controller.signal)).toBe(
      true,
    );
    expect(clientVersion).not.toHaveBeenCalled();
    expect(dnsLookup).toHaveBeenCalled();
    expect(dnsLookup.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(true);
    expect(resolveProxy).toHaveBeenCalledWith(
      expect.any(String),
      'conversation',
      controller.signal,
    );
    const deadlineListener = addEventListener.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(deadlineListener).toBeDefined();
    expect(removeEventListener).toHaveBeenCalledWith('abort', deadlineListener);
  });

  it('rejects authoritative cancellation instead of converting it into a probe verdict', async () => {
    const controller = new AbortController();
    const abortError = new Error('obsolete preflight');
    let forwardedSignal: AbortSignal | undefined;
    const applicationRequest = vi.fn(
      (_url: string, signal?: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
          forwardedSignal = signal;
          if (!signal) {
            reject(new Error('authoritative signal missing'));
            return;
          }
          const rejectAbort = (): void => reject(signal.reason);
          if (signal.aborted) {
            rejectAbort();
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true });
          }
        }),
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });
    const operation = probe.run(
      'openai-api',
      'first-request',
      undefined,
      'application',
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(applicationRequest).toHaveBeenCalledOnce());
    controller.abort(abortError);

    await expect(operation).rejects.toBe(abortError);
    expect(forwardedSignal).toBe(controller.signal);
  });

  it('waits for cancellable leaf cleanup before authoritative cancellation settles', async () => {
    const controller = new AbortController();
    const abortError = new Error('obsolete preflight');
    const cleanup = deferred<void>();
    const cleanupStarted = vi.fn();
    const applicationRequest = vi.fn(
      (_url: string, signal?: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            cleanupStarted();
            void cleanup.promise.then(() => reject(signal?.reason));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });
    const operation = probe.run(
      'openai-api',
      'first-request',
      undefined,
      'application',
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
      controller.signal,
    );
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(applicationRequest).toHaveBeenCalledOnce());
    controller.abort(abortError);
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolve();

    await expect(operation).rejects.toBe(abortError);
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

  it('still rejects a redirect cancellation from an exact configured API target', async () => {
    const { probe } = createProbe(undefined, async () => {
      throw new TypeError('Redirect was cancelled');
    });

    const result = await probe.run('openai-api', 'first-request', undefined, 'application', {
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });

    expect(result.probes.find((item) => item.id === 'app:configured-chat-api')).toMatchObject({
      detail: expect.stringContaining('Redirect was cancelled'),
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
        .filter(({ process }) => ['application', 'oauth-browser', 'renderer'].includes(process))
        .every(({ proxyKind }) => proxyKind === 'unknown'),
    ).toBe(true);
    expect(
      result.paths
        .filter(({ process }) => ['codex-cli', 'terminal'].includes(process))
        .every(({ proxyKind }) => proxyKind !== 'unknown'),
    ).toBe(true);
  });
});
