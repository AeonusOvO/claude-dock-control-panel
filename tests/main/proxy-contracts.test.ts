import { EventEmitter } from 'node:events';
import type {
  AuthInfo,
  ClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage,
  Session,
} from 'electron';
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
import type { ApplicationProxyTestCredentialContext } from '../../src/main/proxy/application-proxy-coordinator';
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

const proxyAuth = (overrides: Partial<AuthInfo> = {}): AuthInfo =>
  ({
    host: '127.0.0.1',
    isProxy: true,
    port: 7890,
    ...overrides,
  }) as AuthInfo;

const incomingResponse = (statusCode: number): IncomingMessage =>
  Object.assign(new EventEmitter(), {
    headers: {},
    pause: vi.fn(),
    rawHeaders: [],
    resume: vi.fn(),
    statusCode,
    statusMessage: statusCode === 204 ? 'No Content' : '',
  }) as unknown as IncomingMessage;

interface NetRequestHarness {
  readonly emitter: EventEmitter;
  readonly request: ClientRequest;
}

const createNetRequestHarness = (
  onEnd: (harness: NetRequestHarness) => void,
): NetRequestHarness => {
  const emitter = new EventEmitter();
  const harness = {} as NetRequestHarness;
  const request = Object.assign(emitter, {
    abort: vi.fn(() => {
      emitter.emit('abort');
      emitter.emit('close');
    }),
    chunkedEncoding: false,
    end: vi.fn(() => onEnd(harness)),
    followRedirect: vi.fn(),
    write: vi.fn(),
  }) as unknown as ClientRequest;
  Object.assign(harness, { emitter, request });
  return harness;
};

const completeNetResponse = (harness: NetRequestHarness, statusCode = 204): void => {
  const response = incomingResponse(statusCode);
  harness.emitter.emit('response', response);
  response.emit('end');
  harness.emitter.emit('close');
};

const fetchResponseAt = (url: string, status: number, headers?: HeadersInit): Response =>
  Object.defineProperty(new Response(null, { headers, status }), 'url', {
    value: url,
  });

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

  it('routes the real bridge through main handlers and authenticates only the authorized GitHub proxy test origin', async () => {
    const ipc = createIpcHarness();
    const detectionSession = {
      resolveProxy: vi.fn(async () => 'PROXY 127.0.0.1:7890; SOCKS5 localhost:1080; DIRECT'),
      setProxy: vi.fn(async () => undefined),
    };
    const loginCallbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let requestIndex = 0;
    const netRequest = vi.fn((_options: ClientRequestConstructorOptions) => {
      const status = requestIndex++ === 0 ? 204 : 407;
      const requestHarness = createNetRequestHarness(({ emitter }) => {
        if (status === 204) {
          emitter.emit('login', proxyAuth({ isProxy: false }), loginCallbacks[0]);
          emitter.emit('login', proxyAuth({ host: 'wrong.example.com' }), loginCallbacks[1]);
          emitter.emit('login', proxyAuth({ port: 8080 }), loginCallbacks[2]);
          emitter.emit('login', proxyAuth({ host: '127.0.0.1' }), loginCallbacks[3]);
        }
        completeNetResponse(requestHarness, status);
      });
      return requestHarness.request;
    });
    vi.doMock('electron', () => ({
      ipcMain: ipc.ipcMain,
      ipcRenderer: ipc.ipcRenderer,
      net: { request: netRequest },
      session: { fromPartition: vi.fn(() => detectionSession) },
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const [{ registerProxyIpc }, { applicationProxyBridge }] = await Promise.all([
      import('../../src/main/ipc/proxy'),
      import('../../src/preload/bridges/application-proxy'),
    ]);
    const save = vi.fn(async () => enabledProxy);
    const setProxy = vi.fn(async () => undefined);
    const closeAllConnections = vi.fn(async () => undefined);
    const testSession = { closeAllConnections, setProxy } as unknown as Session;
    const resolveProxyCredentials = vi.fn(
      ({
        authInfo,
        requestUrl,
        session: requestingSession,
      }: ApplicationProxyTestCredentialContext) =>
        authInfo.isProxy &&
        requestingSession === testSession &&
        requestUrl.protocol === 'https:' &&
        requestUrl.origin === 'https://github.com' &&
        requestUrl.username === '' &&
        requestUrl.password === '' &&
        authInfo.host.toLowerCase() === '127.0.0.1' &&
        authInfo.port === 7890
          ? { password: 'candidate-secret', username: 'proxy-user' }
          : undefined,
    );
    const runApplicationProxyTest = vi.fn(
      async (_session: Session, operation: (capture: unknown) => Promise<unknown>) =>
        operation({
          proxyRules: applicationProxyRules(enabledProxy, 'application'),
          resolveProxyCredentials,
          revision: 'proxy-revision',
          targetUrl: 'https://github.com/',
          view: enabledProxy,
        }),
    );
    const coordinator = {
      getView: vi.fn(() => enabledProxy),
      isConfigurationCurrent: vi.fn((revision: string) => revision === 'proxy-revision'),
      runApplicationProxyTest,
      save,
    };
    const validateSender = vi.fn();
    const services = await createTestMainServiceRegistry();
    const { APPLICATION_PROXY_TEST_SESSION, MAIN_WINDOW } =
      await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_TEST_SESSION, testSession);
    services.resolve(MAIN_WINDOW).current = {
      webContents: ipc.webContents,
    } as Electron.BrowserWindow;
    registerProxyIpc({
      guards: {
        requireApplicationProxyCoordinator: vi.fn(() => coordinator as never),
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
    expect(changed).toHaveBeenCalledWith(proxyState);
    unsubscribe();

    const tested = await applicationProxyBridge.testApplicationProxy();
    expect(tested.test).toMatchObject({
      ok: true,
      message: '已通过该代理访问 GitHub（HTTP 204）。',
    });
    expect(runApplicationProxyTest).toHaveBeenCalledWith(testSession, expect.any(Function));
    expect(setProxy).toHaveBeenCalledWith(applicationProxyRules(enabledProxy, 'application'));
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(netRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'HEAD',
        session: testSession,
        url: 'https://github.com/',
      }),
    );
    expect(loginCallbacks[0]).toHaveBeenCalledWith();
    expect(loginCallbacks[1]).toHaveBeenCalledWith();
    expect(loginCallbacks[2]).toHaveBeenCalledWith();
    expect(loginCallbacks[3]).toHaveBeenCalledWith('proxy-user', 'candidate-secret');
    expect(resolveProxyCredentials).toHaveBeenCalledTimes(3);

    const rejected = await applicationProxyBridge.testApplicationProxy();
    expect(rejected.test).toMatchObject({
      message: expect.stringContaining('HTTP 407'),
      ok: false,
    });
    expect(runApplicationProxyTest).toHaveBeenCalledTimes(2);
    expect(setProxy).toHaveBeenCalledTimes(2);
    expect(closeAllConnections).toHaveBeenCalledTimes(2);
    expect(netRequest).toHaveBeenCalledTimes(2);

    const candidates = await applicationProxyBridge.detectApplicationProxyCandidates();
    expect(detectionSession.setProxy).toHaveBeenCalledWith({ mode: 'system' });
    expect(detectionSession.resolveProxy).toHaveBeenCalledWith('https://github.com');
    expect(candidates).toEqual(
      expect.arrayContaining([
        { host: '127.0.0.1', label: 'Windows 系统代理', port: 7890, protocol: 'http' },
        { host: 'localhost', label: 'Windows 系统代理', port: 1080, protocol: 'socks5' },
      ]),
    );
    expect(validateSender).toHaveBeenCalledTimes(5);
  });

  it('keeps proxy-test redirects on bounded HTTPS GitHub URLs and rejects mismatched success URLs', async () => {
    vi.doMock('electron', () => ({
      ipcMain: {},
      net: {},
      session: {},
    }));
    const { requestAuthorizedProxyTestTarget } = await import('../../src/main/ipc/proxy');
    const signal = new AbortController().signal;

    const crossOriginFetch = vi.fn(async () =>
      fetchResponseAt('https://github.com/', 302, {
        location: 'https://redirected.example/',
      }),
    );
    await expect(
      requestAuthorizedProxyTestTarget(
        crossOriginFetch as typeof fetch,
        'https://github.com/',
        signal,
      ),
    ).rejects.toThrow('未授权 URL');
    expect(crossOriginFetch).toHaveBeenCalledOnce();
    expect(crossOriginFetch).toHaveBeenCalledWith(
      new URL('https://github.com/'),
      expect.objectContaining({ credentials: 'omit', method: 'HEAD', redirect: 'manual', signal }),
    );

    const downgradeFetch = vi.fn(async () =>
      fetchResponseAt('https://github.com/', 302, { location: 'http://github.com/' }),
    );
    await expect(
      requestAuthorizedProxyTestTarget(
        downgradeFetch as typeof fetch,
        'https://github.com/',
        signal,
      ),
    ).rejects.toThrow('未授权 URL');
    expect(downgradeFetch).toHaveBeenCalledOnce();

    const mismatchedSuccessFetch = vi.fn(async () =>
      fetchResponseAt('https://redirected.example/', 204),
    );
    await expect(
      requestAuthorizedProxyTestTarget(
        mismatchedSuccessFetch as typeof fetch,
        'https://github.com/',
        signal,
      ),
    ).rejects.toThrow('未授权 URL');

    let redirectIndex = 0;
    const loopingFetch = vi.fn(async (input: RequestInfo | URL) => {
      redirectIndex += 1;
      return fetchResponseAt(String(input), 302, {
        location: `https://github.com/redirect-${redirectIndex}`,
      });
    });
    await expect(
      requestAuthorizedProxyTestTarget(loopingFetch as typeof fetch, 'https://github.com/', signal),
    ).rejects.toThrow('重定向次数超过 5 次上限');
    expect(loopingFetch).toHaveBeenCalledTimes(6);
  });

  it('suppresses stale test publication while retaining the old in-flight candidate credentials', async () => {
    const ipc = createIpcHarness();
    const requestHarness = createNetRequestHarness(() => undefined);
    const netRequest = vi.fn((_options: ClientRequestConstructorOptions) => requestHarness.request);
    vi.doMock('electron', () => ({
      ipcMain: ipc.ipcMain,
      ipcRenderer: ipc.ipcRenderer,
      net: { request: netRequest },
      session: { fromPartition: vi.fn() },
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const [{ registerProxyIpc }, { applicationProxyBridge }] = await Promise.all([
      import('../../src/main/ipc/proxy'),
      import('../../src/preload/bridges/application-proxy'),
    ]);
    let currentRevision = 'proxy-revision-a';
    let currentPassword = 'old-candidate-secret';
    let currentView: ApplicationProxyView = {
      ...enabledProxy,
      host: 'proxy-a.example.com',
      passwordConfigured: true,
      username: 'old-user',
    };
    const testSession = {
      closeAllConnections: vi.fn(async () => undefined),
      setProxy: vi.fn(async () => undefined),
    } as unknown as Session;
    const runApplicationProxyTest = vi.fn(
      async (
        _session: Session,
        operation: (capture: {
          proxyRules: ReturnType<typeof applicationProxyRules>;
          resolveProxyCredentials: (
            context: ApplicationProxyTestCredentialContext,
          ) => { password: string; username: string } | undefined;
          revision: string;
          targetUrl: string;
          view: ApplicationProxyView;
        }) => Promise<unknown>,
      ) => {
        const capturedRevision = currentRevision;
        const capturedView = currentView;
        const capturedPassword = currentPassword;
        return operation({
          proxyRules: applicationProxyRules(capturedView, 'application'),
          resolveProxyCredentials: ({ authInfo, requestUrl, session: requestingSession }) =>
            authInfo.isProxy &&
            requestingSession === testSession &&
            requestUrl.protocol === 'https:' &&
            requestUrl.origin === 'https://github.com' &&
            requestUrl.username === '' &&
            requestUrl.password === '' &&
            authInfo.host.toLowerCase() === 'proxy-a.example.com' &&
            authInfo.port === 7890
              ? { password: capturedPassword, username: 'old-user' }
              : undefined,
          revision: capturedRevision,
          targetUrl: 'https://github.com/',
          view: capturedView,
        });
      },
    );
    const coordinator = {
      getView: vi.fn(() => currentView),
      isConfigurationCurrent: vi.fn((revision: string) => revision === currentRevision),
      runApplicationProxyTest,
      save: vi.fn(async (input: SaveApplicationProxyInput) => {
        currentView = {
          enabled: input.enabled,
          host: input.host,
          passwordConfigured: Boolean(input.password),
          port: input.port,
          protocol: input.protocol,
          scope: { ...input.scope },
          username: input.username ?? '',
        };
        currentPassword = input.password ?? '';
        currentRevision = 'proxy-revision-b';
        return currentView;
      }),
    };
    const services = await createTestMainServiceRegistry();
    const { APPLICATION_PROXY_TEST_SESSION, MAIN_WINDOW } =
      await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_TEST_SESSION, testSession);
    services.resolve(MAIN_WINDOW).current = {
      webContents: ipc.webContents,
    } as Electron.BrowserWindow;
    registerProxyIpc({
      guards: {
        requireApplicationProxyCoordinator: vi.fn(() => coordinator as never),
        validateSender: vi.fn(),
      },
      services,
      state: {} as never,
    });
    const changed = vi.fn();
    applicationProxyBridge.onApplicationProxyChanged(changed);

    const staleTest = applicationProxyBridge.testApplicationProxy();
    await vi.waitFor(() => expect(requestHarness.request.end).toHaveBeenCalledOnce());
    const replacement: SaveApplicationProxyInput = {
      enabled: true,
      host: 'proxy-b.example.com',
      password: 'new-candidate-secret',
      port: 8080,
      protocol: 'http',
      scope: { application: true, cli: false, conversation: false },
      username: 'new-user',
    };
    await expect(applicationProxyBridge.saveApplicationProxy(replacement)).resolves.toEqual({
      config: currentView,
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith({ config: currentView });

    const loginCallback = vi.fn();
    requestHarness.emitter.emit('login', proxyAuth({ host: 'PrOxY-A.Example.Com' }), loginCallback);
    expect(loginCallback).toHaveBeenCalledWith('old-user', 'old-candidate-secret');
    completeNetResponse(requestHarness);

    await expect(staleTest).resolves.toEqual({ config: currentView });
    expect(coordinator.isConfigurationCurrent).toHaveBeenCalledWith('proxy-revision-a');
    expect(changed).toHaveBeenCalledOnce();
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
