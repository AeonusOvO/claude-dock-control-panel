import { CHANNELS } from '../shared/ipc/channels';
import { automaticNetworkPreflightEnabled } from '../shared/network-preflight-policy';
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { TerminalStatus } from '../shared/contracts';
import { DEFAULT_TERMINAL_THEME } from '../shared/ui/terminal-themes';
import { RuntimeActivityRegistry } from './runtime/activity-registry';
import { ClaudePluginManager } from './claude/plugin-manager';
import { createClaudeLaunchOperations } from './claude/launch-operations';
import {
  createPermissionModeProbes,
  type PendingPermissionModeProbe,
} from './claude/permission-mode-probe';
import {
  configTransactionState,
  createRunClaudeProjectConfigTransaction,
} from './claude/project-config-transaction';
import { createClaudeStatePublisher } from './claude/state-publisher';
import { createBootstrap } from './app/bootstrap';
import { StartupModelConnectionCoordinator } from './app/startup-model-connection-coordinator';
import {
  createQuitController,
  registerAppLifecycle,
  registerProcessErrorHandlers,
} from './app/lifecycle';
import { createTrayController } from './app/tray';
import { createWindowController } from './app/window';
import { createDevelopmentSessionCoordination } from './coordination/development-session';
import { LaunchPreflightDecisionCoordinator } from './coordination/launch-preflight-decision';
import { ClaudeLaunchHealthMonitor } from './network/claude-launch-health-monitor';
import { createDeleteClaudeConversation } from './conversation/deletion';
import { createPublishNativeSnapshot } from './conversation/snapshot-publisher';
import { createProjectOperations } from './terminal/project-operations';
import { createDescribeWorkspace } from './terminal/workspace-view';
import { Registry } from './infra/registry';
import {
  CLAUDE_RUNTIME,
  CODEX_RUNTIME,
  MAIN_WINDOW,
  NETWORK_PREFLIGHT_SERVICE,
  registerLifecycleServiceReferences,
  RUNTIME_PROCESS_REGISTRY,
} from './infra/service-tokens';
import { createMainState } from './ipc/context';
import { createMainGuards } from './ipc/guards';
import type { NativeConversationLaunch } from './ipc/conversation';
import { AgentRuntimeStore } from './runtime/store';
import { ClaudeSessionManager } from './claude/session-manager';
import { ChatConfigStore } from './chat/config-store';
import { ChatAttachmentStore } from './chat/attachment-store';
import { ChatHistoryStore } from './chat/history-store';
import { ChatService } from './chat/service';
import { ArtifactService, registerArtifactScheme } from './artifact/service';
import { enteredTerminalFailure } from './terminal/lifecycle';
import { TerminalOutputBatcher } from './terminal/output-batcher';
import { ProjectDirectoryLifecycleCoordinator } from './coordination/project-directory-lifecycle';
import { ClaudeConversationLifecycleCoordinator } from './claude/conversation-lifecycle';
import { TerminalWorkspace } from './terminal/workspace';
import { WorkspaceStore } from './stores/workspace';
import { AdvancedSettingsStore } from './stores/advanced-settings';
import { AppPreferencesStore } from './stores/app-preferences';
import { OnboardingStore } from './stores/onboarding';
import { resolveRuntimeProfile } from './app/profile';
import { ConversationOwnerRegistry, type ConversationOwner } from './conversation/owner-registry';
import { IsolatedTerminal } from './terminal/isolated';
import { NativeAttachmentStore } from './conversation/attachment-store';

const runtimeProfile = resolveRuntimeProfile({
  defaultHome: homedir(),
  defaultUserData: app.getPath('userData'),
});
if (runtimeProfile.id === 'isolated') {
  for (const directory of Object.values(runtimeProfile.paths)) {
    mkdirSync(directory, { recursive: true });
  }
  app.setPath('home', runtimeProfile.paths.home);
  app.setPath('userData', runtimeProfile.paths.userData);
  app.setPath('sessionData', runtimeProfile.paths.sessionData);
}
app.enableSandbox();
registerArtifactScheme();

registerProcessErrorHandlers();

/*
 * Quitting is a two-step handshake when work is in flight. `before-quit` cannot wait on a promise, so
 * instead of blocking there we cancel the quit, ask the renderer to raise its own themed
 * confirmation, and quit for real only when it answers yes. The main-owned pending confirmation keeps
 * a second quit attempt from stacking dialogs and rejects delayed responses to superseded prompts.
 */
const state = createMainState();
const startupModelConnectionCoordinator = new StartupModelConnectionCoordinator();

const services = new Registry();
registerLifecycleServiceReferences(services);

/*
 * Bound once against the containers so a handler file can import a guard rather than the container it
 * reads. Each `ipc/*.ts` takes the subset it needs, declared in its own dependency interface.
 */
const guards = createMainGuards(services, runtimeProfile.effects, state);

const conversationOwnerRegistry = new ConversationOwnerRegistry();
const terminalConversationOwners = new Map<string, ConversationOwner>();
const terminalTransferSessions = new Set<string>();
const nativeLaunches = new Map<string, NativeConversationLaunch>();
const launchPreflightDecisions = new LaunchPreflightDecisionCoordinator();

const publishNativeSnapshot = createPublishNativeSnapshot({ services, state });

const releaseTerminalConversationOwner = (sessionId: string): void => {
  const owner = terminalConversationOwners.get(sessionId);
  if (!owner) return;
  conversationOwnerRegistry.release(owner, owner.ownerId, owner.generation);
  terminalConversationOwners.delete(sessionId);
};
const runtimeActivityRegistry = new RuntimeActivityRegistry((state) => {
  services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.RUNTIME_ACTIVITY_CHANGED, state);
});

const pendingPermissionModeProbes = new Map<number, PendingPermissionModeProbe>();

/*
 * PTY output arrives in many small chunks, and one IPC message per chunk was the dominant cost when
 * a command produced a lot of output. Chunks are coalesced for a few milliseconds and sent as one
 * message. `consumeTerminalOutput` still sees every chunk individually — it tracks exit markers
 * across chunk boundaries and must not be fed a merged buffer.
 */
const terminalOutputBatcher = new TerminalOutputBatcher({
  emit: (sessionId, ptyGeneration, data) => {
    services
      .resolve(MAIN_WINDOW)
      .current?.webContents.send(CHANNELS.TERMINAL_DATA, sessionId, ptyGeneration, data);
  },
  isCurrentGeneration: (sessionId, ptyGeneration) =>
    workspace.hasSession(sessionId) &&
    workspace.getStatus(sessionId).ptyGeneration === ptyGeneration,
});

const terminalStatusBaselines = new Map<string, Pick<TerminalStatus, 'phase' | 'ptyGeneration'>>();
const publishedClaudeStateRevisions = new Map<string, number>();
const terminalOperationInvalidationSuppressions = new Set<string>();
let invalidateLaunchHealthSession = (_sessionId: string): void => {};

const workspace = new TerminalWorkspace(
  (sessionId, ptyGeneration, data) => {
    services
      .resolve(RUNTIME_PROCESS_REGISTRY)
      .observeTerminalOutput(sessionId, ptyGeneration, data);
    const claudeFiltered =
      services.resolve(CLAUDE_RUNTIME).consumeTerminalOutput(sessionId, ptyGeneration, data) ??
      data;
    const filtered =
      services
        .resolve(CODEX_RUNTIME)
        .consumeTerminalOutput(sessionId, ptyGeneration, claudeFiltered) ?? claudeFiltered;
    if (filtered) {
      terminalOutputBatcher.queue(sessionId, ptyGeneration, filtered);
    }
  },
  (state) => {
    const liveSessionIds = new Set(state.sessions.map(({ id }) => id));
    for (const status of state.sessions) {
      if (
        (status.phase === 'stopped' || status.phase === 'error') &&
        !terminalTransferSessions.has(status.id)
      ) {
        releaseTerminalConversationOwner(status.id);
      }
      const previous = terminalStatusBaselines.get(status.id);
      const generationChanged = Boolean(
        previous && previous.ptyGeneration !== status.ptyGeneration,
      );
      const enteredFailure = enteredTerminalFailure(previous, status);
      const expectedLaunchReplacement =
        generationChanged && !enteredFailure && previous
          ? launchPreflightDecisions.consumeExpectedPtyReplacement(
              status.id,
              previous.ptyGeneration,
              status.ptyGeneration,
            )
          : false;
      if ((generationChanged && !expectedLaunchReplacement) || enteredFailure) {
        launchPreflightDecisions.invalidateSession(status.id);
      }
      if (generationChanged || enteredFailure) {
        invalidateLaunchHealthSession(status.id);
      }
      terminalStatusBaselines.set(status.id, {
        phase: status.phase,
        ptyGeneration: status.ptyGeneration,
      });
      if (!enteredFailure) {
        continue;
      }
      terminalOutputBatcher.flush(status.id, status.ptyGeneration);
      resolvePendingPermissionModeProbes(status.id, status.ptyGeneration);
      if (!terminalOperationInvalidationSuppressions.has(status.id)) {
        invalidateDevelopmentSessionOperation(status.id);
      }
      services.resolve(CLAUDE_RUNTIME).setInactive(status.id, status.ptyGeneration);
      services.resolve(CODEX_RUNTIME).setInactive(status.id, status.ptyGeneration);
    }
    for (const sessionId of terminalStatusBaselines.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        releaseTerminalConversationOwner(sessionId);
        launchPreflightDecisions.invalidateSession(sessionId);
        invalidateLaunchHealthSession(sessionId);
        developmentSessionOperations.removeSession(sessionId);
        services.resolve(CLAUDE_RUNTIME).closeSession(sessionId);
        services.resolve(CODEX_RUNTIME).closeSession(sessionId);
        terminalStatusBaselines.delete(sessionId);
        terminalOutputBatcher.discard(sessionId);
        resolvePendingPermissionModeProbes(sessionId);
      }
    }
    for (const sessionId of publishedClaudeStateRevisions.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        publishedClaudeStateRevisions.delete(sessionId);
      }
    }
    const enriched = describeWorkspace(state);
    services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.WORKSPACE_STATE, enriched);
    updateTray(enriched);
  },
  runtimeProfile.effects.allowRealRuntimes
    ? undefined
    : (id, initialCwd, initialTitle, _onData, onStatus) =>
        new IsolatedTerminal(id, initialCwd, initialTitle, onStatus),
);
const { requestPermissionModeFromScreen, resolvePendingPermissionModeProbes } =
  createPermissionModeProbes({
    pendingPermissionModeProbes,
    services,
    state,
    terminalOutputBatcher,
    workspace,
  });

const launchHealthMonitor = new ClaudeLaunchHealthMonitor({
  isCurrent: ({ ptyGeneration, runtimeLaunchGeneration, sessionId }) => {
    if (
      !workspace.hasSession(sessionId) ||
      workspace.getStatus(sessionId).ptyGeneration !== ptyGeneration
    ) {
      return false;
    }
    const runtime = services.resolve(CLAUDE_RUNTIME);
    return (
      runtime.ownsLaunch(sessionId, runtimeLaunchGeneration) &&
      runtime.isBoundToPty(sessionId, ptyGeneration)
    );
  },
  onSnapshot: ({ ptyGeneration, runtimeLaunchGeneration, sessionId }, snapshot) => {
    services
      .resolve(CLAUDE_RUNTIME)
      .applyAdvisoryRouteHealth(sessionId, runtimeLaunchGeneration, ptyGeneration, snapshot);
  },
  preflight: {
    run: (input, target) => services.resolve(NETWORK_PREFLIGHT_SERVICE).run(input, target),
  },
  shouldCheck: () =>
    automaticNetworkPreflightEnabled(advancedSettingsStore.get().networkPreflight, 'cli-launch'),
});
invalidateLaunchHealthSession = (sessionId) => launchHealthMonitor.invalidateSession(sessionId);

const workspaceStore = new WorkspaceStore(app.getPath('userData'));
const projectDirectoryLifecycle = new ProjectDirectoryLifecycleCoordinator();
const claudeConversationLifecycle = new ClaudeConversationLifecycleCoordinator();
const advancedSettingsStore = new AdvancedSettingsStore(app.getPath('userData'));
const appPreferencesStore = new AppPreferencesStore(app.getPath('userData'));
const onboardingStore = new OnboardingStore(app.getPath('userData'));
const agentRuntimeStore = new AgentRuntimeStore(app.getPath('userData'));
workspace.setTheme(workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME);
const sessionManager = new ClaudeSessionManager(runtimeProfile.paths.projects);
const pluginManager = new ClaudePluginManager(runtimeProfile.paths.home);
const chatConfigStore = new ChatConfigStore(app.getPath('userData'));
const chatAttachmentStore = new ChatAttachmentStore(app.getPath('userData'));
const nativeAttachmentStore = new NativeAttachmentStore(runtimeProfile.paths.userData);
nativeAttachmentStore.collectOrphans(new Set());
const chatHistoryStore = new ChatHistoryStore(app.getPath('userData'), chatAttachmentStore);
try {
  chatAttachmentStore.collectOrphans(chatHistoryStore.referencedAttachmentIds());
} catch {
  // Fail closed: unreadable history must never be interpreted as an empty attachment reference set.
}
const chatService = new ChatService(
  chatConfigStore,
  (event) => {
    services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.CHAT_STREAM, event);
  },
  (url, init) => state.chatFetch(url, init),
  chatAttachmentStore,
  {},
  () => advancedSettingsStore.get().chatIdleTimeoutMinutes * 60_000,
);
const artifactService = new ArtifactService(app.getPath('userData'), (entry) => {
  services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.ARTIFACT_NETWORK_LOG, entry);
});

const describeWorkspace = createDescribeWorkspace({ workspace, workspaceStore });

/*
 * The window and the quit handshake reference each other: closing the window may start a quit, and
 * asking whether to quit needs the window raised. The controller is built first and receives the
 * quit entry point as a thunk, so only one of the two edges is late-bound.
 */
const { applyWindowTheme, createWindow, hideMainWindowToTray, showMainWindow } =
  createWindowController({
    appPreferencesStore,
    invalidateLaunchPreflightDecisions: () => launchPreflightDecisions.invalidateAll(),
    requestQuit: () => quit.requestQuit(),
    services,
    state,
    workspaceStore,
  });

const quit = createQuitController({
  cancelStartupModelConnection: async () => {
    if (!startupModelConnectionCoordinator.getState().active) return;
    await startupModelConnectionCoordinator.cancel('shutdown');
  },
  chatService,
  invalidateLaunchPreflightDecisions: () => {
    launchPreflightDecisions.invalidateAll();
    launchHealthMonitor.invalidateAll();
  },
  nativeAttachmentStore,
  services,
  showMainWindow,
  state,
  workspace,
});
const { beginControlledQuit, requestQuit } = quit;
const { activateProject, addProject, chooseDirectory, failedWorkspaceResult } =
  createProjectOperations({
    describeWorkspace,
    homeDirectory: runtimeProfile.paths.home,
    nextDevelopmentRuntime: () => agentRuntimeStore.getNext(),
    prepareCreatedConversation: (sessionId, projectPath, runtime) => {
      if (runtime === 'claude') {
        guards.requireClaudeRuntime().bindNextConversationConnection(sessionId, projectPath);
      }
    },
    projectDirectoryLifecycle,
    workspace,
    workspaceStore,
  });

const {
  acquireConfigTransactionIsolation,
  developmentSessionOperations,
  directTerminalTransitions,
  invalidateAndWaitForDevelopmentSessionOperation,
  invalidateAndWaitForMatchingDevelopmentSessionOperation,
  invalidateDevelopmentSessionOperation,
  managedConfigTransactions,
  projectRuntimeSwitchOperations,
  withDevelopmentSessionOperation: withLaunchDecisionSessionOperation,
  withDevelopmentSessionOperationIfStampCurrent,
  withoutTerminalOperationInvalidation,
} = createDevelopmentSessionCoordination({
  agentRuntimeStore,
  guards,
  resolvePendingPermissionModeProbes,
  services,
  terminalOperationInvalidationSuppressions,
  terminalOutputBatcher,
  workspace,
});

const withDevelopmentSessionOperation: typeof withLaunchDecisionSessionOperation = (
  sessionId,
  operation,
) => {
  launchPreflightDecisions.invalidateSession(sessionId);
  return withLaunchDecisionSessionOperation(sessionId, operation);
};

const { createTray, updateTray } = createTrayController({
  activateProject,
  addProject,
  chooseDirectory,
  describeWorkspace,
  directTerminalTransitions,
  requestQuit,
  services,
  showMainWindow,
  workspace,
});

const {
  claudeFailure,
  failedRuntimeLaunchCleanupDependencies,
  restartRuntimeTerminal,
  runClaudeResumeLaunch,
} = createClaudeLaunchOperations({
  guards,
  resolvePendingPermissionModeProbes,
  terminalOutputBatcher,
  workspace,
});

const deleteClaudeConversation = createDeleteClaudeConversation({
  claudeConversationLifecycle,
  describeWorkspace,
  developmentSessionOperations,
  guards,
  services,
  sessionManager,
  workspace,
});

const { publishClaudeProjectState, publishRestoredClaudeProjectState } = createClaudeStatePublisher(
  {
    conversationOwnerRegistry,
    publishedClaudeStateRevisions,
    releaseTerminalConversationOwner,
    services,
    terminalConversationOwners,
    terminalTransferSessions,
    workspace,
  },
);

const runClaudeProjectConfigTransaction = createRunClaudeProjectConfigTransaction({
  acquireConfigTransactionIsolation,
  guards,
  managedConfigTransactions,
  publishRestoredClaudeProjectState,
  workspace,
});

const onReady = createBootstrap({
  activateProject,
  advancedSettingsStore,
  appPreferencesStore,
  artifactService,
  claudeConversationLifecycle,
  conversationOwnerRegistry,
  createTray,
  createWindow,
  guards,
  launchHealthMonitor,
  ipc: {
    activateProject,
    addProject,
    advancedSettingsStore,
    agentRuntimeStore,
    appPreferencesStore,
    applyWindowTheme,
    artifactService,
    beginControlledQuit,
    chatAttachmentStore,
    chatConfigStore,
    chatHistoryStore,
    chatService,
    chooseDirectory,
    claudeConversationLifecycle,
    claudeFailure,
    configTransactionState,
    conversationOwnerRegistry,
    deleteClaudeConversation,
    describeWorkspace,
    developmentSessionOperations,
    directTerminalTransitions,
    failedRuntimeLaunchCleanupDependencies,
    failedWorkspaceResult,
    guards,
    hideMainWindowToTray,
    invalidateAndWaitForDevelopmentSessionOperation,
    invalidateAndWaitForMatchingDevelopmentSessionOperation,
    invalidateLaunchPreflightDecision: (sessionId: string) =>
      launchPreflightDecisions.invalidateSession(sessionId),
    launchPreflightDecisions,
    managedConfigTransactions,
    nativeAttachmentStore,
    nativeLaunches,
    onboardingStore,
    pendingPermissionModeProbes,
    pluginManager,
    projectDirectoryLifecycle,
    projectRuntimeSwitchOperations,
    releaseTerminalConversationOwner,
    restartRuntimeTerminal,
    runClaudeProjectConfigTransaction,
    runClaudeResumeLaunch,
    runtimeActivityRegistry,
    runtimeProfile,
    services,
    sessionManager,
    state,
    startupModelConnectionCoordinator,
    terminalConversationOwners,
    terminalTransferSessions,
    withDevelopmentSessionOperation,
    withLaunchDecisionSessionOperation,
    withDevelopmentSessionOperationIfStampCurrent,
    withoutTerminalOperationInvalidation,
    workspace,
    workspaceStore,
  },
  nativeAttachmentStore,
  nativeLaunches,
  publishClaudeProjectState,
  publishNativeSnapshot,
  requestPermissionModeFromScreen,
  runtimeActivityRegistry,
  runtimeProfile,
  services,
  sessionManager,
  state,
  startupModelConnectionCoordinator,
  updateTray,
  workspace,
  workspaceStore,
});

registerAppLifecycle({
  effects: runtimeProfile.effects,
  onReady,
  pendingPermissionModeProbes,
  quit,
  services,
  showMainWindow,
  state,
  terminalOutputBatcher,
});
