import { describe, expect, it } from 'vitest';
import { settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import {
  preflightResult,
  provenancePreflightEnvironment,
} from '../helpers/renderer-preflight-fixture';

describe('renderer preflight provenance', () => {
  it('orders attributed evidence without duplicating public-address checks', async () => {
    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) =>
          preflightResult(provider, 'allowed', {
            environment: provenancePreflightEnvironment(),
            probes: [
              {
                checkedAt: 1,
                detail: 'Anthropic 端点可达。',
                id: 'cli:anthropic-api',
                kind: 'api',
                label: 'Anthropic API（CLI）',
                process: 'claude-cli',
                required: true,
                status: 'passed',
                target: 'https://api.anthropic.com/v1/messages',
              },
              {
                checkedAt: 1,
                detail: '当前 Claude CLI 版本兼容。',
                id: 'version:anthropic-claude',
                kind: 'version',
                label: 'Anthropic Claude Code 版本审计',
                process: 'claude-cli',
                required: false,
                status: 'passed',
              },
            ],
          }),
      },
      async (harness) => {
        harness.click('#settings-network-recheck');
        await settle(harness);

        expect(harness.query('#settings-network-facts').textContent).toContain(
          'Windows 首选语言（首项）：zh-CN · 仅供参考',
        );
        expect(harness.query('#settings-network-facts').textContent).toContain(
          'CLI 语言环境覆盖：en-US · 不参与系统语言对照',
        );
        expect(harness.query('#settings-network-facts').textContent).toContain(
          '参考 · 系统语言参考',
        );
        expect(harness.query('#settings-network-facts').textContent).toContain(
          '证据完整性：关键辅助证据本次已完成 · 1 项可选证据不可用 · 不影响提供商连接结论',
        );
        expect(harness.query('#settings-network-facts').textContent).toContain(
          '不可用 · STUN/WebRTC 公网地址观察',
        );
        expect(harness.query('#settings-network-facts').textContent).not.toContain(
          '未完成 · STUN/WebRTC 公网地址观察',
        );
        const provenance = [
          'IPv4 · IPQuery · 203.0.113.0/24',
          '进程：网络诊断进程',
          '范围：应用网络会话',
          '传输：curl CLI',
          '端点：https://api.ipquery.io/?format=json',
          '采集时间：',
          '新鲜度：实时',
          '置信度：中',
          '来源一致性：多源印证',
        ];
        for (const expected of provenance) {
          expect(harness.query('#settings-network-facts').textContent).toContain(expected);
        }
        expect(harness.document.querySelector('[data-network-repair="language"]')).toBeNull();

        harness.click('#network-preflight-details');
        expect(harness.query('#network-preflight-environment').textContent).toContain(
          '参考 · 系统语言参考',
        );
        const dialogEnvironment = harness.query('#network-preflight-environment');
        for (const expected of provenance) {
          expect(dialogEnvironment.textContent).toContain(expected);
        }
        const evidenceRows = [...dialogEnvironment.children].map(
          (element) => element.textContent ?? '',
        );
        const rowIndex = (needle: string): number =>
          evidenceRows.findIndex((value) => value.includes(needle));
        expect(rowIndex('IPv4 · IPQuery')).toBeLessThan(rowIndex('IPv4 · IPIP'));
        expect(rowIndex('IPv4 · IPIP')).toBeLessThan(rowIndex('IPv6 · ipify'));
        expect(rowIndex('IPv6 · ipify')).toBeLessThan(rowIndex('权威 DNS 观察'));
        expect(rowIndex('权威 DNS 观察')).toBeLessThan(rowIndex('STUN/WebRTC 公网地址观察'));
        expect(rowIndex('STUN/WebRTC 公网地址观察')).toBeLessThan(rowIndex('时区一致性'));
        expect(rowIndex('时区一致性')).toBeLessThan(rowIndex('系统语言参考'));
        expect(rowIndex('系统语言参考')).toBeLessThan(rowIndex('地址信誉'));
        expect(rowIndex('地址信誉')).toBeLessThan(rowIndex('客户端兼容性'));
        const dnsRow = evidenceRows.find((row) => row.includes('权威 DNS 观察')) ?? '';
        for (const expected of [
          '权威性：仅辅助证据',
          '进程：网络诊断进程',
          '范围：应用网络会话',
          '传输：系统 DNS 解析器',
          '目标：*.test.dnscheck.tools TXT',
          '采集时间：',
          '新鲜度：实时',
          '置信度：中',
          '来源：dnscheck.tools',
        ]) {
          expect(dnsRow).toContain(expected);
        }
        const stunRow = evidenceRows.find((row) => row.includes('STUN/WebRTC')) ?? '';
        expect(stunRow).toContain('不可用 · STUN/WebRTC 公网地址观察');
        expect(stunRow).toContain('传输：未收集');
        expect(stunRow).toContain('新鲜度：未知');
        expect(stunRow).toContain('来源：WebRTC STUN（本次未收集）');
        expect(dialogEnvironment.textContent).not.toContain('未完成 · STUN/WebRTC 公网地址观察');
        expect(evidenceRows.find((row) => row.includes('系统语言参考'))).toContain(
          '来源：Windows 首选语言 + IPQuery',
        );
        expect(evidenceRows.find((row) => row.includes('地址信誉'))).toContain(
          '来源：IPQuery + ProxyCheck',
        );
        expect(dialogEnvironment.textContent).not.toContain(
          '重复 IPQuery 行不应在富地址观察后再次渲染',
        );
        expect(dialogEnvironment.textContent).not.toContain(
          '重复 IPIP 行不应在富地址观察后再次渲染',
        );
        expect(dialogEnvironment.textContent).toContain('客户端兼容性 · 通过');
        expect(dialogEnvironment.textContent).toContain('方法：版本');
        expect(dialogEnvironment.textContent).toContain('进程：Claude CLI');
        expect(dialogEnvironment.textContent).toContain('可选证据');
        expect(dialogEnvironment.textContent).toContain('采集时间：');
        expect(harness.query('#network-preflight-probes').textContent).not.toContain('版本审计');
      },
    );
  });

  it('keeps a local IPv6-interface check distinct from an IPQuery IPv6 observation', async () => {
    const environment = provenancePreflightEnvironment();
    environment.checks = [
      {
        authority: 'advisory-only',
        checkedAt: 10,
        confidence: 'high',
        detail: '本机接口没有可路由的全局 IPv6 地址。',
        freshness: 'live',
        id: 'ipv6-public-address',
        label: 'IPv6 公网地址观察',
        networkScope: 'application',
        process: 'network-diagnostics',
        source: 'Windows 网络接口',
        status: 'passed',
        target: 'Windows network interfaces',
        transport: 'local-system',
      },
    ];
    environment.publicAddressObservations = [
      {
        addressFamily: 'ipv6',
        addressPrefix: '2001:db8:1234:5678::/64',
        checkedAt: 11,
        confidence: 'medium',
        detail: 'IPQuery 目标观察到 IPv6 地址族。',
        endpoint: 'https://api.ipquery.io/?format=json',
        freshness: 'live',
        networkScope: 'application',
        observationProvider: 'IPQuery',
        process: 'network-diagnostics',
        sourceAgreement: 'single-source',
        state: 'complete',
        statement: '该结果不代表提供商端点。',
        transport: 'curl-cli',
      },
    ];

    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) =>
          preflightResult(provider, 'allowed', { environment }),
      },
      async (harness) => {
        harness.click('#settings-network-recheck');
        await settle(harness);

        const facts = harness.query('#settings-network-facts').textContent ?? '';
        expect(facts).toContain('IPv6 · IPQuery · 2001:db8:1234:5678::/64');
        expect(facts).toContain('IPv6 公网地址观察');
        expect(facts).toContain('目标：Windows network interfaces');
        expect(facts).toContain('传输：本机系统状态');
      },
    );
  });

  it('omits a fabricated address-family label and identifies cached observations', async () => {
    const environment = provenancePreflightEnvironment();
    environment.checks = [];
    environment.publicAddressObservations = [
      {
        checkedAt: 123,
        confidence: 'unknown',
        detail: 'api.ipquery.io 公网地址观察不可用。',
        endpoint: 'https://api.ipquery.io/?format=json',
        freshness: 'cached',
        networkScope: 'application',
        observationProvider: 'IPQuery',
        process: 'network-diagnostics',
        sourceAgreement: 'not-comparable',
        state: 'unavailable',
        statement: '该结果只描述此观察端点，不代表提供商端点。',
        transport: 'curl-cli',
      },
    ];

    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) =>
          preflightResult(provider, 'allowed', { environment }),
      },
      async (harness) => {
        harness.click('#settings-network-recheck');
        await settle(harness);

        const facts = harness.query('#settings-network-facts').textContent ?? '';
        expect(facts).toContain('IPQuery · 地址未知');
        expect(facts).toContain('新鲜度：缓存');
        expect(facts).not.toContain('新鲜度：缓存/派生');
        expect(facts).not.toContain('IPv4 · IPQuery');
        expect(facts).not.toContain('IPv6 · IPQuery');
      },
    );
  });
});
