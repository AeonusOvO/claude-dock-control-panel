import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeProjectState,
  ControlPanelApi,
  NetworkPreflightResult,
  NetworkProviderId,
  NetworkProviderConnectivityStatus,
} from '../../src/shared/contracts';
import { createRendererHarness } from '../helpers/renderer-harness';
import {
  change,
  input,
  settle,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import {
  gatewayClaudeState,
  preflightResult,
  proxyState,
  readyCodexState,
  stalePreflightEnvironment,
} from '../helpers/renderer-preflight-fixture';

describe('renderer preflight feature', () => {
  it.each<{
    label?: string;
    name: string;
    overrides: Partial<ControlPanelApi>;
    provider?: NetworkProviderId;
  }>([
    { name: 'official Claude', overrides: {}, provider: 'anthropic-claude' },
    {
      name: 'custom gateway',
      overrides: { getClaudeProjectState: async () => gatewayClaudeState() },
      label: '自定义网关',
    },
    {
      name: 'unloaded configuration',
      overrides: { getClaudeProjectState: () => new Promise<ClaudeProjectState>(() => undefined) },
    },
    {
      name: 'Codex',
      overrides: {
        getCodexProjectState: async () => readyCodexState(),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
      },
      provider: 'openai-codex',
    },
  ])('selects the preflight provider for $name', async ({ overrides, provider, label }) => {
    await withTerminalRenderer(
      {
        ...overrides,
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        if (provider) {
          expect(harness.method('runNetworkPreflight')).toHaveBeenCalledWith({
            action: 'background',
            force: false,
            provider,
          });
        } else {
          expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
        }
        if (label) expect(harness.query('#network-preflight-provider').textContent).toBe(label);
      },
    );
  });

  it('runs every manual entry point without a selected official provider or active session', async () => {
    await withTerminalRenderer(
      {
        getClaudeProjectState: async () => gatewayClaudeState(),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        harness.clearCalls();

        harness.click('#network-preflight-trigger');
        await settle(harness);
        expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(true);
        expect(harness.method('runNetworkPreflight')).toHaveBeenLastCalledWith({
          action: 'background',
          force: true,
          provider: 'ai-services',
        });
        expect(harness.query('#network-preflight-provider').textContent).toBe('独立网络预检');

        harness.clearCalls();
        harness.click('#settings-network-recheck');
        await settle(harness);
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledWith({
          action: 'background',
          force: true,
          provider: 'ai-services',
        });

        harness.clearCalls();
        harness.click('#network-preflight-dialog-recheck');
        await settle(harness);
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledWith({
          action: 'background',
          force: true,
          provider: 'ai-services',
        });
      },
    );
  });

  it('labels an OpenAI API dialog recheck with the exact provider', async () => {
    const runNetworkPreflight = vi
      .fn()
      .mockResolvedValueOnce(preflightResult('anthropic-claude', 'allowed'))
      .mockImplementationOnce(() => new Promise<NetworkPreflightResult>(() => undefined));

    await withTerminalRenderer({ runNetworkPreflight }, async (harness) => {
      harness.emit(
        'onNetworkPreflight',
        preflightResult('openai-api', 'blocked', {
          generation: 2,
          mainRunId: 200,
          summary: 'OpenAI API endpoint blocked',
        }),
      );
      expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(true);

      harness.click('#network-preflight-dialog-recheck');

      expect(runNetworkPreflight).toHaveBeenLastCalledWith({
        action: 'background',
        force: true,
        provider: 'openai-api',
      });
      expect(harness.query('#network-preflight-dialog-meta').textContent).toContain('OpenAI API');
      expect(harness.query('#network-preflight-dialog-meta').textContent).not.toContain(
        'Anthropic Claude Code',
      );
    });
  });

  it('renders an open manual dialog pending immediately and keeps ownership across unrelated events', async () => {
    let resolveManual: ((result: NetworkPreflightResult) => void) | undefined;
    const manual = new Promise<NetworkPreflightResult>((resolve) => {
      resolveManual = resolve;
    });
    const runNetworkPreflight = vi
      .fn()
      .mockResolvedValueOnce(
        preflightResult('anthropic-claude', 'allowed', {
          environment: stalePreflightEnvironment(),
          summary: 'active provider ready',
        }),
      )
      .mockImplementationOnce(() => manual);

    await withTerminalRenderer({ runNetworkPreflight }, async (harness) => {
      harness.click('#network-preflight-trigger');

      expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(true);
      expect(harness.query('.network-preflight-dialog__summary').dataset.tone).toBe('pending');
      expect(harness.query('.network-preflight-dialog__summary').getAttribute('aria-live')).toBe(
        'polite',
      );
      expect(harness.query('#settings-network-status').getAttribute('aria-live')).toBe('polite');
      expect(harness.query('#network-preflight-dialog-summary').textContent).toBe(
        '正在进行网络预检…',
      );
      expect(harness.query('#network-preflight-dialog-meta').textContent).toContain(
        'AI 服务综合预检 · 后台无额度预检',
      );
      expect(harness.query('#network-preflight-probes').textContent).toContain(
        '正在检查当前提供商',
      );
      expect(harness.query('#network-preflight-paths').textContent).toContain('正在解析当前目标');
      expect(harness.query('#network-preflight-environment').textContent).toContain(
        '正在收集目标限定',
      );
      expect(harness.query('#settings-network-facts').textContent).toContain('旧结果已暂时隐藏');
      expect(harness.query('#settings-network-facts').textContent).not.toContain(
        'stale environment summary',
      );
      expect(harness.query('#settings-network-issues').textContent).not.toContain(
        'stale repair action',
      );
      expect(harness.document.querySelector('[data-network-repair="timezone"]')).toBeNull();
      for (const selector of [
        '#network-preflight-trigger',
        '#network-preflight-recheck',
        '#network-preflight-dialog-recheck',
        '#settings-network-recheck',
      ]) {
        const button = harness.query<HTMLButtonElement>(selector);
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.textContent).toContain('正在进行网络预检…');
      }

      harness.emit(
        'onNetworkPreflight',
        preflightResult('openai-codex', 'blocked', { summary: 'inactive blocked result' }),
      );
      expect(harness.query('#network-preflight-dialog-summary').textContent).toBe(
        '正在进行网络预检…',
      );
      expect(harness.query('#settings-network-summary').textContent).toBe('正在进行网络预检…');

      resolveManual?.(
        preflightResult('ai-services', 'allowed', { summary: 'manual suite complete' }),
      );
      await settle(harness);

      expect(harness.query('#network-preflight-dialog-summary').textContent).toBe(
        'manual suite complete',
      );
      expect(harness.query('#network-preflight-trigger').getAttribute('aria-busy')).toBe('false');
      expect(harness.query('#network-preflight-recheck').textContent).toContain('重新检测');
      expect(harness.query('#network-preflight-dialog-recheck').textContent).toContain(
        '立即重新检测',
      );
    });
  });

  it('reconciles a manual dialog when an authoritative environment refresh supersedes it', async () => {
    let resolveManual: ((result: NetworkPreflightResult) => void) | undefined;
    const manual = new Promise<NetworkPreflightResult>((resolve) => {
      resolveManual = resolve;
    });
    const runNetworkPreflight = vi
      .fn()
      .mockResolvedValueOnce(
        preflightResult('anthropic-claude', 'allowed', { summary: 'initial active result' }),
      )
      .mockImplementationOnce(() => manual)
      .mockResolvedValueOnce(
        preflightResult('anthropic-claude', 'allowed', { summary: 'replacement active result' }),
      );

    await withTerminalRenderer(
      {
        invalidateNetworkPreflight: async () => undefined,
        runNetworkPreflight,
      },
      async (harness) => {
        harness.click('#network-preflight-trigger');
        expect(harness.query('#network-preflight-dialog-summary').textContent).toBe(
          '正在进行网络预检…',
        );

        window.dispatchEvent(new Event('online'));
        await settle(harness);

        expect(harness.method('invalidateNetworkPreflight')).toHaveBeenCalledWith(
          'network-environment-changed',
        );
        expect(runNetworkPreflight).toHaveBeenCalledTimes(3);
        expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(true);
        expect(harness.query('#network-preflight-dialog-summary').textContent).toBe('尚无探测结果');
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'replacement active result',
        );
        expect(harness.query('#network-preflight-trigger').getAttribute('aria-busy')).toBe('false');

        resolveManual?.(
          preflightResult('ai-services', 'allowed', { summary: 'superseded manual result' }),
        );
        await settle(harness);

        expect(harness.query('#network-preflight-dialog-summary').textContent).toBe('尚无探测结果');
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'replacement active result',
        );
      },
    );
  });

  it('restores only the owning manual operation after cancellation', async () => {
    let rejectManual: ((error: Error) => void) | undefined;
    const manual = new Promise<NetworkPreflightResult>((_resolve, reject) => {
      rejectManual = reject;
    });
    const runNetworkPreflight = vi
      .fn()
      .mockResolvedValueOnce(preflightResult('anthropic-claude', 'allowed'))
      .mockImplementationOnce(() => manual);

    await withTerminalRenderer({ runNetworkPreflight }, async (harness) => {
      harness.click('#network-preflight-trigger');
      expect(harness.query('#network-preflight-trigger').getAttribute('aria-busy')).toBe('true');

      rejectManual?.(new DOMException('manual preflight cancelled', 'AbortError'));
      await settle(harness);

      for (const selector of [
        '#network-preflight-trigger',
        '#network-preflight-recheck',
        '#network-preflight-dialog-recheck',
        '#settings-network-recheck',
      ]) {
        const button = harness.query<HTMLButtonElement>(selector);
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
      }
      expect(harness.query('#network-preflight-dialog-summary').textContent).toBe('尚无探测结果');
      expect(harness.query('#toast').textContent).toContain('操作失败');
    });
  });

  it('maps every provider-connectivity status to the card tone and Codex footer label', async () => {
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => readyCodexState(),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        const cases: Array<[NetworkProviderConnectivityStatus, string, string]> = [
          ['allowed', 'success', '连接正常'],
          ['allowed_with_notice', 'success', '连接正常'],
          ['blocked', 'error', '提供商连接未通过'],
          ['degraded', 'warning', '连接证据不完整'],
          ['partially_available', 'warning', '部分连接能力不可用'],
          ['testing', 'pending', '正在进行网络预检…'],
          ['unknown', 'warning', '连接状态未知'],
          ['warning', 'warning', '连接可用 · 有端点说明'],
        ];

        for (const [status, tone, label] of cases) {
          harness.emit('onNetworkPreflight', preflightResult('openai-codex', status));
          expect(harness.query('#network-preflight-card').getAttribute('data-tone')).toBe(tone);
          expect(harness.query('#footer-connection').getAttribute('data-tone')).toBe(tone);
          expect(harness.query('#footer-connection-label').textContent).toBe(label);
        }
      },
    );
  });

  it('keeps the provider card scoped to ordered background application results', async () => {
    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        const current = preflightResult('anthropic-claude', 'allowed', {
          generation: 2,
          mainRunId: 20,
          summary: 'current background result',
        });
        harness.emit('onNetworkPreflight', current);
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'current background result',
        );

        for (const unrelated of [
          preflightResult('anthropic-claude', 'blocked', {
            action: 'first-request',
            canonicalCwd: 'D:\\Project',
            generation: 99,
            mainRunId: 99,
            networkScope: 'conversation',
            summary: 'conversation launch result',
          }),
          preflightResult('anthropic-claude', 'blocked', {
            action: 'cli-launch',
            canonicalCwd: 'D:\\Project',
            generation: 99,
            mainRunId: 100,
            summary: 'project launch result',
          }),
        ]) {
          harness.emit('onNetworkPreflight', unrelated);
        }
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'current background result',
        );

        harness.emit(
          'onNetworkPreflight',
          preflightResult('anthropic-claude', 'blocked', {
            generation: 1,
            mainRunId: 999,
            summary: 'older generation',
          }),
        );
        harness.emit(
          'onNetworkPreflight',
          preflightResult('anthropic-claude', 'blocked', {
            generation: 2,
            mainRunId: 19,
            summary: 'older run',
          }),
        );
        harness.emit(
          'onNetworkPreflight',
          preflightResult('anthropic-claude', 'testing', {
            generation: 2,
            mainRunId: 20,
            summary: 'late testing duplicate',
          }),
        );
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'current background result',
        );

        const testing = preflightResult('anthropic-claude', 'testing', {
          generation: 2,
          mainRunId: 21,
          summary: 'new testing result',
        });
        harness.emit('onNetworkPreflight', testing);
        expect(harness.query('#network-preflight-summary').textContent).toBe('new testing result');

        const final = preflightResult('anthropic-claude', 'allowed', {
          generation: 2,
          mainRunId: 21,
          summary: 'new final result',
        });
        harness.emit('onNetworkPreflight', final);
        harness.emit(
          'onNetworkPreflight',
          preflightResult('anthropic-claude', 'blocked', {
            generation: 2,
            mainRunId: 21,
            summary: 'duplicate final must be ignored',
          }),
        );
        expect(harness.query('#network-preflight-summary').textContent).toBe('new final result');
      },
    );
  });

  it('renders empty and populated dialog details with path and probe status fallbacks', async () => {
    await withTerminalRenderer(
      {
        getClaudeProjectState: async () => gatewayClaudeState(),
      },
      async (harness) => {
        harness.click('#network-preflight-details');
        expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(true);
        expect(harness.query('#network-preflight-dialog-summary').textContent).toBe('尚无探测结果');
        expect(harness.query('#network-preflight-reasons').textContent).toContain(
          '点击“立即重新检测”执行网络检查。',
        );
        expect(harness.query('#network-preflight-paths').textContent).toContain(
          '尚未解析进程网络路径。',
        );
      },
    );

    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        harness.emit(
          'onNetworkPreflight',
          preflightResult('ai-services', 'warning', {
            advisoryEvidence: {
              reasons: ['synthetic advisory-only reason', 'synthetic risk reason'],
              signals: [
                {
                  confidence: 'medium',
                  detail: 'synthetic advisory signal detail',
                  id: 'advisory-signal',
                  label: 'Synthetic advisory signal',
                  observedAt: 1,
                  score: 10,
                  severity: 'notice',
                  source: 'synthetic advisory collector',
                },
              ],
            },
            paths: [
              {
                detail: 'Electron 主进程：代理连接。',
                dnsServers: ['192.0.2.10'],
                globalIpv6Available: false,
                ipv4Available: true,
                ipv6Available: false,
                networkScope: 'application',
                process: 'application',
                proxyConfigured: true,
                proxyKind: 'application-proxy',
                target: 'https://api.openai.com/v1/models',
                virtualInterfaces: ['Synthetic Tunnel'],
              },
              {
                detail: '系统浏览器 OAuth：代理解析超时。',
                dnsServers: ['192.0.2.10'],
                globalIpv6Available: false,
                ipv4Available: true,
                ipv6Available: false,
                networkScope: 'application',
                process: 'oauth-browser',
                proxyConfigured: false,
                proxyKind: 'unknown',
                target: 'https://auth.openai.com/',
                virtualInterfaces: [],
              },
            ],
            probes: [
              {
                checkedAt: 1,
                detail: 'synthetic passed detail',
                id: 'passed',
                kind: 'https',
                label: 'HTTPS 探测',
                process: 'application',
                required: true,
                status: 'passed',
                target: 'https://api.openai.com/v1/models',
              },
              {
                checkedAt: 1,
                detail: 'synthetic skipped detail',
                id: 'skipped',
                kind: 'oauth',
                label: 'OAuth 探测',
                process: 'oauth-browser',
                required: false,
                status: 'skipped',
                target: 'https://auth.openai.com/',
              },
            ],
            providerConnectivity: {
              signals: [
                {
                  confidence: 'high',
                  detail: 'synthetic provider signal detail',
                  id: 'provider-signal',
                  label: 'Synthetic provider signal',
                  observedAt: 1,
                  score: 90,
                  severity: 'critical',
                  source: 'synthetic provider collector',
                },
              ],
            },
            reasons: ['synthetic risk reason'],
            summary: 'synthetic warning details',
          }),
        );
        harness.click('#network-preflight-details');

        expect(harness.query('#network-preflight-dialog-summary').textContent).toBe(
          'synthetic warning details',
        );
        const reasons = [...harness.document.querySelectorAll('#network-preflight-reasons li')].map(
          (item) => item.textContent ?? '',
        );
        expect(reasons).toEqual(
          expect.arrayContaining(['synthetic risk reason', 'synthetic advisory-only reason']),
        );
        expect(reasons.join(' ')).toContain(
          '提供商信号 · Synthetic provider signal · 严重度：critical · 来源：synthetic provider collector',
        );
        expect(reasons.join(' ')).toContain('采集时间：');
        expect(reasons.join(' ')).toContain('置信度：高');
        expect(reasons.join(' ')).toContain(
          '辅助信号 · Synthetic advisory signal · 严重度：notice · 来源：synthetic advisory collector',
        );
        expect(harness.query('#network-preflight-paths').textContent).toContain(
          '目标：https://api.openai.com/v1/models；范围：应用网络会话',
        );
        expect(harness.query('#network-preflight-paths').textContent).toContain(
          '可见代理第一跳：application-proxy',
        );
        expect(harness.query('#network-preflight-paths').textContent).toContain(
          '虚拟接口：Synthetic Tunnel',
        );
        expect(harness.query('#network-preflight-paths').textContent).toContain(
          '显式代理解析未完成',
        );
        expect(harness.query('#network-preflight-paths').textContent).not.toContain(
          '未发现本机显式代理',
        );
        const probes = harness.query('#network-preflight-probes').textContent;
        for (const evidence of [
          '通过HTTPS 探测',
          '方法：HTTPS',
          '进程：Electron 应用',
          '必需提供商证据',
          '目标：https://api.openai.com/v1/models',
          '采集时间：',
          'synthetic passed detail',
          '已跳过OAuth 探测',
          '方法：OAuth',
          '进程：OAuth 浏览器',
          '可选证据',
          '目标：https://auth.openai.com/',
          'synthetic skipped detail',
        ]) {
          expect(probes).toContain(evidence);
        }
      },
    );
  });

  it('keeps a blocked provider summary primary when advisory environment evidence is low risk', async () => {
    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) =>
          preflightResult(provider, 'blocked', {
            environment: {
              checkedAt: 1,
              dnsDetail: '辅助 DNS 观察未发现已知风险。',
              dnsStatus: 'consistent',
              evidenceStatus: 'complete',
              issues: [],
              localLanguage: 'zh-CN',
              localTimezone: 'Asia/Shanghai',
              publicAddressObservations: [],
              riskLevel: 'low',
              summary: '辅助公网地址与环境观察未发现已知风险。',
            },
            summary: 'Anthropic 必需端点连接失败。',
          }),
      },
      async (harness) => {
        await settle(harness);

        expect(harness.query('#settings-network-status').dataset.tone).toBe('error');
        expect(harness.query('#settings-network-summary').textContent).toBe(
          'Anthropic 必需端点连接失败。',
        );
        expect(harness.query('#settings-network-facts').textContent).toContain(
          '辅助证据摘要：辅助公网地址与环境观察未发现已知风险。',
        );
      },
    );
  });

  it('never lets high-risk advisory copy imply that a blocked provider passed', async () => {
    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) =>
          preflightResult(provider, 'blocked', {
            environment: {
              checkedAt: 1,
              dnsDetail: '辅助 DNS 观察需要审阅。',
              dnsStatus: 'review',
              evidenceStatus: 'complete',
              issues: [
                {
                  detail: 'synthetic advisory issue',
                  kind: 'dns-egress',
                  severity: 'high',
                  title: '辅助 DNS 风险',
                },
              ],
              localLanguage: 'zh-CN',
              localTimezone: 'Asia/Shanghai',
              publicAddressObservations: [],
              riskLevel: 'high',
              summary:
                '目标限定的公网地址、DNS 或环境辅助证据包含高风险信号；这些信号只供单独审阅，不授予或拒绝提供商访问。',
            },
            summary: 'Anthropic 必需端点连接失败。',
          }),
      },
      async (harness) => {
        await settle(harness);

        expect(harness.query('#settings-network-summary').textContent).toBe(
          'Anthropic 必需端点连接失败。',
        );
        expect(harness.query('#settings-network-facts').textContent).toContain(
          '不授予或拒绝提供商访问',
        );
        expect(harness.query('#settings-network-status').textContent).not.toContain(
          '已通过的提供商端点连接结论',
        );
      },
    );
  });

  it('lets a manual suite check immediately supersede an automatic check', async () => {
    let resolveAutomatic: ((result: NetworkPreflightResult) => void) | undefined;
    let resolveManual: ((result: NetworkPreflightResult) => void) | undefined;
    const automatic = new Promise<NetworkPreflightResult>((resolve) => {
      resolveAutomatic = resolve;
    });
    const manual = new Promise<NetworkPreflightResult>((resolve) => {
      resolveManual = resolve;
    });
    const runNetworkPreflight = vi
      .fn()
      .mockImplementationOnce(() => automatic)
      .mockImplementationOnce(() => manual);

    await withTerminalRenderer(
      {
        runNetworkPreflight,
      },
      async (harness) => {
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledOnce();
        expect(harness.query<HTMLButtonElement>('#network-preflight-trigger').disabled).toBe(false);
        expect(harness.query('#network-preflight-trigger').getAttribute('aria-busy')).toBe('true');
        expect(harness.query('#network-preflight-summary').textContent).toBe('正在进行网络预检…');
        expect(harness.query('#network-preflight-recheck').textContent).toContain(
          '正在进行网络预检…',
        );
        expect(harness.query<HTMLButtonElement>('#network-preflight-recheck').disabled).toBe(false);
        expect(harness.query<HTMLButtonElement>('#network-preflight-dialog-recheck').disabled).toBe(
          false,
        );

        harness.click('#network-preflight-recheck');
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledTimes(2);
        expect(harness.method('runNetworkPreflight')).toHaveBeenLastCalledWith({
          action: 'background',
          force: true,
          provider: 'ai-services',
        });
        expect(harness.query<HTMLButtonElement>('#network-preflight-recheck').disabled).toBe(true);
        expect(harness.query('#settings-network-recheck').getAttribute('aria-busy')).toBe('true');
        harness.click('#network-preflight-dialog-recheck');
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledTimes(2);

        resolveAutomatic?.(preflightResult('anthropic-claude', 'allowed'));
        await settle(harness);
        expect(harness.query<HTMLButtonElement>('#network-preflight-recheck').disabled).toBe(true);
        expect(harness.query('#network-preflight-summary').textContent).toBe('正在进行网络预检…');
        expect(harness.query('#network-preflight-trigger').getAttribute('aria-busy')).toBe('true');

        resolveManual?.(preflightResult('ai-services', 'allowed'));
        await settle(harness);
        expect(harness.query<HTMLButtonElement>('#network-preflight-trigger').disabled).toBe(false);
        expect(harness.query('#network-preflight-trigger').getAttribute('aria-busy')).toBe('false');
        expect(harness.query('#network-preflight-trigger').textContent).toContain('网络预检');
        expect(harness.query<HTMLButtonElement>('#network-preflight-recheck').disabled).toBe(false);
        expect(harness.query('#network-preflight-recheck').textContent).toContain('重新检测');
        expect(harness.query<HTMLButtonElement>('#network-preflight-dialog-recheck').disabled).toBe(
          false,
        );
      },
    );
  });

  it('runs the newest invalidation request after superseded work and clears stale testing state', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const first = new Promise<NetworkPreflightResult>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const runNetworkPreflight = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(
        preflightResult('anthropic-claude', 'allowed', {
          generation: 1,
          mainRunId: 52,
          summary: 'replacement result',
        }),
      );

    await withTerminalRenderer(
      {
        invalidateNetworkPreflight: async () => undefined,
        runNetworkPreflight,
      },
      async (harness) => {
        harness.emit(
          'onNetworkPreflight',
          preflightResult('anthropic-claude', 'testing', {
            generation: 0,
            mainRunId: 51,
            summary: 'stale testing result',
          }),
        );
        expect(harness.query('#network-preflight-summary').textContent).toBe('正在进行网络预检…');

        window.dispatchEvent(new Event('online'));
        await settle(harness);
        expect(harness.method('invalidateNetworkPreflight')).toHaveBeenCalledWith(
          'network-environment-changed',
        );
        expect(harness.query('#network-preflight-summary').textContent).not.toBe(
          'stale testing result',
        );

        rejectFirst?.(new Error('网络预检已被更新的检查取代'));
        await settle(harness);
        expect(runNetworkPreflight).toHaveBeenCalledTimes(2);
        expect(runNetworkPreflight).toHaveBeenLastCalledWith({
          action: 'background',
          force: true,
          provider: 'anthropic-claude',
        });
        expect(harness.query('#network-preflight-summary').textContent).toBe('replacement result');
        expect(harness.query<HTMLButtonElement>('#network-preflight-recheck').disabled).toBe(false);
      },
    );
  });

  it('refreshes an active result and opens inactive blocked-provider diagnostics', async () => {
    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        harness.emit(
          'onNetworkPreflight',
          preflightResult('anthropic-claude', 'warning', {
            summary: 'active Claude warning',
          }),
        );
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'active Claude warning',
        );
        expect(harness.query('#settings-network-summary').textContent).toBe(
          'active Claude warning',
        );

        harness.emit(
          'onNetworkPreflight',
          preflightResult('openai-codex', 'blocked', {
            summary: 'inactive Codex blocked',
          }),
        );
        expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(true);
        expect(harness.query('#network-preflight-dialog-summary').textContent).toBe(
          'inactive Codex blocked',
        );
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'active Claude warning',
        );
        expect(harness.query('#settings-network-summary').textContent).toBe(
          'active Claude warning',
        );
      },
    );
  });

  it('gates Codex only for an exact blocked result and releases it after recovery', async () => {
    await withTerminalRenderer(
      {
        getCodexProjectState: async () => readyCodexState(),
        getDevelopmentRuntime: async (sessionId) => ({
          cwd: 'D:\\Project',
          runtime: 'codex',
          sessionId,
        }),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        harness.emit('onNetworkPreflight', preflightResult('openai-codex', 'warning'));
        expect(harness.query<HTMLButtonElement>('#run-claude').disabled).toBe(false);
        expect(harness.query<HTMLButtonElement>('#codex-primary-action').disabled).toBe(false);

        harness.emit('onNetworkPreflight', preflightResult('openai-codex', 'blocked'));
        expect(harness.query<HTMLButtonElement>('#run-claude').disabled).toBe(true);
        expect(harness.query<HTMLButtonElement>('#codex-primary-action').disabled).toBe(true);

        harness.emit('onNetworkPreflight', preflightResult('openai-codex', 'allowed'));
        expect(harness.query<HTMLButtonElement>('#run-claude').disabled).toBe(false);
        expect(harness.query<HTMLButtonElement>('#codex-primary-action').disabled).toBe(false);
      },
    );
  });

  it('clears persisted history without dropping the current in-memory result on success or failure', async () => {
    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        harness.emit(
          'onNetworkPreflight',
          preflightResult('anthropic-claude', 'warning', {
            summary: 'current in-memory result',
          }),
        );
        harness.method('clearNetworkPreflightHistory').mockResolvedValueOnce({
          entries: [],
          retentionDays: 7,
        });
        harness.click('#network-preflight-clear-history');
        await settle(harness);
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'current in-memory result',
        );
        expect(harness.query<HTMLButtonElement>('#network-preflight-clear-history').disabled).toBe(
          false,
        );

        harness
          .method('clearNetworkPreflightHistory')
          .mockRejectedValueOnce(new Error('synthetic clear failure'));
        harness.click('#network-preflight-clear-history');
        await settle(harness);
        expect(harness.query('#network-preflight-summary').textContent).toBe(
          'current in-memory result',
        );
        expect(harness.query('#toast').textContent).toContain('无法清除网络诊断历史');
        expect(harness.query<HTMLButtonElement>('#network-preflight-clear-history').disabled).toBe(
          false,
        );
      },
    );
  });

  it('refreshes after proxy saves and uses exact runtime and network invalidation reasons', async () => {
    const applicationProxy = proxyState();
    await withTerminalRenderer(
      {
        getApplicationProxyState: async () => applicationProxy,
        getCodexProjectState: async () => readyCodexState(),
        invalidateNetworkPreflight: async () => undefined,
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
        saveApplicationProxy: async () => applicationProxy,
        setNextDevelopmentRuntime: async (runtime) => runtime,
      },
      async (harness) => {
        harness.click('#open-connection-advanced');
        await settle(harness);
        harness.clearCalls();
        input(harness.query('#application-proxy-host'), 'changed.example.test');
        harness.click('#application-proxy-save');
        await settle(harness);
        expect(harness.method('invalidateNetworkPreflight')).not.toHaveBeenCalled();
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledWith({
          action: 'background',
          force: true,
          provider: 'anthropic-claude',
        });

        harness.clearCalls();
        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);
        await settle(harness);
        expect(harness.method('setNextDevelopmentRuntime')).toHaveBeenCalledWith('codex');
        expect(harness.method('invalidateNetworkPreflight')).not.toHaveBeenCalled();

        harness.clearCalls();
        harness.dom.window.dispatchEvent(new harness.dom.window.Event('online'));
        await settle(harness);
        expect(harness.method('invalidateNetworkPreflight')).toHaveBeenCalledWith(
          'network-environment-changed',
        );
      },
    );
  });

  it('does not invalidate admitted launches when only network quality estimates change', async () => {
    const connection = {
      addEventListener: vi.fn(),
      downlink: 10,
      effectiveType: '4g',
      removeEventListener: vi.fn(),
      rtt: 100,
      type: 'wifi',
    };
    const harness = await createRendererHarness(
      {},
      {
        prepareDom: (dom) => {
          Object.defineProperty(dom.window.navigator, 'connection', { value: connection });
        },
      },
    );
    try {
      await settle(harness);
      harness.clearCalls();
      const changed = connection.addEventListener.mock.calls[0]?.[1] as () => void;
      for (let index = 0; index < 10; index += 1) {
        connection.rtt += 25;
        connection.downlink -= 0.1;
        connection.effectiveType = index % 2 === 0 ? '3g' : '4g';
        changed();
      }
      await settle(harness);
      expect(harness.method('invalidateNetworkPreflight')).not.toHaveBeenCalled();
      expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();

      connection.type = 'ethernet';
      changed();
      await settle(harness);
      expect(harness.method('invalidateNetworkPreflight')).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });

  it('disposes the IPC, DOM, visibility, window, and network-information listeners', async () => {
    const connection = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const harness = await createRendererHarness(
      {},
      {
        prepareDom: (dom) => {
          Object.defineProperty(dom.window.navigator, 'connection', {
            configurable: true,
            value: connection,
          });
        },
      },
    );
    try {
      expect(connection.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
      const connectionListener = connection.addEventListener.mock.calls[0]?.[1];
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('beforeunload'));
      expect(connection.removeEventListener).toHaveBeenCalledWith('change', connectionListener);

      harness.clearCalls();
      harness.emit('onNetworkPreflight', preflightResult('openai-codex', 'blocked'));
      harness.click('#network-preflight-details');
      harness.click('#network-preflight-recheck');
      harness.click('#network-preflight-clear-history');
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('online'));
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('offline'));
      harness.document.dispatchEvent(new harness.dom.window.Event('visibilitychange'));

      expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(false);
      expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
      expect(harness.method('invalidateNetworkPreflight')).not.toHaveBeenCalled();
      expect(harness.method('clearNetworkPreflightHistory')).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });
});
