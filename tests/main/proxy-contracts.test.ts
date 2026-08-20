import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApplicationProxyState,
  ApplicationProxyView,
  SaveApplicationProxyInput,
} from '../../src/shared/contracts';
import {
  applicationProxyRules,
  buildApplicationProxyEnvironment,
} from '../../src/main/proxy/application-proxy';
import { createIpcHarness } from '../helpers/ipc-harness';
import {
  createTestMainServiceRegistry,
  registerTestService,
} from '../helpers/main-service-registry';
import { createRendererHarness } from '../helpers/renderer-harness';

const enabledProxy: ApplicationProxyView = {
  enabled: true,
  host: '127.0.0.1',
  passwordConfigured: false,
  port: 7890,
  protocol: 'http',
  scope: { application: true, cli: true, conversation: false },
  username: '',
};

const proxyState: ApplicationProxyState = { config: enabledProxy };

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('application proxy contracts', () => {
  it('applies the saved endpoint only to selected ClaudeDock scopes', () => {
    expect(applicationProxyRules(enabledProxy, 'application')).toEqual({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://127.0.0.1:7890',
    });
    expect(applicationProxyRules(enabledProxy, 'conversation')).toEqual({ mode: 'direct' });
    expect(
      applicationProxyRules(
        { ...enabledProxy, enabled: false, scope: { ...enabledProxy.scope, application: true } },
        'application',
      ),
    ).toEqual({ mode: 'system' });

    expect(buildApplicationProxyEnvironment(enabledProxy, undefined, 'example.internal')).toEqual({
      ALL_PROXY: null,
      all_proxy: null,
      CLAUDEDOCK_APPLICATION_PROXY: '1',
      CLAUDEDOCK_BUILT_IN_PROXY: null,
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '127.0.0.1,localhost,::1,example.internal',
      https_proxy: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      no_proxy: '127.0.0.1,localhost,::1,example.internal',
    });
    expect(
      buildApplicationProxyEnvironment({
        ...enabledProxy,
        protocol: 'socks5',
        scope: { ...enabledProxy.scope, cli: false },
      }),
    ).toEqual({});
  });

  it('routes the real bridge through main handlers and tests only the GitHub endpoint', async () => {
    const ipc = createIpcHarness();
    const detectionSession = {
      resolveProxy: vi.fn(async () => 'PROXY 127.0.0.1:7890; SOCKS5 localhost:1080; DIRECT'),
      setProxy: vi.fn(async () => undefined),
    };
    vi.doMock('electron', () => ({
      ipcMain: ipc.ipcMain,
      ipcRenderer: ipc.ipcRenderer,
      session: { fromPartition: vi.fn(() => detectionSession) },
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const [{ registerProxyIpc }, { applicationProxyBridge }] = await Promise.all([
      import('../../src/main/ipc/proxy'),
      import('../../src/preload/bridges/application-proxy'),
    ]);
    const save = vi.fn();
    const invalidate = vi.fn();
    const setProxy = vi.fn(async () => undefined);
    const closeAllConnections = vi.fn(async () => undefined);
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    const applyApplicationProxyScope = vi.fn(async () => undefined);
    const applyConversationProxyScope = vi.fn(async () => undefined);
    const validateSender = vi.fn();
    const services = await createTestMainServiceRegistry();
    const { APPLICATION_PROXY_TEST_SESSION, MAIN_WINDOW } =
      await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_TEST_SESSION, {
      closeAllConnections,
      fetch,
      setProxy,
    } as never);
    services.resolve(MAIN_WINDOW).current = {
      webContents: ipc.webContents,
    } as Electron.BrowserWindow;
    registerProxyIpc({
      applyApplicationProxyScope,
      applyConversationProxyScope,
      guards: {
        requireApplicationProxyStore: vi.fn(() => ({ getView: () => enabledProxy, save }) as never),
        requireNetworkPreflightService: vi.fn(() => ({ invalidate }) as never),
        validateSender,
      },
      services,
      state: {} as never,
    });

    expect(Object.keys(applicationProxyBridge).sort()).toEqual([
      'detectApplicationProxyCandidates',
      'getApplicationProxyState',
      'onApplicationProxyChanged',
      'saveApplicationProxy',
      'testApplicationProxy',
    ]);
    await expect(applicationProxyBridge.getApplicationProxyState()).resolves.toEqual(proxyState);

    const input: SaveApplicationProxyInput = {
      enabled: true,
      host: '127.0.0.1',
      port: 7890,
      protocol: 'http',
      scope: { application: true, cli: true, conversation: false },
    };
    const changed = vi.fn();
    const unsubscribe = applicationProxyBridge.onApplicationProxyChanged(changed);
    await expect(applicationProxyBridge.saveApplicationProxy(input)).resolves.toEqual(proxyState);
    expect(save).toHaveBeenCalledWith(input);
    expect(applyApplicationProxyScope).toHaveBeenCalledOnce();
    expect(applyConversationProxyScope).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith('application-proxy-changed');
    expect(changed).toHaveBeenCalledWith(proxyState);
    unsubscribe();

    const tested = await applicationProxyBridge.testApplicationProxy();
    expect(tested.test).toMatchObject({
      ok: true,
      message: '已通过该代理访问 GitHub（HTTP 204）。',
    });
    expect(setProxy).toHaveBeenCalledWith(applicationProxyRules(enabledProxy, 'application'));
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://github.com/');

    const candidates = await applicationProxyBridge.detectApplicationProxyCandidates();
    expect(detectionSession.setProxy).toHaveBeenCalledWith({ mode: 'system' });
    expect(detectionSession.resolveProxy).toHaveBeenCalledWith('https://github.com');
    expect(candidates).toEqual(
      expect.arrayContaining([
        { host: '127.0.0.1', label: 'Windows 系统代理', port: 7890, protocol: 'http' },
        { host: 'localhost', label: 'Windows 系统代理', port: 1080, protocol: 'socks5' },
      ]),
    );
    expect(validateSender).toHaveBeenCalledTimes(4);
  });

  it('exposes the scoped proxy form and submits its draft through the renderer API', async () => {
    const saveApplicationProxy = vi.fn(async (input: SaveApplicationProxyInput) => ({
      config: {
        ...enabledProxy,
        host: input.host,
        port: input.port,
        scope: input.scope,
      },
    }));
    const harness = await createRendererHarness({
      getApplicationProxyState: vi.fn(async () => proxyState),
      saveApplicationProxy,
    });
    try {
      harness.click('#open-connection-advanced');
      await harness.flush();
      harness.click('[data-settings-tab="proxy"]');
      await harness.flush();

      const panel = harness.query<HTMLElement>('[data-settings-panel="proxy"]');
      expect(panel.classList.contains('settings-panel--active')).toBe(true);
      expect(panel.textContent).toContain('不修改 Windows 系统代理、路由表、DNS');
      expect(panel.textContent).toContain('系统代理始终不在可选范围内');
      expect(panel.textContent).toContain('测试 GitHub 连接');
      expect(panel.textContent).not.toMatch(/出口 IP|公网 IP|订阅链接|Xray/i);

      const enabled = harness.query<HTMLInputElement>('#application-proxy-enabled');
      const host = harness.query<HTMLInputElement>('#application-proxy-host');
      const port = harness.query<HTMLInputElement>('#application-proxy-port');
      const applicationScope = harness.query<HTMLInputElement>(
        '#application-proxy-scope-application',
      );
      enabled.checked = true;
      enabled.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
      host.value = 'proxy.example.com';
      host.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
      port.value = '8080';
      port.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
      applicationScope.checked = true;
      applicationScope.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
      harness.click('#application-proxy-save');
      await harness.flush();

      expect(saveApplicationProxy).toHaveBeenCalledWith({
        enabled: true,
        host: 'proxy.example.com',
        password: undefined,
        port: 8080,
        protocol: 'http',
        scope: { application: true, cli: true, conversation: false },
        username: '',
      });
    } finally {
      await harness.cleanup();
    }
  });
});
