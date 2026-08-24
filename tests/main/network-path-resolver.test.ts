import { describe, expect, it } from 'vitest';
import {
  classifyEnvironmentProxy,
  NetworkPathResolver,
  NO_PROXY_ENVIRONMENT_KEYS,
  PROXY_ENVIRONMENT_KEYS,
} from '../../src/main/network/path-resolver';
import { RiskDecisionEngine } from '../../src/main/network/risk-decision-engine';

const PROXY_TEST_KEYS = [...PROXY_ENVIRONMENT_KEYS, ...NO_PROXY_ENVIRONMENT_KEYS] as const;

const withProxyEnvironment = async (
  values: Partial<Record<(typeof PROXY_TEST_KEYS)[number], string>>,
  operation: () => Promise<void> | void,
): Promise<void> => {
  const originalEnvironment = PROXY_TEST_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of PROXY_TEST_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    await operation();
  } finally {
    for (const key of PROXY_TEST_KEYS) delete process.env[key];
    for (const [key, value] of originalEnvironment) {
      if (value !== undefined) process.env[key] = value;
    }
  }
};

describe('NetworkPathResolver', () => {
  it('labels the loopback HTTP adapter as ClaudeDock built-in proxy', async () => {
    const paths = await new NetworkPathResolver(
      async () => 'DIRECT',
      () => 'http://127.0.0.1:43123',
    ).resolve('anthropic-claude', 'https://api.anthropic.com');
    expect(paths.find(({ process }) => process === 'claude-cli')).toMatchObject({
      proxyConfigured: true,
      proxyKind: 'application-proxy',
    });
  });

  it('applies exact-target NO_PROXY before a ClaudeDock HTTP proxy', async () => {
    await withProxyEnvironment({ NO_PROXY: 'api.anthropic.com' }, async () => {
      const paths = await new NetworkPathResolver(
        async () => 'DIRECT',
        () => 'http://127.0.0.1:43123',
      ).resolve('anthropic-claude', 'https://api.anthropic.com/v1/messages');

      expect(paths.find(({ process }) => process === 'claude-cli')).toMatchObject({
        proxyConfigured: false,
        proxyKind: 'direct',
      });
      expect(paths.find(({ process }) => process === 'claude-cli')?.detail).toContain('NO_PROXY');
    });
  });

  it('does not equate a missing explicit proxy with public direct access', async () => {
    const paths = await new NetworkPathResolver(async () => 'DIRECT').resolve(
      'openai-codex',
      'https://chatgpt.com/',
    );
    const applicationPath = paths.find((path) => path.process === 'application');

    expect(applicationPath).toMatchObject({
      networkScope: 'application',
      proxyConfigured: false,
      proxyKind: 'direct',
      target: 'https://chatgpt.com/',
    });
    expect(applicationPath?.detail).toContain('TUN、透明代理或软路由');
    expect(applicationPath?.detail).not.toContain('公网直连');
  });

  it('describes an explicit proxy as the visible first hop of a possible chain', async () => {
    const paths = await new NetworkPathResolver(async () => 'PROXY 127.0.0.1:7890').resolve(
      'openai-codex',
      'https://chatgpt.com/',
    );
    const applicationPath = paths.find((path) => path.process === 'application');

    expect(applicationPath).toMatchObject({
      networkScope: 'application',
      proxyConfigured: true,
      proxyKind: 'system',
      target: 'https://chatgpt.com/',
    });
    expect(applicationPath?.detail).toContain('可见代理第一跳');
    expect(applicationPath?.detail).toContain('代理内核');
  });

  it('reports no CLI application proxy when the proxy is not scoped to the CLI', async () => {
    /*
     * `buildApplicationProxyEnvironment` only injects HTTP(S)_PROXY into the CLI when
     * `view.scope.cli` is set, so passing a URL here for an application-only proxy makes the CLI
     * diagnostics blame a proxy the CLI never used. The caller must honour the same scope gate.
     */
    const paths = await new NetworkPathResolver(
      async () => 'DIRECT',
      () => undefined,
    ).resolve('anthropic-claude', 'https://api.anthropic.com');

    expect(paths.find(({ process }) => process === 'claude-cli')).toMatchObject({
      proxyConfigured: false,
      proxyKind: 'direct',
    });
  });

  it.each([
    ['SOCKS5 with local destination DNS', 'socks5://127.0.0.1:1080', 'socks'],
    ['SOCKS5H with proxy destination DNS', 'socks5h://127.0.0.1:1080', 'socks5h'],
  ] as const)('preserves %s semantics in CLI path evidence', async (_case, proxy, proxyKind) => {
    await withProxyEnvironment({ ALL_PROXY: proxy }, async () => {
      const paths = await new NetworkPathResolver(async () => 'DIRECT').resolve(
        'openai-codex',
        'https://chatgpt.com/backend-api/codex',
      );

      expect(paths.find(({ process }) => process === 'codex-cli')).toMatchObject({
        proxyConfigured: true,
        proxyKind,
      });
    });
  });

  it('applies NO_PROXY to the exact CLI target before classifying an unsupported SOCKS path', async () => {
    await withProxyEnvironment(
      {
        ALL_PROXY: 'socks5://127.0.0.1:1080',
        NO_PROXY: 'api.anthropic.com',
      },
      async () => {
        const paths = await new NetworkPathResolver(async () => 'DIRECT').resolve(
          'anthropic-claude',
          'https://api.anthropic.com/v1/messages',
        );
        expect(paths.find(({ process }) => process === 'claude-cli')).toMatchObject({
          proxyConfigured: false,
          proxyKind: 'direct',
        });
        expect(paths.find(({ process }) => process === 'claude-cli')?.detail).toContain('NO_PROXY');

        const decision = new RiskDecisionEngine().evaluate(
          'anthropic-claude',
          'cli-launch',
          {
            paths,
            probes: [
              {
                checkedAt: 2,
                detail: 'Anthropic API 可达。',
                id: 'cli:anthropic-api',
                kind: 'api',
                label: 'Anthropic API',
                process: 'claude-cli',
                required: true,
                status: 'passed',
                target: 'https://api.anthropic.com/v1/messages',
              },
            ],
          },
          1,
          2,
        );
        expect(decision.providerConnectivity.status).toBe('allowed');
        expect(decision.featureAccess).toEqual([{ action: 'cli-launch', allowed: true }]);
      },
    );
  });

  it.each([
    ['domain suffix', '.example.com', 'https://api.example.com/v1'],
    ['explicit default port', 'api.example.com:443', 'https://api.example.com/v1'],
    ['IPv4 literal', '203.0.113.20', 'https://203.0.113.20/v1'],
    ['bracketed IPv6 literal', '[2001:db8::20]:443', 'https://[2001:db8::20]/v1'],
    ['wildcard', '*', 'https://unrelated.example/v1'],
  ])('honors NO_PROXY %s matching', async (_label, noProxy, target) => {
    await withProxyEnvironment({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: noProxy }, () => {
      expect(classifyEnvironmentProxy(undefined, target)).toEqual({
        proxyConfigured: false,
        proxyKind: 'direct',
      });
    });
  });

  it('keeps the proxy when a NO_PROXY port does not match', async () => {
    await withProxyEnvironment(
      { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'api.example.com:8443' },
      () => {
        expect(classifyEnvironmentProxy(undefined, 'https://api.example.com/v1')).toEqual({
          proxyConfigured: true,
          proxyKind: 'environment',
        });
      },
    );
  });

  it('preserves independently observed local facts when proxy lookup times out', () => {
    const localFacts = {
      dnsServers: ['192.0.2.53', '2001:db8::53'],
      globalIpv6Available: true,
      ipv4Available: true,
      ipv6Available: true,
      virtualInterfaces: ['虚拟网络接口'],
    };
    const paths = new NetworkPathResolver(
      async () => 'DIRECT',
      () => 'http://127.0.0.1:43123',
      () => localFacts,
    ).unknownPaths(
      'anthropic-claude',
      'https://api.anthropic.com/v1/messages',
      'conversation',
      'Electron 系统代理解析超时，PAC 路径未知。',
    );

    expect(paths.map(({ process }) => process)).toEqual([
      'application',
      'claude-cli',
      'terminal',
      'renderer',
    ]);
    expect(paths).toEqual(
      paths.map((path) =>
        expect.objectContaining({
          ...localFacts,
          detail: expect.stringContaining('超时'),
          networkScope: 'conversation',
          process: path.process,
          target: 'https://api.anthropic.com/v1/messages',
        }),
      ),
    );
    const pacDependentPaths = paths.filter(({ process }) =>
      ['application', 'renderer'].includes(process),
    );
    expect(
      pacDependentPaths.every(
        ({ proxyConfigured, proxyKind }) => !proxyConfigured && proxyKind === 'unknown',
      ),
    ).toBe(true);
    const cliPaths = paths.filter(({ process }) => ['claude-cli', 'terminal'].includes(process));
    expect(
      cliPaths.every(
        ({ detail, proxyConfigured, proxyKind }) =>
          detail.includes('本地配置独立判定') &&
          proxyConfigured &&
          proxyKind === 'application-proxy',
      ),
    ).toBe(true);
  });

  it('preserves an Anthropic ALL_PROXY SOCKS block when PAC resolution times out', async () => {
    await withProxyEnvironment({ ALL_PROXY: 'socks5://127.0.0.1:1080' }, () => {
      const paths = new NetworkPathResolver(
        async () => 'DIRECT',
        () => undefined,
        () => ({
          dnsServers: ['192.0.2.53'],
          globalIpv6Available: false,
          ipv4Available: true,
          ipv6Available: false,
          virtualInterfaces: [],
        }),
      ).unknownPaths(
        'anthropic-claude',
        'https://api.anthropic.com/v1/messages',
        'application',
        'Electron 系统代理解析超时，PAC 路径未知。',
      );

      expect(paths.find(({ process }) => process === 'claude-cli')).toMatchObject({
        proxyConfigured: true,
        proxyKind: 'socks',
      });
      const decision = new RiskDecisionEngine().evaluate(
        'anthropic-claude',
        'cli-launch',
        {
          paths,
          probes: [
            {
              checkedAt: 2,
              detail: 'Anthropic API 可达。',
              id: 'cli:anthropic-api',
              kind: 'api',
              label: 'Anthropic API',
              process: 'claude-cli',
              required: true,
              status: 'passed',
              target: 'https://api.anthropic.com/v1/messages',
            },
          ],
        },
        1,
        2,
      );
      expect(decision.providerConnectivity.status).toBe('blocked');
      expect(decision.providerConnectivity.signals.map(({ id }) => id)).toContain(
        'unsupported-cli-proxy',
      );
      expect(decision.advisoryEvidence.signals.map(({ id }) => id)).not.toContain(
        'unsupported-cli-proxy',
      );
      expect(decision.status).toBe('blocked');
    });
  });

  it('returns no authoritative path rows when host-local fact collection fails', async () => {
    const resolver = new NetworkPathResolver(
      async () => 'DIRECT',
      () => undefined,
      () => {
        throw new Error('local facts unavailable');
      },
    );

    await expect(
      resolver.resolve('openai-api', 'https://api.openai.com/', 'application'),
    ).resolves.toEqual([]);
    expect(
      resolver.unknownPaths(
        'openai-api',
        'https://api.openai.com/v1/models',
        'application',
        '代理解析超时。',
      ),
    ).toEqual([]);
  });
});
