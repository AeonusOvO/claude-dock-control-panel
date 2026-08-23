import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain, net, session } from 'electron';
import type {
  ApplicationProxyCandidate,
  ApplicationProxyState,
  SaveApplicationProxyInput,
} from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { APPLICATION_PROXY_TEST_SESSION, MAIN_WINDOW } from '../infra/service-tokens';
import { createElectronSessionFetch } from '../network/electron-request';
import { parseApplicationProxyCandidate } from '../proxy/application-proxy';
import type { MainState } from './context';
import type { MainGuards } from './guards';

export interface ProxyIpcDependencies {
  guards: Pick<MainGuards, 'requireApplicationProxyCoordinator' | 'validateSender'>;
  services: Registry;
  state: MainState;
}

const reportProxyFailure = createFailureReporter('application-proxy');
const APPLICATION_PROXY_TEST_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_APPLICATION_PROXY_TEST_REDIRECTS = 5;

const isAuthorizedProxyTestUrl = (url: URL, authorizedOrigin: string): boolean =>
  url.protocol === 'https:' &&
  url.origin === authorizedOrigin &&
  url.username === '' &&
  url.password === '';

const cancelResponse = async (response: Response): Promise<void> => {
  await response.body?.cancel();
};

/** Executes the proxy test without allowing credentials or success to escape the GitHub origin. */
export const requestAuthorizedProxyTestTarget = async (
  authenticatedFetch: typeof fetch,
  targetUrl: string,
  signal: AbortSignal,
): Promise<Response> => {
  const initialUrl = new URL(targetUrl);
  const authorizedOrigin = initialUrl.origin;
  if (!isAuthorizedProxyTestUrl(initialUrl, authorizedOrigin)) {
    throw new Error('代理测试目标必须是无内嵌凭据的 HTTPS URL。');
  }

  let currentUrl = initialUrl;
  let redirectCount = 0;
  while (true) {
    const response = await authenticatedFetch(currentUrl, {
      cache: 'no-store',
      credentials: 'omit',
      method: 'HEAD',
      redirect: 'manual',
      signal,
    });
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url);
    } catch {
      await cancelResponse(response);
      throw new Error('代理测试响应缺少可验证的最终 URL。');
    }
    if (
      responseUrl.href !== currentUrl.href ||
      !isAuthorizedProxyTestUrl(responseUrl, authorizedOrigin)
    ) {
      await cancelResponse(response);
      throw new Error(`代理测试响应来自未授权 URL：${responseUrl.origin}。`);
    }

    if (!APPLICATION_PROXY_TEST_REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    const location = response.headers.get('location');
    await cancelResponse(response);
    if (!location) {
      throw new Error(`GitHub 返回 HTTP ${response.status}，但缺少 Location 重定向目标。`);
    }

    redirectCount += 1;
    if (redirectCount > MAX_APPLICATION_PROXY_TEST_REDIRECTS) {
      throw new Error(`代理测试重定向次数超过 ${MAX_APPLICATION_PROXY_TEST_REDIRECTS} 次上限。`);
    }
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, currentUrl);
    } catch {
      throw new Error('代理测试收到无效的重定向 URL。');
    }
    if (!isAuthorizedProxyTestUrl(redirectUrl, authorizedOrigin)) {
      throw new Error(`代理测试拒绝重定向到未授权 URL：${redirectUrl.origin}。`);
    }
    currentUrl = redirectUrl;
  }
};

export const registerProxyIpc = ({
  guards: { requireApplicationProxyCoordinator, validateSender },
  services,
  state,
}: ProxyIpcDependencies): void => {
  const applicationProxyView = (): ApplicationProxyState => ({
    config: requireApplicationProxyCoordinator().getView(),
    test: state.applicationProxyState?.test,
  });

  const publishApplicationProxyState = (): ApplicationProxyState => {
    state.applicationProxyState = applicationProxyView();
    services
      .resolve(MAIN_WINDOW)
      .current?.webContents.send(CHANNELS.APPLICATION_PROXY_CHANGED, state.applicationProxyState);
    return state.applicationProxyState;
  };

  const detectApplicationProxyCandidates = async (): Promise<ApplicationProxyCandidate[]> => {
    const candidates = new Map<string, ApplicationProxyCandidate>();
    const addCandidate = (candidate: ApplicationProxyCandidate | undefined): void => {
      if (candidate) {
        candidates.set(`${candidate.protocol}:${candidate.host}:${candidate.port}`, candidate);
      }
    };
    for (const variable of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'ALL_PROXY',
    ]) {
      addCandidate(parseApplicationProxyCandidate(process.env[variable], `环境变量 ${variable}`));
    }
    try {
      const detectionSession = session.fromPartition('claudedock-system-proxy-detection');
      await detectionSession.setProxy({ mode: 'system' });
      const resolved = await detectionSession.resolveProxy('https://github.com');
      for (const entry of resolved.split(';')) {
        const [scheme, endpoint] = entry.trim().split(/\s+/);
        if (!endpoint || scheme === 'DIRECT') continue;
        const prefix = scheme === 'SOCKS5' || scheme === 'SOCKS' ? 'socks5' : 'http';
        addCandidate(parseApplicationProxyCandidate(`${prefix}://${endpoint}`, 'Windows 系统代理'));
      }
    } catch {
      // No system proxy configured is a perfectly normal answer.
    }
    return [...candidates.values()];
  };

  const testApplicationProxy = async (): Promise<ApplicationProxyState> => {
    const coordinator = requireApplicationProxyCoordinator();
    const testSession = services.resolve(APPLICATION_PROXY_TEST_SESSION);
    const captured = await coordinator.runApplicationProxyTest(testSession, async (capture) => {
      const { revision, view: config } = capture;
      if (!config.enabled) {
        throw new Error('请先保存并启用应用代理。');
      }
      const startedAt = Date.now();
      let outcome:
        | {
            checkedAt: number;
            kind: 'response';
            latencyMs: number;
            ok: boolean;
            status: number;
          }
        | {
            checkedAt: number;
            error: unknown;
            kind: 'failure';
            message: string;
          };
      try {
        await testSession.setProxy(capture.proxyRules);
        await testSession.closeAllConnections();
        const authenticatedFetch = createElectronSessionFetch({
          requestFactory: (options) => net.request(options),
          resolveProxyCredentials: capture.resolveProxyCredentials,
          session: testSession,
        });
        const response = await requestAuthorizedProxyTestTarget(
          authenticatedFetch,
          capture.targetUrl,
          AbortSignal.timeout(12_000),
        );
        await response.body?.cancel();
        outcome = {
          checkedAt: Date.now(),
          kind: 'response',
          latencyMs: Date.now() - startedAt,
          ok: response.ok && response.status !== 407,
          status: response.status,
        };
      } catch (error) {
        outcome = {
          checkedAt: Date.now(),
          error,
          kind: 'failure',
          message: `代理连接失败：${error instanceof Error ? error.message : '未知网络错误'}`,
        };
      }
      return { config, outcome, revision };
    });
    const { config, outcome, revision } = captured;
    if (!coordinator.isConfigurationCurrent(revision)) {
      return applicationProxyView();
    }
    const test: NonNullable<ApplicationProxyState['test']> =
      outcome.kind === 'failure'
        ? {
            ...reportProxyFailure('external-service', outcome.message, outcome.error),
            checkedAt: outcome.checkedAt,
            ok: false,
          }
        : outcome.ok
          ? {
              checkedAt: outcome.checkedAt,
              latencyMs: outcome.latencyMs,
              message: `已通过该代理访问 GitHub（HTTP ${outcome.status}）。`,
              ok: true,
            }
          : {
              ...reportProxyFailure(
                'external-service',
                `代理已响应，但 GitHub 返回 HTTP ${outcome.status}。`,
                { status: outcome.status },
              ),
              checkedAt: outcome.checkedAt,
              latencyMs: outcome.latencyMs,
              ok: false,
            };
    state.applicationProxyState = { config, test };
    services
      .resolve(MAIN_WINDOW)
      .current?.webContents.send(CHANNELS.APPLICATION_PROXY_CHANGED, state.applicationProxyState);
    return state.applicationProxyState;
  };
  ipcMain.handle(CHANNELS.APPLICATION_PROXY_GET, (event) => {
    validateSender(event);
    return applicationProxyView();
  });
  ipcMain.handle(CHANNELS.APPLICATION_PROXY_SAVE, async (event, input: unknown) => {
    validateSender(event);
    await requireApplicationProxyCoordinator().save(input as SaveApplicationProxyInput);
    state.applicationProxyState = undefined;
    return publishApplicationProxyState();
  });
  ipcMain.handle(CHANNELS.APPLICATION_PROXY_TEST, async (event) => {
    validateSender(event);
    return testApplicationProxy();
  });
  ipcMain.handle(CHANNELS.APPLICATION_PROXY_DETECT, async (event) => {
    validateSender(event);
    return detectApplicationProxyCandidates();
  });
};
