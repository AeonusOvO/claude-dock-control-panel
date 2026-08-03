import { describe, expect, it } from 'vitest';
import { NetworkPathResolver } from '../src/main/network-path-resolver';

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
});
