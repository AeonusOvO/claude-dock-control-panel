import { getClaudeExecutionProfile } from '../../shared/claude/execution-profiles';
import { CHANNELS } from '../../shared/ipc/channels';
import { app, net, safeStorage, session, shell, type Session } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TerminalStatus } from '../../shared/contracts';
import { DEFAULT_TERMINAL_THEME } from '../../shared/ui/terminal-themes';
import { ArtifactService } from '../artifact/service';
import { ClaudeAgentAdapter } from '../claude/agent-adapter';
import { CcSwitchAdapter } from '../claude/cc-switch-adapter';
import { ClaudeConversationLifecycleCoordinator } from '../claude/conversation-lifecycle';
import { applyConversationModelConnection } from '../claude/conversation-model-application';
import { resolveClaudeExecutionCapabilities } from '../claude/execution-settings-capabilities';
import { claudeExecutionInstallationProvider } from '../claude/execution-settings-installation';
import { ClaudeExecutionSettingsService } from '../claude/execution-settings-service';
import { ClaudeExecutionSettingsStore } from '../claude/execution-settings-store';
import { ManagedChatGptGateway } from '../claude/managed-chatgpt-gateway';
import { ClaudePermissionBridge } from '../claude/permission-bridge';
import type { PermissionModeProbes } from '../claude/permission-mode-probe';
import { ClaudeRuntime } from '../claude/runtime';
import { ClaudeSessionManager } from '../claude/session-manager';
import type { ClaudeStatePublisher } from '../claude/state-publisher';
import { ClaudeStreamDiagnosticsStore } from '../claude/stream-diagnostics-store';
import { CodexRuntime } from '../codex/runtime';
import { NativeAttachmentStore } from '../conversation/attachment-store';
import { FakeConversationAdapter } from '../conversation/fake-adapter';
import type { ConversationOwnerRegistry } from '../conversation/owner-registry';
import { ConversationRecoveryStore } from '../conversation/recovery-store';
import { NativeConversationService } from '../conversation/service';
import type { PublishNativeSnapshot } from '../conversation/snapshot-publisher';
import { BusyRegistry } from '../coordination/busy-registry';
import { DownloadEngine, type DownloadSession } from '../download/engine';
import { runStartupContributions, type StartupContribution } from '../infra/contributions';
import { MainDiagnostics } from '../infra/diagnostics';
import { mainLogger } from '../infra/logger';
import type { Registry } from '../infra/registry';
import {
  APPLICATION_PROXY_COORDINATOR,
  APPLICATION_PROXY_TEST_SESSION,
  APPLICATION_UPDATER_SERVICE,
  BUSY_REGISTRY,
  CC_SWITCH_ADAPTER,
  CLAUDE_EXECUTION_INSTALLATION_PROVIDER,
  CLAUDE_EXECUTION_SETTINGS_LAUNCH_RESOLVER,
  CLAUDE_EXECUTION_SETTINGS_SERVICE,
  CLAUDE_PERMISSION_BRIDGE,
  CLAUDE_RUNTIME,
  CLAUDE_STREAM_DIAGNOSTICS_STORE,
  CODEX_RUNTIME,
  CONVERSATION_NETWORK_SESSION,
  DOWNLOAD_ENGINE,
  MAIN_DIAGNOSTICS,
  MAIN_LOGGER,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MCP_MANAGER,
  NATIVE_CONVERSATION_SERVICE,
  NETWORK_DIAGNOSTICS_STORE,
  NETWORK_PREFLIGHT_SERVICE,
  PROVIDER_ACCESS_GUARD,
  RUNTIME_PROCESS_REGISTRY,
} from '../infra/service-tokens';
import type { MainState } from '../ipc/context';
import type { NativeConversationLaunch } from '../ipc/conversation';
import type { MainGuards } from '../ipc/guards';
import { registerIpc, type MainIpcDependencies } from '../ipc';
import { McpManager } from '../mcp/manager';
import { McpRegistryClient } from '../mcp/registry-client';
import { McpRegistrySyncService } from '../mcp/registry-service';
import { McpRegistrySnapshotStore } from '../mcp/registry-snapshot';
import { ClaudeLaunchHealthMonitor } from '../network/claude-launch-health-monitor';
import { NetworkDiagnosticsStore } from '../network/diagnostics-store';
import { NetworkEnvironmentRiskProbe } from '../network/environment-risk-probe';
import {
  createElectronApplicationRequest,
  createElectronSessionFetch,
  type ElectronRedirectPolicy,
} from '../network/electron-request';
import { NetworkPreflightService } from '../network/preflight-service';
import { ProviderAccessGuard } from '../network/provider-access-guard';
import { ProviderConnectivityProbe } from '../network/provider-connectivity-probe';
import { applicationProxyUrl } from '../proxy/application-proxy';
import { ApplicationProxyCoordinator } from '../proxy/application-proxy-coordinator';
import { ApplicationProxyStore } from '../proxy/application-proxy-store';
import { RuntimeActivityRegistry } from '../runtime/activity-registry';
import { RuntimeProcessRegistry } from '../runtime/process-registry';
import {
  networkPreflightProcessEnvironment,
  type AdvancedSettingsStore,
} from '../stores/advanced-settings';
import type { AppPreferencesStore } from '../stores/app-preferences';
import type { WorkspaceStore } from '../stores/workspace';
import type { ProjectOperations } from '../terminal/project-operations';
import type { TerminalWorkspace } from '../terminal/workspace';
import { ApplicationUpdaterService, type ApplicationUpdaterDriver } from '../updates/application';
import { runtimeAssetPath } from './paths';
import type { RuntimeProfile } from './profile';
import { restoreLastConversationModelOnly } from './startup-model-restore';
import type { TrayController } from './tray';
import type { WindowController } from './window';

export interface BootstrapDependencies {
  activateProject: ProjectOperations['activateProject'];
  advancedSettingsStore: AdvancedSettingsStore;
  appPreferencesStore: AppPreferencesStore;
  artifactService: ArtifactService;
  claudeConversationLifecycle: ClaudeConversationLifecycleCoordinator;
  conversationOwnerRegistry: ConversationOwnerRegistry;
  createTray: TrayController['createTray'];
  createWindow: WindowController['createWindow'];
  guards: Pick<
    MainGuards,
    | 'assertExternalRoutingWritesAllowed'
    | 'assertLaunchAdmissionAllowed'
    | 'requireManagedChatGptGateway'
    | 'withOfficialProviderAccess'
  >;
  /** The one container every IPC slice draws from; assembled once and forwarded unchanged. */
  ipc: MainIpcDependencies;
  launchHealthMonitor: ClaudeLaunchHealthMonitor;
  nativeAttachmentStore: NativeAttachmentStore;
  nativeLaunches: Map<string, NativeConversationLaunch>;
  publishClaudeProjectState: ClaudeStatePublisher['publishClaudeProjectState'];
  publishNativeSnapshot: PublishNativeSnapshot;
  requestPermissionModeFromScreen: PermissionModeProbes['requestPermissionModeFromScreen'];
  runtimeActivityRegistry: RuntimeActivityRegistry;
  runtimeProfile: RuntimeProfile;
  services: Registry;
  sessionManager: ClaudeSessionManager;
  state: MainState;
  updateTray: TrayController['updateTray'];
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

type NetworkServiceBootstrap = Pick<
  BootstrapDependencies,
  | 'advancedSettingsStore'
  | 'guards'
  | 'runtimeProfile'
  | 'services'
  | 'state'
  | 'updateTray'
  | 'workspace'
>;

type AgentRuntimeBootstrap = Pick<
  BootstrapDependencies,
  | 'advancedSettingsStore'
  | 'appPreferencesStore'
  | 'claudeConversationLifecycle'
  | 'conversationOwnerRegistry'
  | 'guards'
  | 'launchHealthMonitor'
  | 'nativeAttachmentStore'
  | 'nativeLaunches'
  | 'publishClaudeProjectState'
  | 'publishNativeSnapshot'
  | 'requestPermissionModeFromScreen'
  | 'runtimeActivityRegistry'
  | 'runtimeProfile'
  | 'services'
  | 'sessionManager'
  | 'workspace'
  | 'workspaceStore'
>;

type DiagnosticsBootstrap = Pick<
  BootstrapDependencies,
  | 'advancedSettingsStore'
  | 'runtimeActivityRegistry'
  | 'runtimeProfile'
  | 'services'
  | 'state'
  | 'workspace'
>;

const managedChatGptConversationAccount = async (gateway: ManagedChatGptGateway) => {
  const state = await gateway.getState();
  return {
    ...(state.accountEmail ? { accountIdentity: state.accountEmail } : {}),
    ...(state.authenticated ? { authMethod: 'ChatGPT OAuth 订阅' } : {}),
  };
};

const ensureManagedChatGptGatewayStarted = async (
  gateway: ManagedChatGptGateway,
): Promise<boolean> => {
  const wasRunning = (await gateway.getState()).running;
  await gateway.ensureRunning();
  return !wasRunning;
};

const configureConversationModels = (
  runtime: ClaudeRuntime,
  requireGateway: () => ManagedChatGptGateway,
  preferences: AppPreferencesStore,
): void => {
  runtime.setConversationModelResolvers({
    managedChatGptAccount: () => managedChatGptConversationAccount(requireGateway()),
    preference: () => preferences.get().conversationResume.modelMismatchBehavior,
  });
};

const combinedCliEnvironment = (
  advancedSettingsStore: AdvancedSettingsStore,
  coordinator: ApplicationProxyCoordinator,
): Record<string, null | string> => ({
  ...coordinator.getCliEnvironment(),
  ...networkPreflightProcessEnvironment(advancedSettingsStore.get()),
});

const installClaudeExecutionSettings = ({
  runtimeProfile,
  services,
}: Pick<BootstrapDependencies, 'runtimeProfile' | 'services'>): void => {
  services.register(
    CLAUDE_EXECUTION_INSTALLATION_PROVIDER,
    () => claudeExecutionInstallationProvider,
  );
  services.register(
    CLAUDE_EXECUTION_SETTINGS_SERVICE,
    (registry) =>
      new ClaudeExecutionSettingsService({
        capabilityResolver: resolveClaudeExecutionCapabilities,
        installationProvider: registry.resolve(CLAUDE_EXECUTION_INSTALLATION_PROVIDER),
        profileLookup: getClaudeExecutionProfile,
        store: new ClaudeExecutionSettingsStore(runtimeProfile.paths.userData),
      }),
  );
  services.register(CLAUDE_EXECUTION_SETTINGS_LAUNCH_RESOLVER, (registry) =>
    registry.resolve(CLAUDE_EXECUTION_SETTINGS_SERVICE),
  );

  services.resolve(CLAUDE_EXECUTION_INSTALLATION_PROVIDER);
  services.resolve(CLAUDE_EXECUTION_SETTINGS_SERVICE);
  services.resolve(CLAUDE_EXECUTION_SETTINGS_LAUNCH_RESOLVER);
};

const createAuthenticatedSessionFetch = (
  services: Registry,
  electronSession: Session,
  authorizeRedirect?: ElectronRedirectPolicy,
): typeof fetch =>
  createElectronSessionFetch({
    ...(authorizeRedirect ? { authorizeRedirect } : {}),
    requestFactory: (options) => net.request(options),
    resolveProxyCredentials: ({ authInfo, session: requestingSession }) =>
      authInfo.isProxy && requestingSession === electronSession
        ? services
            .resolve(APPLICATION_PROXY_COORDINATOR)
            .credentialsForProxy(requestingSession, authInfo.host, authInfo.port)
        : undefined,
    session: electronSession,
  });

/**
 * Downloads, gateways and proxy scope come first: every runtime below launches through the network
 * path selected here, and restoring interrupted work before the path is stable would use the wrong one.
 */
const installNetworkServices = async ({
  advancedSettingsStore,
  guards: { assertExternalRoutingWritesAllowed },
  runtimeProfile,
  services,
  state,
  updateTray,
  workspace,
}: NetworkServiceBootstrap): Promise<void> => {
  const applicationProxyStore = new ApplicationProxyStore(app.getPath('userData'), safeStorage);
  services.register(
    BUSY_REGISTRY,
    () =>
      new BusyRegistry((leases) => {
        services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.BUSY_CHANGED, leases);
        updateTray();
      }),
  );
  services.register(MCP_MANAGER, (registry) => {
    const registryClient = new McpRegistryClient({
      fetch: createAuthenticatedSessionFetch(registry, session.defaultSession),
    });
    const registryStore = new McpRegistrySnapshotStore(runtimeProfile.paths.userData);
    const registryService = new McpRegistrySyncService(registryClient, registryStore);
    return new McpManager(
      runtimeProfile.paths.home,
      runtimeProfile.paths.userData,
      registry.resolve(BUSY_REGISTRY),
      registryService,
    );
  });
  services.register(DOWNLOAD_ENGINE, (registry) => {
    const downloadEngine = new DownloadEngine(
      session.defaultSession as unknown as DownloadSession,
      registry.resolve(BUSY_REGISTRY),
      app.getPath('userData'),
      (tasks) => {
        services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.DOWNLOAD_CHANGED, tasks);
      },
    );
    downloadEngine.install();
    return downloadEngine;
  });
  services.register(
    CC_SWITCH_ADAPTER,
    (registry) =>
      new CcSwitchAdapter(
        app.getPath('userData'),
        registry.resolve(DOWNLOAD_ENGINE),
        registry.resolve(BUSY_REGISTRY),
        (url) => shell.openExternal(url),
        createAuthenticatedSessionFetch(registry, session.defaultSession),
      ),
  );
  services.register(
    MANAGED_CHATGPT_GATEWAY,
    (registry) =>
      new ManagedChatGptGateway(
        app.getPath('userData'),
        registry.resolve(DOWNLOAD_ENGINE),
        registry.resolve(BUSY_REGISTRY),
        safeStorage,
        createAuthenticatedSessionFetch(registry, session.defaultSession),
        () =>
          combinedCliEnvironment(
            advancedSettingsStore,
            registry.resolve(APPLICATION_PROXY_COORDINATOR),
          ),
      ),
  );
  services.register(CONVERSATION_NETWORK_SESSION, () =>
    session.fromPartition('claudedock-conversation-network'),
  );
  services.register(
    APPLICATION_PROXY_COORDINATOR,
    (registry) =>
      new ApplicationProxyCoordinator({
        applicationSession: session.defaultSession,
        assertExternalRoutingWritesAllowed,
        conversationSession: registry.resolve(CONVERSATION_NETWORK_SESSION),
        store: applicationProxyStore,
      }),
  );
  services.register(APPLICATION_PROXY_TEST_SESSION, () =>
    session.fromPartition('claudedock-application-proxy-test'),
  );

  services.resolve(BUSY_REGISTRY);
  // Registry snapshot validation is deferred until the first MCP catalog request, off the startup path.
  const downloadEngine = services.resolve(DOWNLOAD_ENGINE);
  services.resolve(CC_SWITCH_ADAPTER);
  services.resolve(MANAGED_CHATGPT_GATEWAY);
  const conversationNetworkSession = services.resolve(CONVERSATION_NETWORK_SESSION);
  const applicationProxyCoordinator = services.resolve(APPLICATION_PROXY_COORDINATOR);
  services.resolve(APPLICATION_PROXY_TEST_SESSION);

  state.chatFetch = createAuthenticatedSessionFetch(services, conversationNetworkSession);
  await applicationProxyCoordinator.initialize();
  // Restore only after the selected application network path is stable.
  if (runtimeProfile.effects.restoreWorkspace) {
    downloadEngine.restoreInterrupted();
  }
  workspace.setEnvironmentProvider(() =>
    combinedCliEnvironment(advancedSettingsStore, applicationProxyCoordinator),
  );
};

const reconcileInterruptedNativeConversations = (
  nativeConversationService: NativeConversationService,
  sessionManager: ClaudeSessionManager,
): void => {
  const interrupted = nativeConversationService.recoverInterrupted();
  // rc.2 could leave a recovery row when the adapter failed before Claude created a transcript.
  // Reconcile empty reservations against Claude's canonical JSONL index without touching history.
  for (const recovery of interrupted) {
    if (
      recovery.submissions.length === 0 &&
      !sessionManager
        .getSessionsForProject(recovery.projectPath)
        .some((session) => session.conversationId === recovery.conversationId)
    ) {
      nativeConversationService.discardRecovery(recovery.conversationId, recovery.projectPath);
    }
  }
};

const installClaudeStreamFailureHandler = (
  claudeRuntime: ClaudeRuntime,
  runtimeActivityRegistry: RuntimeActivityRegistry,
  streamDiagnosticsStore: ClaudeStreamDiagnosticsStore,
): void => {
  claudeRuntime.setStreamFailureHandler((observation) => {
    const activity = runtimeActivityRegistry.get(observation.sessionId);
    streamDiagnosticsStore.append({
      ...observation,
      backgroundTaskCount: activity.tasks.filter(
        (task) =>
          task.status === 'queued' || task.status === 'running' || task.status === 'waiting',
      ).length,
    });
    runtimeActivityRegistry.setPhase(observation.sessionId, 'failed');
  });
};

const registerClaudePermissionBridge = (services: Registry): void => {
  services.register(
    CLAUDE_PERMISSION_BRIDGE,
    () =>
      new ClaudePermissionBridge(
        (request) => {
          const target = services.resolve(MAIN_WINDOW).current?.webContents;
          if (!target || target.isDestroyed() || target.isCrashed()) return false;
          target.send(CHANNELS.CLAUDE_PERMISSION_REQUEST, request);
          return true;
        },
        (sessionId, launchGeneration) =>
          services.resolve(CLAUDE_RUNTIME).ownsLaunch(sessionId, launchGeneration),
      ),
  );
};

/**
 * Both agent runtimes and everything that observes them, in one place: the permission hook, the stream
 * diagnostics sink, the activity feed and the native conversation service all need the Claude runtime
 * that is created here, and the native adapter's environment is only complete once it exists.
 */
const installAgentRuntimes = ({
  advancedSettingsStore,
  appPreferencesStore,
  claudeConversationLifecycle,
  conversationOwnerRegistry,
  guards: {
    assertLaunchAdmissionAllowed,
    requireManagedChatGptGateway,
    withOfficialProviderAccess,
  },
  launchHealthMonitor,
  nativeAttachmentStore,
  nativeLaunches,
  publishClaudeProjectState,
  publishNativeSnapshot,
  requestPermissionModeFromScreen,
  runtimeActivityRegistry,
  runtimeProfile,
  services,
  sessionManager,
  workspace,
  workspaceStore,
}: AgentRuntimeBootstrap): void => {
  const cliEnvironment = () =>
    combinedCliEnvironment(advancedSettingsStore, services.resolve(APPLICATION_PROXY_COORDINATOR));
  services.register(
    RUNTIME_PROCESS_REGISTRY,
    () =>
      new RuntimeProcessRegistry((sessionId, processes) => {
        if (!workspace.hasSession(sessionId)) return;
        const status = workspace.getStatus(sessionId);
        const activity = runtimeActivityRegistry.get(sessionId);
        if (activity.ptyGeneration !== status.ptyGeneration) {
          runtimeActivityRegistry.beginLaunch(
            sessionId,
            activity.launchGeneration,
            status.ptyGeneration,
          );
        }
        runtimeActivityRegistry.setWebProcesses(sessionId, processes);
      }),
  );
  services.register(
    CLAUDE_RUNTIME,
    (registry) =>
      new ClaudeRuntime(
        app.getPath('userData'),
        runtimeAssetPath('claude-statusline.ps1'),
        runtimeAssetPath('claude-runtime-signal.ps1'),
        runtimeAssetPath('claude-web-search-guard.ps1'),
        () => advancedSettingsStore.get().webResearchIsolation,
        () => appPreferencesStore.get().managedChatGptContextWindowMode,
        () => ({
          customTokens: appPreferencesStore.get().claudeContextWindowCustomTokens,
          mode: appPreferencesStore.get().claudeContextWindowMode,
        }),
        (state) => publishClaudeProjectState(state),
        (sessionId, ptyGeneration, data) => workspace.write(sessionId, ptyGeneration, data),
        requestPermissionModeFromScreen,
        (cwd) =>
          withOfficialProviderAccess(
            { action: 'first-request', cwd, provider: 'openai-codex' },
            () => ensureManagedChatGptGatewayStarted(requireManagedChatGptGateway()),
          ),
        () => requireManagedChatGptGateway().getInstalledVersion(),
        createAuthenticatedSessionFetch(registry, session.defaultSession),
        workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME,
        (progress) => {
          services
            .resolve(MAIN_WINDOW)
            .current?.webContents.send(CHANNELS.ROUTER_OPERATION_PROGRESS, progress);
        },
        () => requireManagedChatGptGateway().stop(),
        cliEnvironment,
        registry.resolve(CLAUDE_EXECUTION_SETTINGS_LAUNCH_RESOLVER),
      ),
  );

  services.resolve(RUNTIME_PROCESS_REGISTRY);
  const claudeRuntime = services.resolve(CLAUDE_RUNTIME);
  claudeRuntime.setLaunchAdmissionGuard(assertLaunchAdmissionAllowed);
  configureConversationModels(claudeRuntime, requireManagedChatGptGateway, appPreferencesStore);
  const nativeAdapter =
    runtimeProfile.adapterMode === 'fake'
      ? new FakeConversationAdapter()
      : new ClaudeAgentAdapter({
          appVersion: app.getVersion(),
          environment: (input) => {
            const launch = nativeLaunches.get(input.conversationId);
            if (!launch) throw new Error('原生对话的接入环境尚未准备完成。');
            return {
              ...launch.prepared.environment,
              ...cliEnvironment(),
            };
          },
        });
  services.register(
    NATIVE_CONVERSATION_SERVICE,
    () =>
      new NativeConversationService({
        adapter: nativeAdapter,
        assertLaunchAdmissionAllowed,
        onSnapshot: (snapshot) => {
          publishNativeSnapshot(snapshot);
          if (snapshot.phase === 'failed' || snapshot.phase === 'stopped') {
            const launch = nativeLaunches.get(snapshot.conversationId);
            if (launch) {
              services.resolve(CLAUDE_RUNTIME).releaseNativeConversation(launch.ownerId);
              nativeLaunches.delete(snapshot.conversationId);
            }
          }
        },
        onSubmissionConfirmed: async (conversationId, attachmentIds) => {
          await Promise.all(
            attachmentIds.map((attachmentId) =>
              nativeAttachmentStore.remove(conversationId, attachmentId),
            ),
          );
        },
        ownerRegistry: conversationOwnerRegistry,
        recoveryStore: new ConversationRecoveryStore(runtimeProfile.paths.userData, safeStorage),
        runtime: 'claude',
      }),
  );
  const nativeConversationService = services.resolve(NATIVE_CONVERSATION_SERVICE);
  reconcileInterruptedNativeConversations(nativeConversationService, sessionManager);

  registerClaudePermissionBridge(services);
  services.register(
    CLAUDE_STREAM_DIAGNOSTICS_STORE,
    () => new ClaudeStreamDiagnosticsStore(app.getPath('userData')),
  );
  services.register(
    CODEX_RUNTIME,
    (registry) =>
      new CodexRuntime(
        app.getPath('userData'),
        (state) => {
          if (workspace.hasSession(state.sessionId)) {
            services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.CODEX_STATE, state);
          }
        },
        (sessionId, ptyGeneration, data) => workspace.write(sessionId, ptyGeneration, data),
        registry.resolve(DOWNLOAD_ENGINE),
        registry.resolve(BUSY_REGISTRY),
        createAuthenticatedSessionFetch(registry, session.defaultSession),
      ),
  );

  const permissionBridge = services.resolve(CLAUDE_PERMISSION_BRIDGE);
  claudeRuntime.setPermissionRequestHook(
    runtimeAssetPath('claude-permission-hook.ps1'),
    (sessionId, launchGeneration) => permissionBridge.createEndpoint(sessionId, launchGeneration),
  );
  const streamDiagnosticsStore = services.resolve(CLAUDE_STREAM_DIAGNOSTICS_STORE);
  installClaudeStreamFailureHandler(claudeRuntime, runtimeActivityRegistry, streamDiagnosticsStore);
  claudeRuntime.setRuntimeActivityHandler(runtimeAssetPath('claude-runtime-event.ps1'), (event) => {
    const monitorKey = {
      ptyGeneration: event.ptyGeneration,
      runtimeLaunchGeneration: event.launchGeneration,
      sessionId: event.sessionId,
    } as const;
    if (event.event === 'SessionEnd') {
      permissionBridge.closeLaunch(event.sessionId, event.launchGeneration);
      launchHealthMonitor.invalidateExact(monitorKey);
    } else if (event.event === 'SessionStart') {
      // The exact-token bind emits SessionStart synchronously. Defer only to the next microtask so
      // the admitting cli-launch check can seed this PTY before monitoring decides whether to probe.
      queueMicrotask(() => {
        if (
          !workspace.hasSession(event.sessionId) ||
          workspace.getStatus(event.sessionId).ptyGeneration !== event.ptyGeneration ||
          !claudeRuntime.ownsLaunch(event.sessionId, event.launchGeneration) ||
          !claudeRuntime.isBoundToPty(event.sessionId, event.ptyGeneration)
        ) {
          return;
        }
        const provider = claudeRuntime.officialNetworkProviderForActivePty(
          event.sessionId,
          event.ptyGeneration,
        );
        if (provider) {
          const initialEvidence = claudeRuntime.takeActiveLaunchPreflightEvidence(
            event.sessionId,
            event.launchGeneration,
            event.ptyGeneration,
          );
          launchHealthMonitor.start({
            ...monitorKey,
            cwd: workspace.getStatus(event.sessionId).cwd,
            ...(initialEvidence ? { initialEvidence } : {}),
            provider,
          });
        }
      });
    }
    runtimeActivityRegistry.consume(event);
  });
  claudeRuntime.setConversationLaunchGuard((cwd, mode, conversationId) => {
    claudeConversationLifecycle.assertLaunchAllowed(cwd, mode, conversationId);
  });
  services.resolve(CODEX_RUNTIME);
};

/** Preflight, the access guard it feeds, process scanning and the updater — all read-only observers. */
const installDiagnostics = ({
  advancedSettingsStore,
  runtimeActivityRegistry,
  runtimeProfile,
  services,
  state,
  workspace,
}: DiagnosticsBootstrap): void => {
  mainLogger.configureDisk(path.join(app.getPath('userData'), 'diagnostics', 'main.jsonl'));
  services.register(MAIN_LOGGER, () => mainLogger);
  services.register(
    NETWORK_DIAGNOSTICS_STORE,
    () => new NetworkDiagnosticsStore(app.getPath('userData')),
  );
  services.register(NETWORK_PREFLIGHT_SERVICE, () => {
    const proxyCoordinator = services.resolve(APPLICATION_PROXY_COORDINATOR);
    const preflightService = new NetworkPreflightService({
      acquireNetworkLease: (scopes) => proxyCoordinator.acquirePreflightLease(scopes),
      diagnosticsStore: services.resolve(NETWORK_DIAGNOSTICS_STORE),
      environmentProbe: new NetworkEnvironmentRiskProbe({
        cliEnvironment: () => combinedCliEnvironment(advancedSettingsStore, proxyCoordinator),
        settings: () => advancedSettingsStore.get().networkPreflight,
        systemLanguages: () => app.getPreferredSystemLanguages(),
      }),
      onObservabilityError: (phase, error) => {
        mainLogger.warn('network-preflight', `网络预检的附属记录步骤失败：${phase}。`, error);
      },
      onResult: (result) => {
        services
          .resolve(MAIN_WINDOW)
          .current?.webContents.send(CHANNELS.NETWORK_PREFLIGHT_RESULT, result);
      },
      probe: new ProviderConnectivityProbe({
        applicationRequestForScope: (networkScope) => {
          const electronSession =
            networkScope === 'conversation'
              ? services.resolve(CONVERSATION_NETWORK_SESSION)
              : session.defaultSession;
          return createElectronApplicationRequest({
            createRedirectFetch: (authorizeRedirect) =>
              createAuthenticatedSessionFetch(services, electronSession, authorizeRedirect),
            fetch: (input, init) => electronSession.fetch(input, init),
          });
        },
        cliEnvironment: () => combinedCliEnvironment(advancedSettingsStore, proxyCoordinator),
        resolveProxy: async (url, networkScope, signal) => {
          signal?.throwIfAborted();
          const electronSession =
            networkScope === 'conversation'
              ? services.resolve(CONVERSATION_NETWORK_SESSION)
              : session.defaultSession;
          // Electron's PAC resolver has no AbortSignal parameter. The probe bounds concurrent
          // unresolved calls; these checks fence a late result from an obsolete authoritative run.
          const resolved = await electronSession.resolveProxy(url);
          signal?.throwIfAborted();
          return resolved;
        },
        /*
         * Must match the coordinator's CLI-environment gate exactly. Reporting the proxy
         * here whenever it is merely enabled made CLI diagnostics blame an application- or
         * conversation-only proxy for failures on a CLI that actually ran direct.
         */
        applicationProxyUrl: () => {
          const view = proxyCoordinator.getView();
          return view.scope.cli && view.protocol === 'http' ? applicationProxyUrl(view) : undefined;
        },
      }),
      shouldAssessEnvironment: (input) => {
        const settings = advancedSettingsStore.get().networkPreflight;
        return (
          input.force === true ||
          input.action === 'background' ||
          (input.action === 'cli-launch' && settings.checkOnNewSession) ||
          ((input.action === 'login' || input.action === 'provider-switch') &&
            settings.checkOnProviderLogin)
        );
      },
    });
    proxyCoordinator.subscribe((scope) => {
      preflightService.invalidate(`application-proxy-${scope}-transition`);
    });
    return preflightService;
  });
  services.register(
    MAIN_DIAGNOSTICS,
    (registry) =>
      new MainDiagnostics({
        claudeStream: registry.resolve(CLAUDE_STREAM_DIAGNOSTICS_STORE),
        logger: registry.resolve(MAIN_LOGGER),
        network: registry.resolve(NETWORK_DIAGNOSTICS_STORE),
        runtimeActivity: runtimeActivityRegistry,
      }),
  );
  services.register(
    PROVIDER_ACCESS_GUARD,
    (registry) =>
      new ProviderAccessGuard(registry.resolve(NETWORK_PREFLIGHT_SERVICE), (request) => {
        const settings = advancedSettingsStore.get().networkPreflight;
        return (
          (request.action === 'cli-launch' && settings.checkOnNewSession) ||
          ((request.action === 'login' || request.action === 'provider-switch') &&
            settings.checkOnProviderLogin)
        );
      }),
  );
  services.register(
    APPLICATION_UPDATER_SERVICE,
    () =>
      new ApplicationUpdaterService({
        currentVersion: app.getVersion(),
        driver: autoUpdater as unknown as ApplicationUpdaterDriver,
        enabled:
          runtimeProfile.effects.allowApplicationUpdates &&
          app.isPackaged &&
          process.platform === 'win32',
        onChange: (updaterState) => {
          services
            .resolve(MAIN_WINDOW)
            .current?.webContents.send(CHANNELS.SOFTWARE_APPLICATION_UPDATER_CHANGED, updaterState);
        },
        onInstallError: () => {
          state.isQuitting = false;
        },
      }),
  );

  services.resolve(MAIN_LOGGER);
  services.resolve(NETWORK_DIAGNOSTICS_STORE);
  services.resolve(NETWORK_PREFLIGHT_SERVICE);
  services.resolve(MAIN_DIAGNOSTICS);
  services.resolve(PROVIDER_ACCESS_GUARD);
  services.resolve(RUNTIME_PROCESS_REGISTRY).start(() =>
    workspace
      .getState()
      .sessions.filter((status): status is TerminalStatus & { pid: number } =>
        Boolean(status.phase === 'running' && status.pid),
      )
      .map((status) => ({
        launchGeneration: runtimeActivityRegistry.get(status.id).launchGeneration,
        ptyGeneration: status.ptyGeneration,
        rootPid: status.pid,
        sessionId: status.id,
      })),
  );
  services.resolve(APPLICATION_UPDATER_SERVICE);
};

/**
 * The two startup switches are independent. When only model loading is enabled there is no visible
 * conversation to own a transaction, so a short-lived PowerShell session supplies the same
 * generation and rollback boundaries as an interactive history restore, then closes before the
 * first window is painted.
 */
const runStartupModelRestore = async ({
  appPreferencesStore,
  guards,
  ipc,
  runtimeProfile,
  services,
  sessionManager,
  workspace,
  workspaceStore,
}: Pick<
  BootstrapDependencies,
  | 'appPreferencesStore'
  | 'guards'
  | 'ipc'
  | 'runtimeProfile'
  | 'services'
  | 'sessionManager'
  | 'workspace'
  | 'workspaceStore'
>): Promise<void> => {
  const runtime = services.resolve(CLAUDE_RUNTIME);
  await restoreLastConversationModelOnly({
    allowExternalRoutingWrites: runtimeProfile.effects.allowExternalRoutingWrites,
    applyConversationModel: async (projectPath, conversation, sessionId) => {
      const networkAccess = runtime.conversationNetworkAccess(
        projectPath,
        conversation.conversationId,
      );
      await applyConversationModelConnection({
        cwd: projectPath,
        prepare: (assertCurrent) => {
          const prepare = () =>
            runtime.prepareConversationConnection(
              projectPath,
              conversation.conversationId,
              assertCurrent,
            );
          if (!networkAccess) {
            return prepare();
          }
          return guards.withOfficialProviderAccess(
            { action: 'provider-switch', cwd: projectPath, ...networkAccess },
            () => {
              assertCurrent();
              return prepare();
            },
          );
        },
        runClaudeProjectConfigTransaction: ipc.runClaudeProjectConfigTransaction,
        runtime,
        sessionId,
        withDevelopmentSessionOperation: ipc.withDevelopmentSessionOperation,
      });
    },
    closeTemporarySession: (sessionId) => {
      if (!workspace.hasSession(sessionId)) return;
      runtime.closeSession(sessionId);
      workspace.close(sessionId);
    },
    getLastActiveProject: () => workspaceStore.getLastActiveProject(),
    getLatestConversation: (projectPath) => sessionManager.getSessionsForProject(projectPath)[0],
    getPreferences: () => appPreferencesStore.get().conversationResume,
    inspectConversationModel: (projectPath, conversation) =>
      runtime.inspectConversationModel(
        projectPath,
        conversation.conversationId,
        conversation.modelId,
        'use-conversation',
      ),
    openTemporarySession: (projectPath) => {
      const before = new Set(workspace.getState().sessions.map(({ id }) => id));
      const opened = workspace.openProject(projectPath, 'claude').state;
      const sessionId = opened.activeSessionId;
      return sessionId && !before.has(sessionId) ? sessionId : undefined;
    },
    projectExists: existsSync,
    projectRuntime: () => 'claude',
    restoreWorkspace: runtimeProfile.effects.restoreWorkspace,
    warn: (message, error) =>
      services.resolve(MAIN_LOGGER).warn('startup-model-restore', message, error),
  });
};

const createBootstrapContributions = (
  dependencies: BootstrapDependencies,
): readonly StartupContribution[] => {
  const { artifactService, createTray, createWindow, ipc, runtimeProfile, services } = dependencies;
  return [
    () => {
      app.setAppUserModelId('io.github.aeonusovo.claudedock');
    },
    () => {
      artifactService.install();
    },
    () => installClaudeExecutionSettings(dependencies),
    () => installNetworkServices(dependencies),
    () => installAgentRuntimes(dependencies),
    () => installDiagnostics(dependencies),
    () => registerIpc(ipc),
    () => {
      if (runtimeProfile.effects.tray) createTray();
    },
    () => runStartupModelRestore(dependencies),
    () => createWindow(),
    () => {
      if (!runtimeProfile.effects.allowExternalRoutingWrites) return;
      void services
        .resolve(CLAUDE_RUNTIME)
        .recoverInterruptedRouterInstall()
        .catch(() => {
          // The journal is intentionally retained; the next launch or install click retries safely.
        });
    },
  ];
};

export const createBootstrap = (dependencies: BootstrapDependencies) => {
  const contributions = createBootstrapContributions(dependencies);
  return (): Promise<void> => runStartupContributions(contributions);
};
