import { vi, type Mock } from 'vitest';
import type { Registry } from '../../src/main/infra/registry';
import type { MainState } from '../../src/main/ipc/context';
import type { RuntimeProfile } from '../../src/main/app/profile';
import type { WorkspaceState } from '../../src/shared/contracts';
import { createIpcHarness, type IpcHarness } from './ipc-harness';

export interface MainHarness {
  readonly calls: readonly string[];
  readonly constructorCalls: ReadonlyMap<string, readonly unknown[]>;
  readonly dependencies: Record<PropertyKey, unknown>;
  readonly electron: Record<string, unknown>;
  readonly fileExists: Mock;
  readonly ipc: IpcHarness;
  readonly services: Registry;
  readonly state: MainState;
  readonly stubs: Record<string, unknown>;
  restore: () => void;
}

export interface MainHarnessOptions {
  restoreWorkspace?: boolean;
  tray?: boolean;
  workspace?: WorkspaceState;
}

type DeepStub = ((...args: unknown[]) => unknown) & Record<PropertyKey, unknown>;

const createDeepStub = (label: string, calls: string[]): DeepStub => {
  const children = new Map<PropertyKey, unknown>();
  const target = vi.fn((..._args: unknown[]) => {
    calls.push(label);
    return undefined;
  }) as unknown as DeepStub;
  return new Proxy(target, {
    get: (value, property) => {
      if (property === 'then') return undefined;
      if (property in value) return Reflect.get(value, property);
      const existing = children.get(property);
      if (existing) return existing;
      const child = createDeepStub(`${label}.${String(property)}`, calls);
      children.set(property, child);
      return child;
    },
  });
};

const createDependencyContainer = (
  fixed: Record<PropertyKey, unknown>,
  calls: string[],
): Record<PropertyKey, unknown> => {
  const fallback = new Map<PropertyKey, unknown>();
  return new Proxy(fixed, {
    get: (target, property) => {
      if (Reflect.has(target, property)) return Reflect.get(target, property);
      const existing = fallback.get(property);
      if (existing) return existing;
      const stub = createDeepStub(`ipc.${String(property)}`, calls);
      fallback.set(property, stub);
      return stub;
    },
  });
};

const createMainState = (): MainState => ({
  applicationProxyState: undefined,
  chatFetch: fetch,
  isQuitting: false,
  nativeSnapshotFlushTimer: undefined,
  nextPermissionModeProbeId: 1,
  quitCleanupInProgress: false,
  quitConfirmation: undefined,
  quitConfirmationTimer: undefined,
  quitWatchdogTimer: undefined,
  releaseConversationBusy: undefined,
  runtimeShutdownForQuitDone: false,
});

export const createMainHarness = async (options: MainHarnessOptions = {}): Promise<MainHarness> => {
  vi.resetModules();
  const [{ Registry }, { MAIN_WINDOW, registerLifecycleServiceReferences }] = await Promise.all([
    import('../../src/main/infra/registry'),
    import('../../src/main/infra/service-tokens'),
  ]);
  const calls: string[] = [];
  const ipc = createIpcHarness();
  const fileExists = vi.fn(() => false);
  const userData = 'C:\\claudedock-test\\user-data';
  const home = 'C:\\claudedock-test\\home';
  const emptyWorkspace: WorkspaceState = options.workspace ?? {
    activeSessionId: '',
    projects: [],
    sessions: [],
  };

  const fakeSession = {
    fetch: vi.fn(async () => new Response()),
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => undefined),
  };
  const conversationNetworkSession = {
    fetch: vi.fn(async () => new Response()),
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => undefined),
  };
  const app = {
    getAppPath: vi.fn(() => 'C:\\claudedock-test'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    getPath: vi.fn((_name: string) => userData),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    quit: vi.fn(() => calls.push('app.quit')),
    setAppUserModelId: vi.fn(() => calls.push('app.setAppUserModelId')),
    setLoginItemSettings: vi.fn(),
  };
  const shell = {
    openExternal: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(),
  };
  const clipboard = {
    readImage: vi.fn(),
    readText: vi.fn(() => ''),
    writeText: vi.fn(),
  };
  const nativeImage = {
    createFromBuffer: vi.fn(() => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) })),
    createFromDataURL: vi.fn(() => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) })),
    createFromPath: vi.fn(() => ({})),
  };
  const netRequest = vi.fn(() => createDeepStub('electron.net.request', calls));
  const createElectronApplicationRequest = vi.fn(() => createDeepStub('applicationRequest', calls));
  const createElectronSessionFetch = vi.fn(() =>
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  const electron = {
    app,
    BrowserWindow: {
      fromWebContents: vi.fn(() => services.resolve(MAIN_WINDOW).current),
    },
    clipboard,
    ipcMain: ipc.ipcMain,
    nativeImage,
    net: {
      fetch: fakeSession.fetch,
      request: netRequest,
    },
    safeStorage: {
      decryptString: vi.fn(() => ''),
      encryptString: vi.fn(() => Buffer.alloc(0)),
      isEncryptionAvailable: vi.fn(() => true),
    },
    session: {
      defaultSession: fakeSession,
      fromPartition: vi.fn((partition: string) =>
        partition === 'claudedock-conversation-network' ? conversationNetworkSession : fakeSession,
      ),
    },
    shell,
  };

  const downloadEngine = {
    flushJournal: vi.fn(),
    install: vi.fn(() => calls.push('download.install')),
    restoreInterrupted: vi.fn(() => calls.push('download.restoreInterrupted')),
  };
  const applicationProxyStore = {
    getCredentials: vi.fn(() => undefined),
    getView: vi.fn(() => ({
      enabled: false,
      host: '',
      port: 0,
      protocol: 'http',
      scope: { application: false, cli: false, conversation: false },
    })),
  };
  const applicationProxyCoordinator = {
    acquirePreflightLease: vi.fn(
      async (
        scopes: 'application' | 'conversation' | readonly ('application' | 'conversation')[],
      ) => {
        const requested = typeof scopes === 'string' ? [scopes] : scopes;
        const normalized = (['application', 'conversation'] as const).filter((scope) =>
          requested.includes(scope),
        );
        return {
          assertCurrent: vi.fn(),
          epochs: Object.fromEntries(normalized.map((scope) => [scope, `${scope}-epoch`])),
          release: vi.fn(),
          scopes: normalized,
        };
      },
    ),
    captureConfiguration: vi.fn(() => ({
      revision: 'proxy-configuration-revision',
      view: applicationProxyStore.getView(),
    })),
    credentialsForProxy: vi.fn(() => undefined),
    getCliEnvironment: vi.fn(() => ({})),
    getView: applicationProxyStore.getView,
    isConfigurationCurrent: vi.fn(
      (revision: string) => revision === 'proxy-configuration-revision',
    ),
    initialize: vi.fn(async () => calls.push('proxy.initialize')),
    runApplicationProxyTest: vi.fn(),
    save: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  };
  const claudeRuntime = {
    setModelUsageObserver: vi.fn(),
    ownsLaunch: vi.fn(() => false),
    recoverInterruptedRouterInstall: vi.fn(async () => undefined),
    releaseNativeConversation: vi.fn(),
    setConversationLaunchGuard: vi.fn(() => calls.push('claude.setConversationLaunchGuard')),
    setConversationModelResolvers: vi.fn(() => calls.push('claude.setConversationModelResolvers')),
    setLaunchAdmissionGuard: vi.fn(() => calls.push('claude.setLaunchAdmissionGuard')),
    setModelDiscoveryResolvers: vi.fn(() => calls.push('claude.setModelDiscoveryResolvers')),
    setSubscriptionRelayStarter: vi.fn(() => calls.push('claude.setSubscriptionRelayStarter')),
    setSubscriptionAccountIdentityResolver: vi.fn(),
    setPermissionRequestHook: vi.fn(() => calls.push('claude.setPermissionRequestHook')),
    setRuntimeActivityHandler: vi.fn(() => calls.push('claude.setRuntimeActivityHandler')),
    setStreamFailureHandler: vi.fn(() => calls.push('claude.setStreamFailureHandler')),
    shutdown: vi.fn(),
  };
  const nativeConversationService = {
    activeIds: vi.fn(() => []),
    closeAll: vi.fn(async () => undefined),
    discardRecovery: vi.fn(),
    recoverInterrupted: vi.fn(() => []),
  };
  const permissionBridge = {
    closeLaunch: vi.fn(),
    createEndpoint: vi.fn(() => ''),
    fallbackPending: vi.fn(),
    shutdown: vi.fn(),
  };
  const runtimeProcessRegistry = {
    list: vi.fn(() => []),
    start: vi.fn(() => calls.push('runtime-process.start')),
    stop: vi.fn(),
    terminateAll: vi.fn(async () => undefined),
  };
  const streamDiagnosticsStore = { append: vi.fn() };
  const networkPreflightService = { invalidate: vi.fn() };
  const codexRuntime = { dispose: vi.fn() };
  const managedChatGptGateway = {
    cancelSetup: vi.fn(async () => false),
    ensureRunning: vi.fn(async () => {
      calls.push('gateway.ensureRunning');
    }),
    getInstalledVersion: vi.fn(() => undefined),
    getState: vi.fn(async () => ({ running: false })),
    shutdown: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const stubs: Record<string, unknown> = {
    applicationProxyCoordinator,
    applicationProxyStore,
    applicationSession: fakeSession,
    createElectronApplicationRequest,
    createElectronSessionFetch,
    withOfficialProviderAccess: vi.fn(
      async (_request: unknown, operation: () => Promise<unknown> | unknown) => {
        calls.push('guard.withOfficialProviderAccess');
        return operation();
      },
    ),
    claudeRuntime,
    codexRuntime,
    conversationNetworkSession,
    downloadEngine,
    managedChatGptGateway,
    nativeConversationService,
    netRequest,
    networkPreflightService,
    permissionBridge,
    runtimeProcessRegistry,
    streamDiagnosticsStore,
  };

  const constructorCalls = new Map<string, readonly unknown[]>();
  const constructor = (name: string, instance: unknown): Mock =>
    vi.fn(function (...args: unknown[]) {
      calls.push(`construct:${name}`);
      constructorCalls.set(name, args);
      return instance;
    });

  vi.doMock('electron', () => electron);
  vi.doMock('electron-updater', () => ({ autoUpdater: {} }));
  vi.doMock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    existsSync: fileExists,
  }));
  vi.doMock('../../src/main/claude/agent-adapter', () => ({
    ClaudeAgentAdapter: constructor('ClaudeAgentAdapter', {}),
  }));
  vi.doMock('../../src/main/claude/cc-switch-adapter', () => ({
    CcSwitchAdapter: constructor('CcSwitchAdapter', {}),
  }));
  vi.doMock('../../src/main/claude/managed-chatgpt-gateway', () => ({
    ManagedChatGptGateway: constructor('ManagedChatGptGateway', managedChatGptGateway),
  }));
  vi.doMock('../../src/main/claude/permission-bridge', () => ({
    ClaudePermissionBridge: constructor('ClaudePermissionBridge', permissionBridge),
  }));
  vi.doMock('../../src/main/claude/runtime', () => ({
    ClaudeRuntime: constructor('ClaudeRuntime', claudeRuntime),
  }));
  vi.doMock('../../src/main/claude/stream-diagnostics-store', () => ({
    ClaudeStreamDiagnosticsStore: constructor(
      'ClaudeStreamDiagnosticsStore',
      streamDiagnosticsStore,
    ),
  }));
  vi.doMock('../../src/main/codex/runtime', () => ({
    CodexRuntime: constructor('CodexRuntime', codexRuntime),
  }));
  vi.doMock('../../src/main/conversation/fake-adapter', () => ({
    FakeConversationAdapter: constructor('FakeConversationAdapter', {}),
  }));
  vi.doMock('../../src/main/conversation/recovery-store', () => ({
    ConversationRecoveryStore: constructor('ConversationRecoveryStore', {}),
  }));
  vi.doMock('../../src/main/conversation/service', () => ({
    NativeConversationService: constructor('NativeConversationService', nativeConversationService),
  }));
  vi.doMock('../../src/main/download/engine', () => ({
    DownloadEngine: constructor('DownloadEngine', downloadEngine),
  }));
  vi.doMock('../../src/main/mcp/manager', () => ({
    McpManager: constructor('McpManager', {}),
  }));
  vi.doMock('../../src/main/network/diagnostics-store', () => ({
    NetworkDiagnosticsStore: constructor('NetworkDiagnosticsStore', {}),
  }));
  vi.doMock('../../src/main/network/electron-request', () => ({
    createElectronApplicationRequest,
    createElectronSessionFetch,
  }));
  vi.doMock('../../src/main/network/preflight-service', () => ({
    NetworkPreflightService: constructor('NetworkPreflightService', networkPreflightService),
  }));
  vi.doMock('../../src/main/network/provider-access-guard', () => ({
    ProviderAccessGuard: constructor('ProviderAccessGuard', {}),
  }));
  vi.doMock('../../src/main/network/provider-connectivity-probe', () => ({
    ProviderConnectivityProbe: constructor('ProviderConnectivityProbe', {}),
  }));
  vi.doMock('../../src/main/proxy/application-proxy-coordinator', () => ({
    ApplicationProxyCoordinator: constructor(
      'ApplicationProxyCoordinator',
      applicationProxyCoordinator,
    ),
  }));
  vi.doMock('../../src/main/proxy/application-proxy-store', () => ({
    ApplicationProxyStore: constructor('ApplicationProxyStore', applicationProxyStore),
  }));
  vi.doMock('../../src/main/runtime/process-registry', () => ({
    RuntimeProcessRegistry: constructor('RuntimeProcessRegistry', runtimeProcessRegistry),
  }));
  vi.doMock('../../src/main/updates/application', () => ({
    ApplicationUpdaterService: constructor('ApplicationUpdaterService', {}),
  }));

  const services = new Registry();
  registerLifecycleServiceReferences(services);
  const state = createMainState();
  services.resolve(MAIN_WINDOW).current = {
    webContents: ipc.webContents,
  } as Electron.BrowserWindow;

  const workspace = {
    getState: vi.fn(() => emptyWorkspace),
    hasSession: vi.fn(() => false),
    openProject: vi.fn(() => ({ state: emptyWorkspace })),
    setEnvironmentProvider: vi.fn(() => calls.push('workspace.setEnvironmentProvider')),
    shutdown: vi.fn(),
    write: vi.fn(),
  };
  const runtimeActivityRegistry = {
    beginLaunch: vi.fn(),
    consume: vi.fn(),
    get: vi.fn(() => ({ launchGeneration: 0, ptyGeneration: 0, tasks: [] })),
    setPhase: vi.fn(),
    setWebProcesses: vi.fn(),
  };
  const guards = new Proxy(
    {
      withOfficialProviderAccess: stubs.withOfficialProviderAccess,
      requireManagedChatGptGateway: vi.fn(() => managedChatGptGateway),
      validateSender: vi.fn(() => calls.push('ipc.validateSender')),
    },
    {
      get: (target, property) =>
        Reflect.has(target, property)
          ? Reflect.get(target, property)
          : createDeepStub(`guards.${String(property)}`, calls),
    },
  );
  const runtimeProfile: RuntimeProfile = {
    adapterMode: 'fake',
    effects: {
      allowApplicationUpdates: false,
      allowExternalRoutingWrites: false,
      allowPluginMutations: false,
      allowRealRuntimes: false,
      restoreWorkspace: options.restoreWorkspace ?? false,
      singleInstanceLock: false,
      tray: options.tray ?? false,
    },
    id: 'isolated',
    paths: {
      home,
      projects: `${home}\\.claude\\projects`,
      sessionData: `${userData}\\session`,
      userData,
    },
  };
  const workspaceStore = {
    getLastActiveProject: vi.fn(() => undefined),
    getTheme: vi.fn(() => undefined),
  };
  const appPreferencesStore = {
    get: vi.fn(() => ({
      claudeContextWindowCustomTokens: undefined,
      claudeContextWindowMode: 'auto',
      conversationResume: {
        autoLoadLastConversationModelOnStartup: true,
        autoLoadLastConversationOnStartup: true,
        modelMismatchBehavior: 'ask',
      },
      managedChatGptContextWindowMode: 'standard',
      modelUsageFloatingVisible: false,
    })),
    set: vi.fn(),
  };

  const dependencies = createDependencyContainer(
    {
      activateProject: vi.fn(),
      advancedSettingsStore: { get: vi.fn(() => ({ webResearchIsolation: false })) },
      appPreferencesStore,
      artifactService: { install: vi.fn(() => calls.push('artifact.install')) },
      claudeConversationLifecycle: createDeepStub('claudeConversationLifecycle', calls),
      conversationOwnerRegistry: createDeepStub('conversationOwnerRegistry', calls),
      createTray: vi.fn(() => calls.push('tray.create')),
      createWindow: vi.fn(async () => calls.push('window.create')),
      guards,
      nativeAttachmentStore: createDeepStub('nativeAttachmentStore', calls),
      nativeLaunches: new Map(),
      publishClaudeProjectState: vi.fn(),
      publishNativeSnapshot: vi.fn(),
      requestPermissionModeFromScreen: vi.fn(),
      runtimeActivityRegistry,
      runtimeProfile,
      services,
      sessionManager: { getSessionsForProject: vi.fn(() => []) },
      state,
      updateTray: vi.fn(() => calls.push('tray.update')),
      workspace,
      workspaceStore,
    },
    calls,
  );
  Object.assign(dependencies, {
    ipc: dependencies,
    pluginManager: createDeepStub('pluginManager', calls),
  });

  const { createBootstrap } = await import('../../src/main/app/bootstrap');
  await createBootstrap(dependencies as never)();

  return {
    calls,
    constructorCalls,
    dependencies,
    electron,
    fileExists,
    ipc,
    services,
    state,
    stubs,
    restore: () => {
      for (const moduleId of [
        'electron',
        'electron-updater',
        'node:fs',
        '../../src/main/claude/agent-adapter',
        '../../src/main/claude/cc-switch-adapter',
        '../../src/main/claude/managed-chatgpt-gateway',
        '../../src/main/claude/permission-bridge',
        '../../src/main/claude/runtime',
        '../../src/main/claude/stream-diagnostics-store',
        '../../src/main/codex/runtime',
        '../../src/main/conversation/fake-adapter',
        '../../src/main/conversation/recovery-store',
        '../../src/main/conversation/service',
        '../../src/main/download/engine',
        '../../src/main/mcp/manager',
        '../../src/main/network/diagnostics-store',
        '../../src/main/network/electron-request',
        '../../src/main/network/preflight-service',
        '../../src/main/network/provider-access-guard',
        '../../src/main/network/provider-connectivity-probe',
        '../../src/main/proxy/application-proxy-coordinator',
        '../../src/main/proxy/application-proxy-store',
        '../../src/main/runtime/process-registry',
        '../../src/main/updates/application',
      ]) {
        vi.doUnmock(moduleId);
      }
      vi.resetModules();
    },
  };
};
