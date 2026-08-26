import { describe, expect, it, vi } from 'vitest';
import type { ClaudePluginCatalog, WorkspaceState } from '../../src/shared/contracts';
import { createRendererHarness } from '../helpers/renderer-harness';

const terminalWorkspace: WorkspaceState = {
  activeSessionId: '',
  projects: [
    {
      lastActiveAt: 1,
      missing: false,
      name: 'Project',
      open: true,
      path: 'D:\\Project',
      remembered: true,
      sessionIds: ['session-1'],
    },
  ],
  sessions: [
    {
      cwd: 'D:\\Project',
      id: 'session-1',
      phase: 'running',
      ptyGeneration: 1,
      shell: 'powershell.exe',
      title: 'Project',
    },
  ],
};

const pluginCatalog: ClaudePluginCatalog = {
  available: [
    {
      description: 'Automate API security testing and detect OWASP vulnerabilities.',
      enabled: false,
      installed: false,
      marketplaceName: 'official',
      name: 'api-security',
      pluginId: 'api-security@official',
      sourceLabel: 'official/api-security',
      updateAvailable: false,
    },
  ],
  checkedAt: 1,
  cliAvailable: true,
  installed: [],
  marketplaces: [],
  message: '插件列表已加载。',
  updatesAvailable: 0,
};

const unmockTerminalModules = (): void => {
  vi.doUnmock('@xterm/addon-fit');
  vi.doUnmock('@xterm/addon-unicode11');
  vi.doUnmock('@xterm/addon-webgl');
  vi.doUnmock('@xterm/xterm');
};

describe('Chinese interface contract', () => {
  it('enables the proposed xterm API before loading the Unicode 11 addon', async () => {
    const terminalOptions: Array<Record<string, unknown>> = [];
    class FakeTerminal {
      public readonly buffer = {
        active: {
          baseY: 0,
          getLine: () => undefined,
          length: 0,
        },
      };
      public readonly cols = 80;
      public readonly rows = 24;
      public readonly unicode = { activeVersion: '' };
      public options: Record<string, unknown>;

      public constructor(options: Record<string, unknown>) {
        this.options = options;
        terminalOptions.push(options);
      }

      public attachCustomKeyEventHandler(): void {}
      public clear(): void {}
      public dispose(): void {}
      public focus(): void {}
      public getSelection(): string {
        return '';
      }
      public hasSelection(): boolean {
        return false;
      }
      public loadAddon(): void {}
      public onData(): void {}
      public open(): void {}
      public refresh(): void {}
      public resize(): void {}
      public selectAll(): void {}
      public write(_data: string, callback?: () => void): void {
        callback?.();
      }
    }
    class FakeFitAddon {
      public proposeDimensions(): undefined {
        return undefined;
      }
    }
    class FakeWebglAddon {
      public dispose(): void {}
      public onContextLoss(): void {}
    }

    vi.doMock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: FakeFitAddon }));
    vi.doMock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
    vi.doMock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }));

    let harness: Awaited<ReturnType<typeof createRendererHarness>> | undefined;
    try {
      harness = await createRendererHarness({
        getWorkspace: vi.fn(async () => terminalWorkspace),
      });
      expect(terminalOptions).toHaveLength(1);
      expect(terminalOptions[0]).toMatchObject({ allowProposedApi: true });
    } finally {
      await harness?.cleanup();
      unmockTerminalModules();
      vi.resetModules();
    }
  });

  it('renders Chinese labels for terminal and connection controls', async () => {
    const harness = await createRendererHarness();
    try {
      const text = [
        harness.query('.brand').textContent,
        harness.query('.router-provider-heading').textContent,
        harness.query('#router-provider-form').textContent,
        harness.query('.metrics-grid').textContent,
        harness.query('.session-facts').textContent,
      ].join('\n');
      expect(text).toContain('项目终端控制台');
      expect(text).toContain('服务提供方配置');
      expect(text).toContain('输入令牌');
      expect(text).toContain('会话编号');

      for (const deprecatedCopy of [
        'PowerShell Control',
        'OpenAI Chat Completions',
        'OpenAI Responses',
        'Anthropic Messages',
        'Provider 配置',
        '输入 token',
        '输出 token',
        '会话 ID',
        'Hooks 检查',
        '启动 Router',
      ]) {
        expect(text).not.toContain(deprecatedCopy);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it('renders localized plugin summaries without an English-original panel', async () => {
    const harness = await createRendererHarness({
      getClaudePlugins: vi.fn(async () => pluginCatalog),
    });
    try {
      harness.click('[data-rail-tab="extensions"]');
      await harness.flush();

      const card = harness.query<HTMLElement>('#plugin-available-list .plugin-card');
      expect(card.textContent).toContain('安全检查与漏洞发现');
      expect(card.textContent).not.toContain('Automate API security testing');
      expect(card.querySelector('.plugin-card__original')).toBeNull();
      expect(card.textContent).not.toContain('查看英文原文');
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps quit protection actions and severity copy in Chinese', async () => {
    const harness = await createRendererHarness();
    try {
      expect(harness.query('#quit-confirmation-message').textContent).toBe(
        '可以直接关闭窗口，后台会继续运行。',
      );
      expect(harness.query('#quit-minimize').textContent).toContain('最小化到托盘，继续运行');
      expect(harness.query('#quit-force').textContent).toBe('仍要退出');

      harness.emit('onAppQuitRequested', {
        hasBlocking: true,
        leases: [
          {
            cancellable: false,
            id: 'install:active',
            kind: 'install',
            label: '正在安装',
            severity: 'blocking',
          },
        ],
        requestId: 'quit-request-1',
      });
      expect(harness.query('#quit-confirmation-title').textContent).toBe(
        '正在完成退出前的收尾工作',
      );
      expect(harness.query('#quit-minimize').textContent).toContain('转到后台，继续收尾');

      harness.emit('onAppQuitRequested', {
        hasBlocking: false,
        leases: [
          {
            cancellable: true,
            id: 'download:active',
            kind: 'download',
            label: '正在下载',
            severity: 'background',
          },
        ],
        requestId: 'quit-request-2',
      });
      expect(harness.query('#quit-confirmation-title').textContent).toBe('还有后台任务未完成');

      harness.emit('onAppQuitRequested', {
        hasBlocking: false,
        leases: [],
        requestId: 'quit-request-3',
      });
      expect(harness.query('#quit-confirmation-title').textContent).toBe('确认退出 ClaudeDock？');
    } finally {
      await harness.cleanup();
    }
  });
});
