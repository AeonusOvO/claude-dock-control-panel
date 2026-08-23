import { describe, expect, it } from 'vitest';
import type { ControlPanelApi } from '../../src/shared/contracts';
import { enhanceSelect } from '../../src/renderer/platform/components';
import {
  change,
  expectCss,
  input,
  mcpCatalog,
  plugin,
  pluginCatalog,
  settle,
  withRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';

describe('select, plugin, MCP, proxy and workspace behavior', () => {
  it('opens from the shell rather than the trigger, so the OS popup never answers a press', async () => {
    await withRenderer({}, (harness) => {
      const select = harness.document.createElement('select');
      select.append(
        Object.assign(harness.document.createElement('option'), { text: 'One', value: '1' }),
        Object.assign(harness.document.createElement('option'), { text: 'Two', value: '2' }),
      );
      harness.document.body.append(select);
      enhanceSelect(select);
      const shell = select.closest('.select')!;
      const event = new harness.dom.window.MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        cancelable: true,
      });
      shell.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(harness.document.querySelector('.select__listbox')?.hasAttribute('hidden')).toBe(
        false,
      );
    });
  });

  it('closes synchronously while a discrete CSS transition preserves the visual exit', async () => {
    await withRenderer({}, (harness) => {
      const select = harness.document.createElement('select');
      select.append(
        Object.assign(harness.document.createElement('option'), { text: 'One', value: '1' }),
      );
      harness.document.body.append(select);
      enhanceSelect(select);
      const shell = select.closest('.select')!;
      shell.dispatchEvent(
        new harness.dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
      select.dispatchEvent(
        new harness.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
      expect(harness.document.querySelector('.select__listbox')?.hasAttribute('hidden')).toBe(true);
      expect(shell.querySelector('.select__trigger')?.getAttribute('aria-expanded')).toBe('false');
      expectCss(/overlay var\(--dur-exit\) allow-discrete/u);
    });
  });

  it('parents the popup into an open dialog so it is not buried by the top layer', async () => {
    await withRenderer({}, (harness) => {
      const dialog = harness.document.createElement('dialog');
      const select = harness.document.createElement('select');
      select.append(
        Object.assign(harness.document.createElement('option'), { text: 'One', value: '1' }),
      );
      dialog.append(select);
      harness.document.body.append(dialog);
      dialog.showModal();
      enhanceSelect(select);
      select
        .closest('.select')!
        .dispatchEvent(
          new harness.dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }),
        );
      expect(dialog.querySelector(':scope > .select__listbox')).not.toBeNull();
    });
  });

  it('clears the in-progress flag before re-rendering, so rebuilt buttons come back enabled', async () => {
    const installed = plugin('installed', { enabled: true, installed: true });
    const catalog = pluginCatalog([], [installed]);
    await withTerminalRenderer(
      {
        getClaudePlugins: async () => catalog,
        setClaudePluginEnabled: async () => ({ catalog, message: 'done', ok: true }),
      },
      async (harness) => {
        harness.click('[data-rail-tab="plugins"]');
        await settle(harness);
        harness.query<HTMLButtonElement>('#plugin-installed-list button').click();
        await settle(harness);
        expect(harness.query<HTMLButtonElement>('#plugin-installed-list button').disabled).toBe(
          false,
        );
      },
    );
  });

  it('dims only installed-but-disabled plugins, never the ones on offer', async () => {
    const installed = plugin('installed', { installed: true });
    await withRenderer(
      { getClaudePlugins: async () => pluginCatalog([plugin('available')], [installed]) },
      async (harness) => {
        harness.click('[data-rail-tab="plugins"]');
        await settle(harness);
        expect(
          harness.query('#plugin-installed-list .plugin-card').getAttribute('data-installed'),
        ).toBe('true');
        expect(
          harness.query('#plugin-available-list .plugin-card').getAttribute('data-installed'),
        ).toBe('false');
        expectCss(/\.plugin-card\[data-enabled='false'\]\[data-installed='true'\]/u);
      },
    );
  });

  it('gives the MCP page the same tabbed layout as the plugins page', async () => {
    await withRenderer({}, (harness) => {
      harness.click('[data-mcp-tab="catalog"]');
      expect(
        harness.query('[data-mcp-tab="catalog"]').classList.contains('plugin-tab--active'),
      ).toBe(true);
      expect(
        harness.query('[data-mcp-panel="catalog"]').classList.contains('plugin-panel--active'),
      ).toBe(true);
      expect(
        harness.query('[data-mcp-panel="installed"]').classList.contains('plugin-panel--active'),
      ).toBe(false);
    });
  });

  it('keeps startup, recommendation browsing and manual refresh on catalog-only Registry sync', async () => {
    const catalog = mcpCatalog(['catalog-entry']);
    catalog.available[0]!.description = '<img src=x onerror="throw new Error(\'executed\')">';
    await withTerminalRenderer({ getMcpCatalog: async () => catalog }, async (harness) => {
      expect(harness.method('getMcpCatalog')).toHaveBeenCalledWith('D:\\Project', true);

      harness.clearCalls();
      harness.click('[data-rail-tab="mcp"]');
      await settle(harness);
      expect(harness.method('getMcpCatalog')).toHaveBeenCalledWith('D:\\Project', false);
      expect(harness.query('#mcp-status').textContent).not.toContain('健康检查');
      expect(harness.query('#mcp-catalog-list').textContent).toContain('<img src=x');
      expect(harness.query('#mcp-catalog-list').querySelector('img')).toBeNull();

      harness.clearCalls();
      harness.click('#mcp-refresh');
      await settle(harness);
      expect(harness.method('getMcpCatalog')).toHaveBeenCalledWith('D:\\Project', true);
      expect(harness.query('#mcp-refresh').textContent).toBe('刷新目录');
    });
  });

  it('filters plugins by category with the same control MCP uses for scope', async () => {
    await withRenderer(
      {
        getClaudePlugins: async () =>
          pluginCatalog([plugin('api-security'), plugin('frontend-design')]),
      },
      async (harness) => {
        harness.click('[data-rail-tab="plugins"]');
        await settle(harness);
        input(harness.query('#plugin-search'), 'frontend');
        expect(
          harness.document.querySelectorAll('#plugin-available-list .plugin-card'),
        ).toHaveLength(1);
        expect(harness.query('#plugin-available-list').textContent).toContain('frontend-design');
      },
    );
  });

  it('animates only the plugin cards that are genuinely new', async () => {
    const catalog = pluginCatalog([plugin('alpha'), plugin('beta')]);
    await withRenderer({ getClaudePlugins: async () => catalog }, async (harness) => {
      harness.click('[data-rail-tab="plugins"]');
      await settle(harness);
      expect(
        Array.from(
          harness.document.querySelectorAll<HTMLElement>('.plugin-card'),
          (card) => card.dataset.fresh,
        ),
      ).toEqual(['false', 'false']);
      input(harness.query('#plugin-search'), 'alpha');
      expect(harness.query('#plugin-available-list .plugin-card').getAttribute('data-fresh')).toBe(
        'false',
      );
    });
  });

  it('animates only the MCP cards that are genuinely new', async () => {
    await withTerminalRenderer(
      { getMcpCatalog: async () => mcpCatalog(['alpha', 'beta']) },
      async (harness) => {
        harness.click('[data-rail-tab="mcp"]');
        await settle(harness);
        input(harness.query('#mcp-search'), 'alpha');
        expect(harness.query('#mcp-catalog-list .plugin-card').getAttribute('data-fresh')).toBe(
          'false',
        );
        expectCss(/\.plugin-card\[data-fresh='false'\]\s*\{\s*animation:\s*none/u);
      },
    );
  });

  it('frames closing a running conversation as an archive rather than a deletion', async () => {
    await withTerminalRenderer(
      {
        closeProject: async () => ({
          ok: true,
          state: { activeSessionId: '', projects: [], sessions: [] },
        }),
        getClaudeSessionsForPath: async () => [],
      },
      async (harness) => {
        harness.query<HTMLButtonElement>('.conversation-item__action--close').click();
        expect(harness.query('#confirmation-dialog').textContent).toContain('归档');
        harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
        await settle(harness);
        expect(harness.method('closeProject')).toHaveBeenCalledWith('session-1');
      },
    );
  });

  it('keeps project dragging independent from the removed proxy-kernel drop zone', async () => {
    await withRenderer(
      {
        addProject: async () => ({
          ok: true,
          state: { activeSessionId: '', projects: [], sessions: [] },
        }),
        getDroppedPath: () => 'D:\\Dropped',
      },
      async (harness) => {
        const file = new harness.dom.window.File(['x'], 'folder');
        const event = new harness.dom.window.Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
        harness.document.dispatchEvent(event);
        await harness.flush();
        expect(harness.method('addProject')).toHaveBeenCalledWith('D:\\Dropped');
        expect(harness.document.querySelector('[data-drop-zone="proxy-core"]')).toBeNull();
      },
    );
  });

  it('offers explicit detection, save, and connection-test actions', () => {
    return withRenderer({}, (harness) => {
      for (const id of [
        'application-proxy-detect',
        'application-proxy-save',
        'application-proxy-test',
      ]) {
        expect(harness.document.getElementById(id)).not.toBeNull();
      }
    });
  });

  it('treats the proxy editor as one staged setting with saved-only testing', async () => {
    const state = {
      config: {
        enabled: true,
        host: 'saved.local',
        passwordConfigured: false,
        port: 8080,
        protocol: 'http' as const,
        scope: { application: true, cli: true, conversation: true },
        username: '',
      },
    };
    await withRenderer(
      { getApplicationProxyState: async () => state, testApplicationProxy: async () => state },
      async (harness) => {
        harness.click('#open-connection-advanced');
        await settle(harness);
        harness.click('#application-proxy-test');
        await settle(harness);
        expect(harness.method('testApplicationProxy')).toHaveBeenCalledWith();
        input(harness.query('#application-proxy-host'), 'draft.local');
        expect(harness.query<HTMLButtonElement>('#application-proxy-test').disabled).toBe(true);
        expect(harness.method('saveApplicationProxy')).not.toHaveBeenCalled();
      },
    );
  });

  it('generation-fences delayed proxy loads and never overwrites an edited draft', async () => {
    type ProxyState = Awaited<ReturnType<ControlPanelApi['getApplicationProxyState']>>;
    const state = (host: string): ProxyState => ({
      config: {
        enabled: true,
        host,
        passwordConfigured: false,
        port: 8080,
        protocol: 'http',
        scope: { application: true, cli: true, conversation: true },
        username: '',
      },
    });
    const resolvers: Array<(value: ProxyState) => void> = [];
    await withRenderer(
      {
        getApplicationProxyState: () =>
          new Promise<ProxyState>((resolve) => {
            resolvers.push(resolve);
          }),
      },
      async (harness) => {
        const callsBeforeDialog = resolvers.length;
        harness.click('#open-connection-advanced');
        await harness.flush();
        const stale = resolvers[callsBeforeDialog]!;
        harness.click('#close-connection-advanced');
        harness.click('#open-connection-advanced');
        await harness.flush();
        const current = resolvers[callsBeforeDialog + 1]!;
        expect(current).not.toBe(stale);
        current(state('current.local'));
        await settle(harness);
        input(harness.query('#application-proxy-host'), 'edited.local');
        stale(state('late.local'));
        await settle(harness);
        expect(harness.query<HTMLInputElement>('#application-proxy-host').value).toBe(
          'edited.local',
        );
      },
    );
  });

  it('disables the unsupported CLI scope when SOCKS5 is selected', async () => {
    await withRenderer({}, (harness) => {
      harness.click('#open-connection-advanced');
      const enabled = harness.query<HTMLInputElement>('#application-proxy-enabled');
      enabled.checked = true;
      change(enabled);
      change(harness.query('#application-proxy-protocol'), 'socks5');
      expect(harness.query<HTMLInputElement>('#application-proxy-scope-cli').disabled).toBe(true);
    });
  });

  it('does not discard its draft when a pointer is released on the backdrop', async () => {
    await withRenderer({}, (harness) => {
      harness.click('#open-chat-settings');
      const dialog = harness.query<HTMLDialogElement>('#chat-settings-dialog');
      const field = harness.query<HTMLInputElement>('#chat-model');
      input(field, 'draft-model');
      dialog.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true }));
      expect(dialog.open).toBe(true);
      expect(field.value).toBe('draft-model');
    });
  });

  it('animates the terminal/chat swap without remounting either shell', async () => {
    await withRenderer({}, (harness) => {
      const terminal = harness.query('#terminal-shell');
      const chat = harness.query('#chat-shell');
      harness.click('[data-rail-tab="chat"]');
      expect(harness.query('#terminal-shell')).toBe(terminal);
      expect(harness.query('#chat-shell')).toBe(chat);
      expect(chat.hasAttribute('hidden')).toBe(false);
      expect(terminal.hasAttribute('hidden')).toBe(true);
      expectCss(/\.terminal-shell:not\(\[hidden\]\),\s*\.chat-shell:not\(\[hidden\]\)/u);
    });
  });

  it('uses the shared switch entrance and keeps outgoing workbench pages inert', async () => {
    await withRenderer({}, (harness) => {
      harness.click('#workbench-trigger');
      harness.query<HTMLButtonElement>('[data-workbench-tab="commands"]').click();
      expect(harness.query('.workbench-page--active').getAttribute('data-workbench-page')).toBe(
        'commands',
      );
      expectCss(
        /\.workbench-page:not\(\.workbench-page--active\)\s*\{[^}]*pointer-events:\s*none/u,
      );
    });
  });
});
