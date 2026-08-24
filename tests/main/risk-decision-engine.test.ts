import { describe, expect, it } from 'vitest';
import type {
  NetworkPathView,
  NetworkPreflightAction,
  NetworkProbeResult,
} from '../../src/shared/contracts';
import type { ConnectivityObservation } from '../../src/main/network/provider-connectivity-probe';
import { RiskDecisionEngine } from '../../src/main/network/risk-decision-engine';

const directPath = (overrides: Partial<NetworkPathView> = {}): NetworkPathView => ({
  detail: 'Electron 主进程：直连。',
  dnsServers: ['1.1.1.1'],
  globalIpv6Available: false,
  ipv4Available: true,
  ipv6Available: false,
  networkScope: 'application',
  process: 'application',
  proxyConfigured: false,
  proxyKind: 'direct',
  target: 'https://chatgpt.com/',
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
            virtualInterfaces: ['Example virtual adapter'],
          }),
        ],
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(
      true,
    );
    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining(['proxy-present', 'virtual-interface-present']),
    );
  });

  it('blocks an incompatible client action without calling healthy provider connectivity failed', () => {
    const result = evaluate(
      'cli-launch',
      observation([
        probe('cli:openai-codex-api'),
        probe('version:openai-codex', {
          detail: '当前版本低于安全基线。',
          kind: 'version',
          process: 'codex-cli',
          status: 'failed',
        }),
      ]),
    );

    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.providerConnectivity.summary).toContain('连接正常');
    expect(result.featureAccess).toEqual([
      {
        action: 'cli-launch',
        allowed: false,
        reason: expect.stringContaining('CLI 兼容性检查未通过'),
      },
    ]);
    expect(result.providerConnectivity.signals.map((signal) => signal.id)).not.toContain(
      'probe-failed:version:openai-codex',
    );
  });

  it('degrades an action that has no required provider endpoint evidence', () => {
    const result = evaluate(
      'background',
      observation([
        probe('app:optional', {
          required: false,
          status: 'passed',
        }),
      ]),
    );

    expect(result.providerConnectivity.status).toBe('degraded');
    expect(result.featureAccess).toEqual([
      {
        action: 'background',
        allowed: false,
        reason: expect.stringContaining('没有可用的必需提供商端点证据'),
      },
    ]);
  });

  it('reports an unconfirmed global IPv6 path as a non-blocking notice', () => {
    const result = evaluate(
      'cli-launch',
      observation([probe('cli:openai-codex-api')], {
        paths: [directPath({ globalIpv6Available: true, ipv6Available: true })],
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(
      true,
    );
    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).toContain(
      'global-ipv6-path-unconfirmed',
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
    expect(optional.status).toBe('allowed_with_notice');
    expect(optional.providerConnectivity.status).toBe('allowed_with_notice');
    expect(optional.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(
      true,
    );
  });

  it('blocks required application and CLI probes that report HTTP 407', () => {
    const application = evaluate(
      'first-request',
      observation([
        probe('app:configured-chat-api', {
          detail: 'HTTP 407，代理认证未通过。',
          status: 'failed',
        }),
      ]),
    );
    const cli = evaluate(
      'cli-launch',
      observation([
        probe('cli:openai-codex-api', {
          detail: 'HTTP 407，代理认证未通过。',
          process: 'codex-cli',
          status: 'failed',
        }),
      ]),
    );

    expect(application.status).toBe('blocked');
    expect(
      application.featureAccess.find((access) => access.action === 'first-request')?.allowed,
    ).toBe(false);
    expect(cli.status).toBe('blocked');
    expect(cli.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(false);
  });

  it.each([401, 403, 405])(
    'keeps required HTTP %i authentication and method responses non-blocking once probes pass',
    (status) => {
      const application = evaluate(
        'first-request',
        observation([
          probe('app:configured-chat-api', {
            detail: `HTTP ${status}，官方端点可达。`,
            status: 'passed',
          }),
        ]),
      );
      const cli = evaluate(
        'cli-launch',
        observation([
          probe('cli:openai-codex-api', {
            detail: `HTTP ${status}，官方端点可达。`,
            process: 'codex-cli',
            status: 'passed',
          }),
        ]),
      );

      expect(application.status).not.toBe('blocked');
      expect(
        application.featureAccess.find((access) => access.action === 'first-request')?.allowed,
      ).toBe(true);
      expect(cli.status).not.toBe('blocked');
      expect(cli.featureAccess.find((access) => access.action === 'cli-launch')?.allowed).toBe(
        true,
      );
    },
  );

  it('keeps optional unauthenticated WebSocket evidence advisory and blocks required cloud tasks', () => {
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

    expect(background.status).toBe('allowed_with_notice');
    expect(background.providerConnectivity.status).toBe('allowed_with_notice');
    expect(background.featureAccess).toEqual([{ action: 'background', allowed: true }]);
    expect(cloud.status).toBe('partially_available');
    expect(cloud.providerConnectivity.status).toBe('partially_available');
    expect(cloud.featureAccess).toEqual([
      {
        action: 'cloud-task',
        allowed: false,
        reason: '云端任务所需的提供商端点能力未通过。',
      },
    ]);
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

  it('treats unknown proxy resolution with observed IPv4 as incomplete, not offline', () => {
    const result = evaluate(
      'first-request',
      observation([probe('app:openai-chatgpt')], {
        paths: [
          directPath({
            proxyKind: 'unknown',
          }),
        ],
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.summary).toContain('连接正常');
    expect(result.featureAccess).toEqual([{ action: 'first-request', allowed: true }]);
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).toContain(
      'proxy-resolution-unknown',
    );
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).not.toContain(
      'local-interface-offline',
    );
  });

  it('keeps an all-false local interface snapshot advisory when provider probes pass', () => {
    const result = evaluate(
      'first-request',
      observation([probe('app:openai-chatgpt')], {
        paths: [directPath({ ipv4Available: false, ipv6Available: false })],
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.featureAccess).toEqual([{ action: 'first-request', allowed: true }]);
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).toContain(
      'local-interface-offline',
    );
  });

  it.each([
    ['IPv4-only', { ipv4Available: true, ipv6Available: false }],
    ['IPv6-only', { ipv4Available: false, ipv6Available: true }],
  ])('does not infer offline from an observed %s host path', (_label, familyFacts) => {
    const result = evaluate(
      'first-request',
      observation([probe('app:openai-chatgpt')], {
        paths: [directPath(familyFacts)],
      }),
    );

    expect(result.featureAccess).toEqual([{ action: 'first-request', allowed: true }]);
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).not.toContain(
      'local-interface-offline',
    );
  });

  it('keeps missing path evidence advisory instead of fabricating offline state', () => {
    const result = evaluate(
      'first-request',
      observation([probe('app:openai-chatgpt')], { paths: [] }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.providerConnectivity.featureAccess).toEqual([
      { action: 'first-request', allowed: true },
    ]);
    expect(result.advisoryEvidence.riskLevel).toBe('unknown');
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).toContain(
      'path-evidence-unavailable',
    );
    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).not.toContain(
      'local-interface-offline',
    );
  });

  it('keeps incomplete environment evidence advisory when provider probes pass', () => {
    const result = evaluate(
      'background',
      observation([probe('app:openai-chatgpt')], {
        environment: {
          checkedAt: 2,
          dnsDetail: '权威 DNS 未完成。',
          dnsStatus: 'unknown',
          evidenceStatus: 'partial',
          issues: [],
          localLanguage: 'en-US',
          localTimezone: 'America/Los_Angeles',
          publicAddressObservations: [],
          riskLevel: 'unknown',
          summary: '关键证据不完整。',
        },
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.providerConnectivity.featureAccess).toEqual([
      { action: 'background', allowed: true },
    ]);
    expect(result.advisoryEvidence.riskLevel).toBe('unknown');
    expect(result.advisoryEvidence.summary).toContain('关键证据不完整');
    expect(result.summary).toContain('连接正常');
  });

  it('surfaces high environment risk without misreporting provider reachability failure', () => {
    const result = evaluate(
      'background',
      observation([probe('app:openai-chatgpt')], {
        environment: {
          checkedAt: 2,
          dnsDetail: 'DNS 出口国家不一致。',
          dnsStatus: 'review',
          evidenceStatus: 'complete',
          issues: [
            {
              detail: 'DNS 出口国家不一致。',
              kind: 'dns-egress',
              severity: 'high',
              title: 'DNS 出口国家不一致',
            },
          ],
          localLanguage: 'en-US',
          localTimezone: 'America/Los_Angeles',
          publicAddressObservations: [],
          riskLevel: 'high',
          summary: '检测到高风险。',
        },
      }),
    );

    expect(result.status).toBe('allowed_with_notice');
    expect(result.providerConnectivity.status).toBe('allowed');
    expect(result.providerConnectivity.featureAccess).toEqual([
      { action: 'background', allowed: true },
    ]);
    expect(result.advisoryEvidence.riskLevel).toBe('high');
    expect(result.advisoryEvidence.summary).toContain('检测到高风险');
    expect(result.summary).toContain('连接正常');
  });

  it('does not treat an unknown proxy path as a confirmed direct IPv6 path', () => {
    const result = evaluate(
      'first-request',
      observation([probe('app:openai-chatgpt')], {
        paths: [
          directPath({
            globalIpv6Available: true,
            ipv6Available: true,
            proxyKind: 'unknown',
          }),
        ],
      }),
    );

    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).not.toContain(
      'global-ipv6-path-unconfirmed',
    );
  });

  it('does not claim application and CLI paths differ while either proxy state is unknown', () => {
    const result = evaluate(
      'cli-launch',
      observation([probe('cli:openai-codex-api')], {
        paths: [
          directPath({ proxyKind: 'unknown' }),
          directPath({
            process: 'codex-cli',
            proxyConfigured: true,
            proxyKind: 'system',
          }),
        ],
      }),
    );

    expect(result.advisoryEvidence.signals.map((signal) => signal.id)).not.toContain(
      'process-paths-differ',
    );
  });

  it.each(['socks', 'socks5h'] as const)(
    'blocks a Claude CLI %s path because the official client cannot use the probed transport',
    (proxyKind) => {
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
              proxyKind,
            }),
          ],
        },
      );
      const result = new RiskDecisionEngine().evaluate(
        'anthropic-claude',
        'cli-launch',
        input,
        1,
        2,
      );

      expect(result.status).toBe('blocked');
      expect(result.providerConnectivity.status).toBe('blocked');
      expect(result.providerConnectivity.featureAccess).toEqual([
        {
          action: 'cli-launch',
          allowed: false,
          reason: expect.stringContaining('不能使用当前显式 SOCKS 代理'),
        },
      ]);
      expect(result.providerConnectivity.signals.map((signal) => signal.id)).toContain(
        'unsupported-cli-proxy',
      );
      expect(result.advisoryEvidence.signals.map((signal) => signal.id)).not.toContain(
        'unsupported-cli-proxy',
      );
      expect(result.providerConnectivity.summary).toContain('当前 Claude Code CLI 传输配置不可用');
    },
  );
});
