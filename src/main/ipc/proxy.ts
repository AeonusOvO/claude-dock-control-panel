import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain, session } from 'electron';
import type {
  ApplicationProxyCandidate,
  ApplicationProxyState,
  SaveApplicationProxyInput,
} from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { APPLICATION_PROXY_TEST_SESSION, MAIN_WINDOW } from '../infra/service-tokens';
import { applicationProxyRules, parseApplicationProxyCandidate } from '../proxy/application-proxy';
import type { MainState } from './context';
import type { MainGuards } from './guards';

export interface ProxyIpcDependencies {
  /* Startup applies both scopes once before any window exists, so they stay owned by the assembly. */
  applyApplicationProxyScope: () => Promise<void>;
  applyConversationProxyScope: () => Promise<void>;
  guards: Pick<
    MainGuards,
    'requireApplicationProxyStore' | 'requireNetworkPreflightService' | 'validateSender'
  >;
  services: Registry;
  state: MainState;
}

const reportProxyFailure = createFailureReporter('application-proxy');

export const registerProxyIpc = ({
  applyApplicationProxyScope,
  applyConversationProxyScope,
  guards: { requireApplicationProxyStore, requireNetworkPreflightService, validateSender },
  services,
  state,
}: ProxyIpcDependencies): void => {
  const applicationProxyView = (): ApplicationProxyState => ({
    config: requireApplicationProxyStore().getView(),
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
    const store = requireApplicationProxyStore();
    const config = store.getView();
    if (!config.enabled) {
      throw new Error('请先保存并启用应用代理。');
    }
    const testConfig = { ...config, scope: { ...config.scope, application: true } };
    const testSession = services.resolve(APPLICATION_PROXY_TEST_SESSION);
    await testSession.setProxy(applicationProxyRules(testConfig, 'application'));
    await testSession.closeAllConnections();
    const startedAt = Date.now();
    try {
      const response = await testSession.fetch('https://github.com/', {
        cache: 'no-store',
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000),
      });
      const latencyMs = Date.now() - startedAt;
      const message = response.ok
        ? `已通过该代理访问 GitHub（HTTP ${response.status}）。`
        : `代理已响应，但 GitHub 返回 HTTP ${response.status}。`;
      state.applicationProxyState = {
        config,
        test: response.ok
          ? {
              checkedAt: Date.now(),
              latencyMs,
              message,
              ok: true,
            }
          : {
              ...reportProxyFailure('external-service', message, {
                status: response.status,
              }),
              checkedAt: Date.now(),
              latencyMs,
              ok: false,
            },
      };
    } catch (error) {
      const message = `代理连接失败：${error instanceof Error ? error.message : '未知网络错误'}`;
      state.applicationProxyState = {
        config,
        test: {
          ...reportProxyFailure('external-service', message, error),
          checkedAt: Date.now(),
          ok: false,
        },
      };
    }
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
    requireApplicationProxyStore().save(input as SaveApplicationProxyInput);
    state.applicationProxyState = undefined;
    await applyApplicationProxyScope();
    await applyConversationProxyScope();
    requireNetworkPreflightService().invalidate('application-proxy-changed');
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
