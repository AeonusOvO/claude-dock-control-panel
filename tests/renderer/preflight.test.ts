import { describe, expect, it, vi } from 'vitest';
import type {
  ApplicationProxyState,
  ClaudeProjectState,
  CodexProjectState,
  NetworkPreflightResult,
  NetworkPreflightStatus,
  NetworkProviderId,
} from '../../src/shared/contracts';
import { createRendererHarness } from '../helpers/renderer-harness';
import {
  change,
  input,
  settle,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import { claudeProjectState } from '../helpers/renderer-terminal-fixture';

const preflightResult = (
  provider: NetworkProviderId,
  status: NetworkPreflightStatus,
  overrides: Partial<NetworkPreflightResult> = {},
): NetworkPreflightResult => ({
  checkedAt: 1,
  featureAccess: [],
  paths: [],
  probes: [],
  provider,
  providerLabel: provider === 'openai-codex' ? 'OpenAI Codex' : 'Anthropic Claude Code',
  reasons: [],
  riskLevel: status === 'blocked' ? 'high' : 'low',
  riskScore: status === 'blocked' ? 90 : 10,
  signals: [],
  startedAt: 1,
  status,
  summary: `synthetic ${status}`,
  ...overrides,
});

const gatewayClaudeState = (): ClaudeProjectState => {
  const state = claudeProjectState();
  return {
    ...state,
    config: {
      ...state.config,
      baseUrl: 'https://gateway.example.test',
      provider: 'gateway',
    },
  };
};

const readyCodexState = (): CodexProjectState => ({
  account: {
    email: 'synthetic@example.test',
    planType: 'test',
    type: 'chatgpt',
  },
  active: false,
  cwd: 'D:\\Project',
  installation: {
    installed: true,
    message: 'Codex CLI 已就绪。',
    updateAvailable: false,
    version: 'test',
  },
  login: { phase: 'idle' },
  requiresOpenaiAuth: true,
  sessionId: 'session-1',
});

const proxyState = (): ApplicationProxyState => ({
  config: {
    enabled: true,
    host: 'saved.example.test',
    passwordConfigured: false,
    port: 8_080,
    protocol: 'http',
    scope: {
      application: true,
      cli: true,
      conversation: true,
    },
    username: '',
  },
});

describe('renderer preflight feature', () => {
  it('selects official Claude and Codex providers without guessing for gateways or unloaded state', async () => {
    await withTerminalRenderer(
      {
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledWith({
          action: 'background',
          force: false,
          provider: 'anthropic-claude',
        });
      },
    );

    await withTerminalRenderer(
      {
        getClaudeProjectState: async () => gatewayClaudeState(),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
        expect(harness.query('#network-preflight-provider').textContent).toBe('自定义网关');
      },
    );

    await withTerminalRenderer(
      {
        getClaudeProjectState: () => new Promise<ClaudeProjectState>(() => undefined),
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
      },
      async (harness) => {
        expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
      },
    );

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
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledWith({
          action: 'background',
          force: false,
          provider: 'openai-codex',
        });
      },
    );
  });

  it('maps every preflight status to the card tone and Codex footer label', async () => {
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
        const cases: Array<[NetworkPreflightStatus, string, string]> = [
          ['allowed', 'success', '官方网络正常'],
          ['allowed_with_notice', 'warning', '网络可用 · 有路径提示'],
          ['blocked', 'error', '官方网络已阻止'],
          ['degraded', 'warning', '网络结果不完整'],
          ['partially_available', 'warning', '基础可用 · 云任务受限'],
          ['testing', 'pending', '正在执行无额度预检'],
          ['unknown', 'warning', '网络状态未知'],
          ['warning', 'warning', '网络可用 · 需要确认'],
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
          '打开工作台后会自动执行首次检查。',
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
          preflightResult('anthropic-claude', 'warning', {
            paths: [
              {
                detail: 'Electron 主进程：代理连接。',
                dnsServers: ['192.0.2.10'],
                globalIpv6Available: false,
                ipv4Available: true,
                ipv6Available: false,
                process: 'application',
                proxyConfigured: true,
                proxyKind: 'application-proxy',
                virtualInterfaces: ['Synthetic Tunnel'],
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
              },
            ],
            reasons: ['synthetic risk reason'],
            summary: 'synthetic warning details',
          }),
        );
        harness.click('#network-preflight-details');

        expect(harness.query('#network-preflight-dialog-summary').textContent).toBe(
          'synthetic warning details',
        );
        expect(harness.query('#network-preflight-reasons').textContent).toContain(
          'synthetic risk reason',
        );
        expect(harness.query('#network-preflight-paths').textContent).toContain(
          '可见代理第一跳：application-proxy',
        );
        expect(harness.query('#network-preflight-paths').textContent).toContain(
          '虚拟接口：Synthetic Tunnel',
        );
        expect(harness.query('#network-preflight-probes').textContent).toContain(
          '通过HTTPS 探测synthetic passed detail',
        );
        expect(harness.query('#network-preflight-probes').textContent).toContain(
          '已跳过OAuth 探测synthetic skipped detail',
        );
      },
    );
  });

  it('deduplicates an in-flight check and restores both recheck buttons after settlement', async () => {
    let resolveRun: ((result: NetworkPreflightResult) => void) | undefined;
    const pending = new Promise<NetworkPreflightResult>((resolve) => {
      resolveRun = resolve;
    });

    await withTerminalRenderer(
      {
        runNetworkPreflight: () => pending,
      },
      async (harness) => {
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledOnce();
        expect(harness.query<HTMLButtonElement>('#network-preflight-recheck').disabled).toBe(true);
        expect(harness.query<HTMLButtonElement>('#network-preflight-dialog-recheck').disabled).toBe(
          true,
        );

        harness.click('#network-preflight-recheck');
        harness.click('#network-preflight-dialog-recheck');
        expect(harness.method('runNetworkPreflight')).toHaveBeenCalledOnce();

        resolveRun?.(preflightResult('anthropic-claude', 'allowed'));
        await settle(harness);
        expect(harness.query<HTMLButtonElement>('#network-preflight-recheck').disabled).toBe(false);
        expect(harness.query<HTMLButtonElement>('#network-preflight-dialog-recheck').disabled).toBe(
          false,
        );
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

  it('uses the exact proxy, runtime, and network invalidation reasons', async () => {
    const applicationProxy = proxyState();
    await withTerminalRenderer(
      {
        getApplicationProxyState: async () => applicationProxy,
        getCodexProjectState: async () => readyCodexState(),
        invalidateNetworkPreflight: async () => undefined,
        runNetworkPreflight: async ({ provider }) => preflightResult(provider, 'allowed'),
        saveApplicationProxy: async () => applicationProxy,
        setDevelopmentRuntime: async (sessionId, runtime) => ({
          cwd: 'D:\\Project',
          runtime,
          sessionId,
        }),
      },
      async (harness) => {
        harness.click('#open-connection-advanced');
        await settle(harness);
        harness.clearCalls();
        input(harness.query('#application-proxy-host'), 'changed.example.test');
        harness.click('#application-proxy-save');
        await settle(harness);
        expect(harness.method('invalidateNetworkPreflight')).toHaveBeenCalledWith(
          'application-proxy-change',
        );

        harness.clearCalls();
        const codex = harness.query<HTMLInputElement>('#runtime-codex');
        codex.checked = true;
        change(codex);
        await settle(harness);
        expect(harness.method('invalidateNetworkPreflight')).toHaveBeenCalledWith(
          'provider-switch',
        );

        harness.clearCalls();
        harness.dom.window.dispatchEvent(new harness.dom.window.Event('online'));
        await settle(harness);
        expect(harness.method('invalidateNetworkPreflight')).toHaveBeenCalledWith(
          'network-environment-changed',
        );
      },
    );
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
