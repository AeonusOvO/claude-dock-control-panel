import { describe, expect, it } from 'vitest';
import type {
  NetworkPathView,
  NetworkPreflightAction,
  NetworkProbeResult,
} from '../src/shared/contracts';
import type { ConnectivityObservation } from '../src/main/provider-connectivity-probe';
import { RiskDecisionEngine } from '../src/main/risk-decision-engine';

const directPath = (overrides: Partial<NetworkPathView> = {}): NetworkPathView => ({
  detail: 'Electron 主进程：直连。',
  dnsServers: ['1.1.1.1'],
  ipv4Available: true,
  ipv6Available: false,
  process: 'application',
  proxyConfigured: false,
  proxyKind: 'direct',
  virtualInterfaces: [],
  ...overrides,
});

const probe = (id: string, overrides: Partial<NetworkProbeResult> = {}): NetworkProbeResult => ({
  checkedAt: 2,
  detail: '可达。',
  id,
  kind: 'https',
  label: id,
  process: 'application',
  required: true,
  status: 'passed',
  ...overrides,
});

const observation = (
  probes: NetworkProbeResult[],
  overrides: Partial<ConnectivityObservation> = {},
): ConnectivityObservation => ({
  egress: {
    countryCode: 'US',
    countryName: 'United States',
    ipv4: '203.0.113.0/24',
    sourceCount: 2,
    sourcesAgree: true,
    stability: 'unknown',
  },
  paths: [directPath()],
  probes,
  ...overrides,
});

const evaluate = (action: NetworkPreflightAction, input: ConnectivityObservation) =>
  new RiskDecisionEngine().evaluate('openai-codex', action, input, 1, 2);

describe('RiskDecisionEngine', () => {
  it('does not block when only the application redirect probe is inconclusive', () => {
    const result = evaluate(
      'background',
      observation([
        probe('app:openai-chatgpt', {
          detail: '应用探测器取消了重定向；这不证明网络失败。',
          status: 'warning',
        }),
      ]),
    );

    expect(result.featureAccess.find((access) => access.action === 'background')?.allowed).toBe(
      true,
    );
    expect(result.status).not.toBe('blocked');
  });

  it('does not block solely because a proxy or virtual interface exists', () => {
    const result = evaluate(
      'cli-launch',
      observation([probe('cli:openai-codex-api')], {
        paths: [
          directPath({
            proxyConfigured: true,
            proxyKind: 'environment',
            virtualInterfaces: ['WireGuard Tunnel'],
          }),
        ],
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(
      true,
    );
    expect(result.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining(['proxy-present', 'virtual-interface-present']),
    );
  });

  it('blocks only after two egress sources agree on an unsupported region', () => {
    const agreed = evaluate(
      'cli-launch',
      observation([probe('cli:openai-codex-api')], {
        egress: {
          countryCode: 'CN',
          countryName: 'China',
          ipv4: '203.0.113.0/24',
          sourceCount: 2,
          sourcesAgree: true,
          stability: 'unknown',
        },
      }),
    );
    const disputed = evaluate(
      'cli-launch',
      observation([probe('cli:openai-codex-api')], {
        egress: {
          countryCode: 'CN',
          countryName: 'China',
          ipv4: '203.0.113.0/24',
          sourceCount: 1,
          sourcesAgree: false,
          stability: 'unknown',
        },
      }),
    );

    expect(agreed.status).toBe('blocked');
    expect(disputed.status).toBe('warning');
  });

  it('treats VPN and hosting intelligence labels as notices rather than blockers', () => {
    const result = evaluate(
      'cli-launch',
      observation([probe('cli:openai-codex-api')], {
        egress: {
          countryCode: 'US',
          countryName: 'United States',
          ipv4: '203.0.113.0/24',
          riskFlags: ['VPN', '托管/数据中心'],
          sourceCount: 2,
          sources: ['source-a', 'source-b'],
          sourcesAgree: true,
          stability: 'unknown',
        },
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.signals.map((signal) => signal.id)).toContain('egress-reputation-flags');
    expect(result.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(
      true,
    );
  });

  it('blocks required TLS failures but keeps an optional process-path failure as a warning', () => {
    const required = evaluate(
      'cli-launch',
      observation([
        probe('cli:openai-codex-api', {
          detail: 'TLS 证书校验失败。',
          kind: 'tls',
          status: 'failed',
        }),
      ]),
    );
    const optional = evaluate(
      'cli-launch',
      observation([
        probe('cli:openai-codex-api'),
        probe('app:openai-codex-api', {
          detail: 'TLS 证书校验失败。',
          kind: 'tls',
          required: false,
          status: 'failed',
        }),
      ]),
    );

    expect(required.status).toBe('blocked');
    expect(optional.status).toBe('warning');
    expect(optional.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(
      true,
    );
  });

  it('reports WebSocket-only failure as partial availability and blocks cloud tasks', () => {
    const background = evaluate(
      'background',
      observation([
        probe('app:openai-chatgpt'),
        probe('cli:openai-codex-websocket', {
          detail: 'WebSocket 握手返回 HTTP 403。',
          kind: 'websocket',
          required: false,
          status: 'warning',
        }),
      ]),
    );
    const cloud = evaluate(
      'cloud-task',
      observation([
        probe('cli:openai-codex-websocket', {
          detail: 'WebSocket 握手返回 HTTP 403。',
          kind: 'websocket',
          process: 'codex-cli',
          required: true,
          status: 'warning',
        }),
      ]),
    );

    expect(background.status).toBe('partially_available');
    expect(cloud.status).toBe('blocked');
  });

  it('fails closed when a required probe is unknown', () => {
    const result = evaluate(
      'cli-launch',
      observation([
        probe('cli:openai-codex-api', {
          detail: '未完成。',
          status: 'unknown',
        }),
      ]),
    );

    expect(result.status).toBe('blocked');
  });

  it('blocks a Claude CLI SOCKS path because the official client does not support it', () => {
    const input = observation(
      [
        probe('cli:anthropic-api', {
          process: 'claude-cli',
        }),
      ],
      {
        paths: [
          directPath(),
          directPath({
            detail: 'Claude CLI via SOCKS',
            process: 'claude-cli',
            proxyConfigured: true,
            proxyKind: 'socks',
          }),
        ],
      },
    );
    const result = new RiskDecisionEngine().evaluate('anthropic-claude', 'cli-launch', input, 1, 2);

    expect(result.status).toBe('blocked');
    expect(result.signals.map((signal) => signal.id)).toContain('unsupported-cli-proxy');
  });
});
