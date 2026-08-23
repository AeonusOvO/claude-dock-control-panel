import { describe, expect, it } from 'vitest';
import { NetworkPathResolver, PROXY_ENVIRONMENT_KEYS } from '../../src/main/network/path-resolver';
import { RiskDecisionEngine } from '../../src/main/network/risk-decision-engine';

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

  it('does not equate a missing explicit proxy with public direct access', async () => {
    const paths = await new NetworkPathResolver(async () => 'DIRECT').resolve(
      'openai-codex',
      'https://chatgpt.com/',
    );
    const applicationPath = paths.find((path) => path.process === 'application');

    expect(applicationPath).toMatchObject({
      proxyConfigured: false,
      proxyKind: 'direct',
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
      proxyConfigured: true,
      proxyKind: 'system',
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
    ).unknownPaths('anthropic-claude', 'Electron 系统代理解析超时，PAC 路径未知。');

    expect(paths.map(({ process }) => process)).toEqual([
      'application',
      'oauth-browser',
      'claude-cli',
      'terminal',
      'renderer',
    ]);
    expect(paths).toEqual(
      paths.map((path) =>
        expect.objectContaining({
          ...localFacts,
          detail: expect.stringContaining('超时'),
          process: path.process,
        }),
      ),
    );
    const pacDependentPaths = paths.filter(({ process }) =>
      ['application', 'oauth-browser', 'renderer'].includes(process),
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

  it('preserves an Anthropic ALL_PROXY SOCKS block when PAC resolution times out', () => {
    const originalEnvironment = PROXY_ENVIRONMENT_KEYS.map(
      (key) => [key, process.env[key]] as const,
    );
    try {
      for (const key of PROXY_ENVIRONMENT_KEYS) delete process.env[key];
      process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
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
      ).unknownPaths('anthropic-claude', 'Electron 系统代理解析超时，PAC 路径未知。');

      expect(paths.find(({ process }) => process === 'claude-cli')).toMatchObject({
        proxyConfigured: true,
        proxyKind: 'socks',
      });
      const decision = new RiskDecisionEngine().evaluate(
        'anthropic-claude',
        'cli-launch',
        { paths, probes: [] },
        1,
        2,
      );
      expect(decision.signals.map(({ id }) => id)).toContain('unsupported-cli-proxy');
      expect(decision.status).toBe('blocked');
    } finally {
      for (const key of PROXY_ENVIRONMENT_KEYS) delete process.env[key];
      for (const [key, value] of originalEnvironment) {
        if (value !== undefined) process.env[key] = value;
      }
    }
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
    expect(resolver.unknownPaths('openai-api', '代理解析超时。')).toEqual([]);
  });
});
