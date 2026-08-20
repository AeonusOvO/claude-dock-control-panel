import { CHANNELS } from '../../shared/ipc/channels';
import { app, net, safeStorage, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TerminalStatus } from '../../shared/contracts';
import { DEFAULT_TERMINAL_THEME } from '../../shared/ui/terminal-themes';
import { ArtifactService } from '../artifact/service';
import { ClaudeAgentAdapter } from '../claude/agent-adapter';
import { CcSwitchAdapter } from '../claude/cc-switch-adapter';
import { ClaudeConversationLifecycleCoordinator } from '../claude/conversation-lifecycle';
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
  APPLICATION_PROXY_STORE,
  APPLICATION_PROXY_TEST_SESSION,
  APPLICATION_UPDATER_SERVICE,
  BUSY_REGISTRY,
  CC_SWITCH_ADAPTER,
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
import { NetworkDiagnosticsStore } from '../network/diagnostics-store';
import { createElectronApplicationRequest } from '../network/electron-request';
import { NetworkPreflightService } from '../network/preflight-service';
import { ProviderAccessGuard } from '../network/provider-access-guard';
import { ProviderConnectivityProbe } from '../network/provider-connectivity-probe';
import { applicationProxyUrl, buildApplicationProxyEnvironment } from '../proxy/application-proxy';
import { ApplicationProxyStore } from '../proxy/application-proxy-store';
import type { ProxyScopes } from '../proxy/scopes';
import { RuntimeActivityRegistry } from '../runtime/activity-registry';
import { RuntimeProcessRegistry } from '../runtime/process-registry';
import type { AdvancedSettingsStore } from '../stores/advanced-settings';
import type { AppPreferencesStore } from '../stores/app-preferences';
import type { WorkspaceStore } from '../stores/workspace';
import type { ProjectOperations } from '../terminal/project-operations';
import { sameDirectory, type TerminalWorkspace } from '../terminal/workspace';
import { ApplicationUpdaterService, type ApplicationUpdaterDriver } from '../updates/application';
import { runtimeAssetPath } from './paths';
import type { RuntimeProfile } from './profile';
import type { TrayController } from './tray';
import type { WindowController } from './window';

export interface BootstrapDependencies {
  activateProject: ProjectOperations['activateProject'];
  advancedSettingsStore: AdvancedSettingsStore;
  appPreferencesStore: AppPreferencesStore;
  applyApplicationProxyScope: ProxyScopes['applyApplicationProxyScope'];
  applyConversationProxyScope: ProxyScopes['applyConversationProxyScope'];
  artifactService: ArtifactService;
  claudeConversationLifecycle: ClaudeConversationLifecycleCoordinator;
  conversationOwnerRegistry: ConversationOwnerRegistry;
  createTray: TrayController['createTray'];
  createWindow: WindowController['createWindow'];
  guards: Pick<MainGuards, 'requireManagedChatGptGateway'>;
  /** The one container every IPC slice draws from; assembled once and forwarded unchanged. */
  ipc: MainIpcDependencies;
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
  | 'applyApplicationProxyScope'
  | 'applyConversationProxyScope'
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
  'runtimeActivityRegistry' | 'runtimeProfile' | 'services' | 'workspace'
>;

/**
 * Downloads, gateways and proxy scope come first: every runtime below launches through the network
 * path selected here, and restoring interrupted work before the path is stable would use the wrong one.
 */
const installNetworkServices = async ({
  applyApplicationProxyScope,
  applyConversationProxyScope,
  runtimeProfile,
  services,
  state,
  updateTray,
  workspace,
}: NetworkServiceBootstrap): Promise<void> => {
  services.register(
    BUSY_REGISTRY,
    () =>
      new BusyRegistry((leases) => {
        services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.BUSY_CHANGED, leases);
        updateTray();
      }),
  );
  services.register(
    MCP_MANAGER,
    (registry) =>
      new McpManager(
        runtimeProfile.paths.home,
        runtimeProfile.paths.userData,
        registry.resolve(BUSY_REGISTRY),
      ),
  );
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
        (url, init) =>
          session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
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
        (url, init) =>
          session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
      ),
  );
  services.register(
    APPLICATION_PROXY_STORE,
    () => new ApplicationProxyStore(app.getPath('userData'), safeStorage),
  );
  services.register(CONVERSATION_NETWORK_SESSION, () =>
    session.fromPartition('claudedock-conversation-network'),
  );
  services.register(APPLICATION_PROXY_TEST_SESSION, () =>
    session.fromPartition('claudedock-application-proxy-test'),
  );

  services.resolve(BUSY_REGISTRY);
  services.resolve(MCP_MANAGER);
  const downloadEngine = services.resolve(DOWNLOAD_ENGINE);
  services.resolve(CC_SWITCH_ADAPTER);
  services.resolve(MANAGED_CHATGPT_GATEWAY);
  const applicationProxyStore = services.resolve(APPLICATION_PROXY_STORE);
  const conversationNetworkSession = services.resolve(CONVERSATION_NETWORK_SESSION);
  services.resolve(APPLICATION_PROXY_TEST_SESSION);

  state.chatFetch = (url, init) =>
    conversationNetworkSession.fetch(url instanceof URL ? url.toString() : url, init);
  await applyApplicationProxyScope();
  await applyConversationProxyScope();
  // Restore only after the selected application network path is stable.
  if (runtimeProfile.effects.restoreWorkspace) {
    downloadEngine.restoreInterrupted();
  }
  workspace.setEnvironmentProvider(() =>
    buildApplicationProxyEnvironment(
      applicationProxyStore.getView(),
      applicationProxyStore.getCredentials(),
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
  guards: { requireManagedChatGptGateway },
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
    () =>
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
        (state) => {
          publishClaudeProjectState(state);
        },
        (sessionId, ptyGeneration, data) => workspace.write(sessionId, ptyGeneration, data),
        requestPermissionModeFromScreen,
        () => requireManagedChatGptGateway().ensureRunning(),
        () => requireManagedChatGptGateway().getInstalledVersion(),
        (url, init) =>
          session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
        workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME,
        app.getVersion(),
        (progress) => {
          services
            .resolve(MAIN_WINDOW)
            .current?.webContents.send(CHANNELS.ROUTER_OPERATION_PROGRESS, progress);
        },
        () => requireManagedChatGptGateway().stop(),
        () => {
          const proxyStore = services.resolve(APPLICATION_PROXY_STORE);
          return buildApplicationProxyEnvironment(
            proxyStore.getView(),
            proxyStore.getCredentials(),
          );
        },
      ),
  );

  services.resolve(RUNTIME_PROCESS_REGISTRY);
  const claudeRuntime = services.resolve(CLAUDE_RUNTIME);
  const nativeAdapter =
    runtimeProfile.adapterMode === 'fake'
      ? new FakeConversationAdapter()
      : new ClaudeAgentAdapter({
          appVersion: app.getVersion(),
          environment: (input) => {
            const launch = nativeLaunches.get(input.conversationId);
            if (!launch) throw new Error('原生对话的接入环境尚未准备完成。');
            const proxyStore = services.resolve(APPLICATION_PROXY_STORE);
            return {
              ...launch.prepared.environment,
              ...buildApplicationProxyEnvironment(
                proxyStore.getView(),
                proxyStore.getCredentials(),
              ),
            };
          },
        });
  services.register(
    NATIVE_CONVERSATION_SERVICE,
    () =>
      new NativeConversationService({
        adapter: nativeAdapter,
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
  const interruptedNativeConversations = nativeConversationService.recoverInterrupted();
  // rc.2 could leave a recovery row when the adapter failed before Claude created a transcript.
  // Such an empty reservation has no prompt, output, or session to recover. Reconcile it against
  // Claude's canonical JSONL index so the upgrade cleans the false card without touching history.
  for (const recovery of interruptedNativeConversations) {
    if (
      recovery.submissions.length === 0 &&
      !sessionManager
        .getSessionsForProject(recovery.projectPath)
        .some((session) => session.conversationId === recovery.conversationId)
    ) {
      nativeConversationService.discardRecovery(recovery.conversationId, recovery.projectPath);
    }
  }

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
        (url, init) =>
          session.defaultSession.fetch(url instanceof URL ? url.toString() : url, init),
      ),
  );

  const permissionBridge = services.resolve(CLAUDE_PERMISSION_BRIDGE);
  claudeRuntime.setPermissionRequestHook(
    runtimeAssetPath('claude-permission-hook.ps1'),
    (sessionId, launchGeneration) => permissionBridge.createEndpoint(sessionId, launchGeneration),
  );
  const streamDiagnosticsStore = services.resolve(CLAUDE_STREAM_DIAGNOSTICS_STORE);
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
  claudeRuntime.setRuntimeActivityHandler(runtimeAssetPath('claude-runtime-event.ps1'), (event) => {
    if (event.event === 'SessionEnd') {
      permissionBridge.closeLaunch(event.sessionId, event.launchGeneration);
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
  runtimeActivityRegistry,
  runtimeProfile,
  services,
  workspace,
}: DiagnosticsBootstrap): void => {
  mainLogger.configureDisk(path.join(app.getPath('userData'), 'diagnostics', 'main.jsonl'));
  services.register(MAIN_LOGGER, () => mainLogger);
  services.register(
    NETWORK_DIAGNOSTICS_STORE,
    () => new NetworkDiagnosticsStore(app.getPath('userData')),
  );
  services.register(
    NETWORK_PREFLIGHT_SERVICE,
    () =>
      new NetworkPreflightService({
        diagnosticsStore: services.resolve(NETWORK_DIAGNOSTICS_STORE),
        onResult: (result) => {
          services
            .resolve(MAIN_WINDOW)
            .current?.webContents.send(CHANNELS.NETWORK_PREFLIGHT_RESULT, result);
        },
        probe: new ProviderConnectivityProbe({
          appFetch: (url, init) => net.fetch(url, init),
          applicationRequest: createElectronApplicationRequest((options) =>
            net.request({ ...options, session: session.defaultSession }),
          ),
          cliEnvironment: () => {
            const proxyStore = services.resolve(APPLICATION_PROXY_STORE);
            return buildApplicationProxyEnvironment(
              proxyStore.getView(),
              proxyStore.getCredentials(),
            );
          },
          resolveProxy: (url) => session.defaultSession.resolveProxy(url),
          /*
           * Must match `buildApplicationProxyEnvironment`'s own gate exactly. Reporting the proxy
           * here whenever it is merely enabled made CLI diagnostics blame an application- or
           * conversation-only proxy for failures on a CLI that actually ran direct.
           */
          applicationProxyUrl: () => {
            const view = services.resolve(APPLICATION_PROXY_STORE).getView();
            return view.scope.cli && view.protocol === 'http'
              ? applicationProxyUrl(view)
              : undefined;
          },
        }),
      }),
  );
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
    (registry) => new ProviderAccessGuard(registry.resolve(NETWORK_PREFLIGHT_SERVICE)),
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
        onChange: (state) => {
          services
            .resolve(MAIN_WINDOW)
            .current?.webContents.send(CHANNELS.SOFTWARE_APPLICATION_UPDATER_CHANGED, state);
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

const restoreLastWorkspace = ({
  activateProject,
  runtimeProfile,
  workspace,
  workspaceStore,
}: Pick<
  BootstrapDependencies,
  'activateProject' | 'runtimeProfile' | 'workspace' | 'workspaceStore'
>): void => {
  // Remembered folders are listed without a terminal each — otherwise every folder ever opened
  // would spawn a PowerShell at startup. Only the folder in use last time is reopened live.
  const lastActive = runtimeProfile.effects.restoreWorkspace
    ? workspaceStore.getLastActiveProject()
    : undefined;
  if (!lastActive || !existsSync(lastActive)) return;
  try {
    const result = workspace.openProject(lastActive);
    const restored = result.state.sessions.find((session) =>
      sameDirectory(session.cwd, lastActive),
    );
    if (restored) {
      activateProject(restored.id);
    }
  } catch {
    // A folder that has become unreadable stays in the list as a remembered entry.
  }
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
    () => installNetworkServices(dependencies),
    () => installAgentRuntimes(dependencies),
    () => installDiagnostics(dependencies),
    () => registerIpc(ipc),
    () => {
      if (runtimeProfile.effects.tray) createTray();
    },
    () => restoreLastWorkspace(dependencies),
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
