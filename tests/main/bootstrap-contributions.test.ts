import { describe, expect, it, type Mock, vi } from 'vitest';
import { createMainHarness } from '../helpers/main-harness';

describe('main bootstrap contributions', () => {
  it('runs network, runtime, diagnostics, IPC, and window startup in dependency order', async () => {
    const harness = await createMainHarness();
    try {
      const expectedOrder = [
        'app.setAppUserModelId',
        'artifact.install',
        'construct:DownloadEngine',
        'download.install',
        'construct:ApplicationProxyCoordinator',
        'proxy.initialize',
        'construct:RuntimeProcessRegistry',
        'construct:ClaudeRuntime',
        'construct:NativeConversationService',
        'construct:NetworkPreflightService',
        'runtime-process.start',
        'window.create',
      ];

      expect(harness.calls.filter((call) => expectedOrder.includes(call))).toEqual(expectedOrder);
      expect(harness.constructorCalls.has('McpManager')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('registers one lazy installation provider and aliases the launch resolver to the settings service', async () => {
    const harness = await createMainHarness();
    const { claudeExecutionInstallationProvider } =
      await import('../../src/main/claude/execution-settings-installation');
    const {
      CLAUDE_EXECUTION_INSTALLATION_PROVIDER,
      CLAUDE_EXECUTION_SETTINGS_LAUNCH_RESOLVER,
      CLAUDE_EXECUTION_SETTINGS_SERVICE,
    } = await import('../../src/main/infra/service-tokens');
    const installationRead = vi.spyOn(claudeExecutionInstallationProvider, 'getInstallation');
    try {
      const provider = harness.services.resolve(CLAUDE_EXECUTION_INSTALLATION_PROVIDER);
      const service = harness.services.resolve(CLAUDE_EXECUTION_SETTINGS_SERVICE);
      const launchResolver = harness.services.resolve(CLAUDE_EXECUTION_SETTINGS_LAUNCH_RESOLVER);

      expect(provider).toBe(claudeExecutionInstallationProvider);
      expect(launchResolver).toBe(service);
      expect(installationRead).not.toHaveBeenCalled();
    } finally {
      installationRead.mockRestore();
      harness.restore();
    }
  });

  it('injects the main routing-write gate into the shared application proxy coordinator', async () => {
    const harness = await createMainHarness();
    try {
      const options = harness.constructorCalls.get('ApplicationProxyCoordinator')?.[0] as
        { assertExternalRoutingWritesAllowed?: () => void } | undefined;
      expect(options?.assertExternalRoutingWritesAllowed).toEqual(expect.any(Function));
      options?.assertExternalRoutingWritesAllowed?.();
      expect(harness.calls).toContain('guards.assertExternalRoutingWritesAllowed');
    } finally {
      harness.restore();
    }
  });

  it('binds preflight requests and proxy resolution to the selected Electron scope', async () => {
    const harness = await createMainHarness();
    try {
      const probeOptions = harness.constructorCalls.get('ProviderConnectivityProbe')?.[0] as
        | {
            applicationRequestForScope: (scope: 'application' | 'conversation') => unknown;
            resolveProxy: (url: string, scope: 'application' | 'conversation') => Promise<string>;
          }
        | undefined;
      const serviceOptions = harness.constructorCalls.get('NetworkPreflightService')?.[0] as
        | {
            acquireNetworkLease: (
              scopes: 'application' | 'conversation' | readonly ('application' | 'conversation')[],
            ) => Promise<unknown>;
          }
        | undefined;
      if (!probeOptions || !serviceOptions) {
        throw new Error('Network preflight constructor options were not captured.');
      }
      expect(probeOptions).not.toHaveProperty('appFetch');
      const applicationSession = harness.stubs.applicationSession as {
        fetch: Mock;
        resolveProxy: Mock;
      };
      const conversationSession = harness.stubs.conversationNetworkSession as {
        fetch: Mock;
        resolveProxy: Mock;
      };
      const { createElectronApplicationRequest } =
        await import('../../src/main/network/electron-request');
      const createRequest = createElectronApplicationRequest as Mock;

      await probeOptions.resolveProxy('https://example.test/application', 'application');
      await probeOptions.resolveProxy('https://example.test/conversation', 'conversation');
      expect(applicationSession.resolveProxy).toHaveBeenCalledWith(
        'https://example.test/application',
      );
      expect(conversationSession.resolveProxy).toHaveBeenCalledWith(
        'https://example.test/conversation',
      );

      probeOptions.applicationRequestForScope('application');
      const applicationAdapter = createRequest.mock.calls.at(-1)?.[0] as
        | {
            fetch: (input: string, init?: RequestInit) => Promise<Response>;
          }
        | undefined;
      await applicationAdapter?.fetch('https://example.test/application', {
        redirect: 'manual',
      });
      expect(applicationSession.fetch).toHaveBeenLastCalledWith(
        'https://example.test/application',
        { redirect: 'manual' },
      );

      probeOptions.applicationRequestForScope('conversation');
      const conversationAdapter = createRequest.mock.calls.at(-1)?.[0] as
        | {
            fetch: (input: string, init?: RequestInit) => Promise<Response>;
          }
        | undefined;
      await conversationAdapter?.fetch('https://example.test/conversation', {
        redirect: 'manual',
      });
      expect(conversationSession.fetch).toHaveBeenLastCalledWith(
        'https://example.test/conversation',
        { redirect: 'manual' },
      );
      const proxyCoordinator = harness.stubs.applicationProxyCoordinator as {
        acquirePreflightLease: Mock;
        subscribe: Mock;
      };
      const preflightService = harness.stubs.networkPreflightService as {
        invalidate: Mock;
      };
      await serviceOptions.acquireNetworkLease(['application', 'conversation']);
      expect(proxyCoordinator.acquirePreflightLease).toHaveBeenCalledWith([
        'application',
        'conversation',
      ]);
      const onProxyTransition = proxyCoordinator.subscribe.mock.calls[0]?.[0] as
        ((scope: 'application' | 'conversation') => void) | undefined;
      onProxyTransition?.('conversation');
      expect(preflightService.invalidate).toHaveBeenCalledWith(
        'application-proxy-conversation-transition',
      );
    } finally {
      harness.restore();
    }
  });

  it('injects exact-session authenticated fetch adapters into every main-process consumer', async () => {
    const harness = await createMainHarness();
    try {
      const createFetch = harness.stubs.createElectronSessionFetch as Mock;
      const applicationSession = harness.stubs.applicationSession;
      const conversationSession = harness.stubs.conversationNetworkSession;
      const adapterSession = (adapter: unknown): unknown => {
        const index = createFetch.mock.results.findIndex((result) => result.value === adapter);
        return index < 0
          ? undefined
          : (createFetch.mock.calls[index]?.[0] as { session?: unknown } | undefined)?.session;
      };
      const ccSwitchFetch = harness.constructorCalls.get('CcSwitchAdapter')?.[4];
      const managedGatewayFetch = harness.constructorCalls.get('ManagedChatGptGateway')?.[4];
      const claudeRuntimeFetch = harness.constructorCalls.get('ClaudeRuntime')?.[12];
      const codexRuntimeFetch = harness.constructorCalls.get('CodexRuntime')?.[5];
      expect(harness.constructorCalls.has('McpManager')).toBe(false);
      const { MCP_MANAGER } = await import('../../src/main/infra/service-tokens');
      harness.services.resolve(MCP_MANAGER);
      const registryService = harness.constructorCalls.get('McpManager')?.[3] as
        | {
            client?: { fetchImplementation?: unknown };
            store?: { storagePath?: string };
          }
        | undefined;
      const registryFetch = registryService?.client?.fetchImplementation;

      expect(harness.calls.filter((call) => call === 'construct:McpManager')).toHaveLength(1);
      expect(adapterSession(registryFetch)).toBe(applicationSession);
      expect(registryService?.store?.storagePath).toBe(
        'C:\\claudedock-test\\user-data\\mcp\\registry-snapshot.json',
      );
      expect(adapterSession(ccSwitchFetch)).toBe(applicationSession);
      expect(adapterSession(managedGatewayFetch)).toBe(applicationSession);
      expect(adapterSession(claudeRuntimeFetch)).toBe(applicationSession);
      expect(adapterSession(codexRuntimeFetch)).toBe(applicationSession);
      expect(adapterSession(harness.state.chatFetch)).toBe(conversationSession);
      expect(createFetch).toHaveBeenCalledTimes(6);

      const applicationOptions = createFetch.mock.calls.find(
        ([options]) => (options as { session?: unknown }).session === applicationSession,
      )?.[0] as
        | {
            resolveProxyCredentials: (context: {
              authInfo: { host: string; isProxy: boolean; port: number };
              session: unknown;
            }) => unknown;
          }
        | undefined;
      const proxyCoordinator = harness.stubs.applicationProxyCoordinator as {
        credentialsForProxy: Mock;
      };
      proxyCoordinator.credentialsForProxy.mockReturnValue({
        password: 'secret',
        username: 'alice',
      });
      expect(
        applicationOptions?.resolveProxyCredentials({
          authInfo: { host: 'Proxy.Example', isProxy: true, port: 7890 },
          session: applicationSession,
        }),
      ).toEqual({ password: 'secret', username: 'alice' });
      expect(
        applicationOptions?.resolveProxyCredentials({
          authInfo: { host: 'Proxy.Example', isProxy: false, port: 7890 },
          session: applicationSession,
        }),
      ).toBeUndefined();
      expect(
        applicationOptions?.resolveProxyCredentials({
          authInfo: { host: 'Proxy.Example', isProxy: true, port: 7890 },
          session: conversationSession,
        }),
      ).toBeUndefined();
      expect(proxyCoordinator.credentialsForProxy).toHaveBeenCalledOnce();
      expect(proxyCoordinator.credentialsForProxy).toHaveBeenCalledWith(
        applicationSession,
        'Proxy.Example',
        7890,
      );
    } finally {
      harness.restore();
    }
  });

  it('gives managed OAuth and sidecar processes the selected CLI proxy environment', async () => {
    const harness = await createMainHarness();
    try {
      const environmentProvider = harness.constructorCalls.get('ManagedChatGptGateway')?.[5];
      const proxyCoordinator = harness.stubs.applicationProxyCoordinator as {
        getCliEnvironment: Mock;
      };
      if (typeof environmentProvider !== 'function') {
        throw new Error('Managed gateway environment provider was not captured.');
      }
      proxyCoordinator.getCliEnvironment.mockReturnValue({
        HTTPS_PROXY: 'http://proxy-user:secret@127.0.0.1:7890',
        HTTP_PROXY: 'http://proxy-user:secret@127.0.0.1:7890',
        NO_PROXY: '127.0.0.1,localhost,::1',
      });

      expect((environmentProvider as () => Record<string, unknown>)()).toMatchObject({
        HTTPS_PROXY: 'http://proxy-user:secret@127.0.0.1:7890',
        HTTP_PROXY: 'http://proxy-user:secret@127.0.0.1:7890',
        NO_PROXY: expect.stringContaining('127.0.0.1'),
      });
      expect(proxyCoordinator.getCliEnvironment).toHaveBeenCalledOnce();
    } finally {
      harness.restore();
    }
  });

  it('authorizes the exact project before managed gateway readiness', async () => {
    const harness = await createMainHarness();
    try {
      const readiness = harness.constructorCalls.get('ClaudeRuntime')?.[10];
      const withOfficialProviderAccess = harness.stubs.withOfficialProviderAccess as Mock;
      const managedChatGptGateway = harness.stubs.managedChatGptGateway as {
        ensureRunning: Mock;
      };
      if (typeof readiness !== 'function') {
        throw new Error('ClaudeRuntime readiness callback was not captured.');
      }
      const routeEvents: string[] = [];
      let providerAccessActive = false;
      withOfficialProviderAccess.mockImplementation(
        async (_request: unknown, operation: () => Promise<unknown> | unknown) => {
          routeEvents.push('guard-enter');
          providerAccessActive = true;
          try {
            return await operation();
          } finally {
            providerAccessActive = false;
            routeEvents.push('guard-exit');
          }
        },
      );
      managedChatGptGateway.ensureRunning.mockImplementation(async () => {
        expect(providerAccessActive).toBe(true);
        routeEvents.push('gateway-ensure-running');
      });

      expect(withOfficialProviderAccess).not.toHaveBeenCalled();
      expect(managedChatGptGateway.ensureRunning).not.toHaveBeenCalled();

      await (readiness as (cwd: string) => Promise<void>)('D:\\Project');

      expect(withOfficialProviderAccess).toHaveBeenCalledWith(
        {
          action: 'first-request',
          cwd: 'D:\\Project',
          provider: 'openai-codex',
        },
        expect.any(Function),
      );
      expect(routeEvents).toEqual(['guard-enter', 'gateway-ensure-running', 'guard-exit']);
      expect(providerAccessActive).toBe(false);

      withOfficialProviderAccess.mockRejectedValueOnce(new Error('network blocked'));
      await expect(
        (readiness as (cwd: string) => Promise<void>)('D:\\Other Project'),
      ).rejects.toThrow('network blocked');
      expect(withOfficialProviderAccess).toHaveBeenNthCalledWith(
        2,
        {
          action: 'first-request',
          cwd: 'D:\\Other Project',
          provider: 'openai-codex',
        },
        expect.any(Function),
      );
      expect(managedChatGptGateway.ensureRunning).toHaveBeenCalledOnce();
      expect(routeEvents).toEqual(['guard-enter', 'gateway-ensure-running', 'guard-exit']);
    } finally {
      harness.restore();
    }
  });
});
