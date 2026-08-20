import type {
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  RuntimeActivitySnapshot,
  TerminalStatus,
  WorkspaceState,
} from '../shared/contracts';
import type { Registry } from './platform/registry';
import { ClaudeLaunchAttemptRegistry } from './platform/claude-launch-attempt';
import { SessionGenerationRegistry } from './platform/session-generation';
import { createConnectionForm } from './features/connection/form';
import { createConnectionHistory } from './features/connection/history';
import { nativePhaseLabel } from './features/conversation';
import { createCodexLaunch } from './features/terminal/codex-launch';
import { createTerminalProjectState } from './features/terminal/project-state';
import { formatTokenCount, resultFailureMessage } from './platform/format';
import { createDialogShell } from './shell/dialogs';
import { createRailShell } from './shell/rail';
import { createFooterShell } from './shell/footer';
import { createThemeShell } from './shell/theme';
import { createToastShell } from './shell/toast';
import { createWorkbenchShell } from './shell/workbench';
import { createRuntimeActivityShell } from './shell/runtime-activity';
import { installFeatureStack } from './feature-registration';
import {
  installGlobalInteractions,
  installWindowLifecycle,
  runStartupSequence,
} from './app-lifecycle';
import type { ApplicationRuntime, FeatureBundle, RuntimeState, ShellStack } from './runtime-types';

const requiredElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
};

/**
 * Shared mutable renderer state: top-level DOM hooks, session/state registries, the guarded
 * button helper, and getter/setter pairs for values that outlive a single function scope.
 */
const createRuntimeState = (rendererRegistry: Registry): RuntimeState => {
  const importCurlRouterButton = requiredElement<HTMLButtonElement>('#import-curl-router');
  const brandLogo = requiredElement<HTMLImageElement>('#brand-logo');
  const dropOverlay = requiredElement<HTMLElement>('#drop-overlay');
  const routerSettingsContent = requiredElement<HTMLElement>('#router-settings-content');
  const connectionAdvancedDialog = requiredElement<HTMLDialogElement>(
    '#connection-advanced-dialog',
  );
  const openConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
    '#open-connection-advanced',
  );
  const closeConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
    '#close-connection-advanced',
  );
  const cancelConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
    '#cancel-connection-advanced',
  );
  const completeConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
    '#complete-connection-advanced',
  );
  const installRouterButton = requiredElement<HTMLButtonElement>('#install-router');
  const routeHealthAction = requiredElement<HTMLButtonElement>('#route-health-action');
  const startRouterButton = requiredElement<HTMLButtonElement>('#start-router');
  const titleStatus = requiredElement<HTMLElement>('#title-status');
  const routerManager = requiredElement<HTMLElement>('#router-manager');
  const routerActions = requiredElement<HTMLElement>('#router-actions');
  const chatMessagesElement = requiredElement<HTMLElement>('#chat-messages');
  const chatComposer = requiredElement<HTMLFormElement>('#chat-composer');

  void window.controlPanel.setConversationBusy(false);

  routerSettingsContent.append(routerManager);

  brandLogo.src = new URL('../../assets/generated/app-icon-64.png', import.meta.url).href;

  const claudeStates = new Map<string, ClaudeProjectState>();
  const codexStates = new Map<string, CodexProjectState>();
  const developmentRuntimeStates = new Map<string, DevelopmentRuntimeState>();
  const runtimeActivityStates = new Map<string, RuntimeActivitySnapshot>();
  const claudeStateLoadGenerations = new SessionGenerationRegistry();
  const codexStateLoadGenerations = new SessionGenerationRegistry();
  const runtimeStateLoadGenerations = new SessionGenerationRegistry();
  let dragDepth = 0;
  let lastClaudeSessionId = '';
  const claudeLaunchAttempts = new ClaudeLaunchAttemptRegistry();
  const claudeSpeedOperations = new SessionGenerationRegistry();
  const codexLaunchAttempts = new SessionGenerationRegistry();
  const effortRecoveryNotifications = new Map<string, number>();
  const guardedButtons = new WeakSet<HTMLButtonElement>();

  const runGuarded = async <T>(
    button: HTMLButtonElement,
    busyLabel: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (guardedButtons.has(button)) {
      return undefined;
    }
    guardedButtons.add(button);
    const originalDisabled = button.disabled;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) {
      button.textContent = busyLabel;
    }
    try {
      return await operation();
    } finally {
      guardedButtons.delete(button);
      button.disabled = originalDisabled;
      button.setAttribute('aria-busy', 'false');
      button.textContent = originalLabel;
    }
  };
  let workspaceState: WorkspaceState = {
    activeSessionId: '',
    projects: [],
    sessions: [],
  };
  let windowsBuildNumber: number | undefined;

  return {
    rendererRegistry,
    importCurlRouterButton,
    brandLogo,
    dropOverlay,
    routerSettingsContent,
    connectionAdvancedDialog,
    openConnectionAdvancedButton,
    closeConnectionAdvancedButton,
    cancelConnectionAdvancedButton,
    completeConnectionAdvancedButton,
    installRouterButton,
    routeHealthAction,
    startRouterButton,
    titleStatus,
    routerManager,
    routerActions,
    chatMessagesElement,
    chatComposer,
    claudeStates,
    codexStates,
    developmentRuntimeStates,
    runtimeActivityStates,
    claudeStateLoadGenerations,
    codexStateLoadGenerations,
    runtimeStateLoadGenerations,
    claudeLaunchAttempts,
    claudeSpeedOperations,
    codexLaunchAttempts,
    effortRecoveryNotifications,
    runGuarded,
    getWorkspaceState: (): WorkspaceState => workspaceState,
    setWorkspaceState: (state: WorkspaceState): void => {
      workspaceState = state;
    },
    getWindowsBuildNumber: (): number | undefined => windowsBuildNumber,
    setWindowsBuildNumber: (value: number | undefined): void => {
      windowsBuildNumber = value;
    },
    getDragDepth: (): number => dragDepth,
    setDragDepth: (value: number): void => {
      dragDepth = value;
    },
    getLastClaudeSessionId: (): string => lastClaudeSessionId,
    setLastClaudeSessionId: (value: string): void => {
      lastClaudeSessionId = value;
    },
  };
};

const installPrimaryShells = (
  state: RuntimeState,
  features: FeatureBundle,
  shells: ShellStack,
): void => {
  const { claudeStates, connectionAdvancedDialog, getWorkspaceState } = state;
  const toastShell = createToastShell();
  const { showToast } = toastShell;
  const themeShell = createThemeShell({
    onHighlighterReady: () => {
      if (
        !features.chatFeature.hasActiveRequest() &&
        !features.artifactFeature.hasActiveArtifacts()
      ) {
        features.chatFeature.renderChatMessages();
      }
    },
    onRunArtifact: async (html, mount) => {
      await features.artifactFeature.run(html, mount);
    },
    onSettingsThemeChanged: () => features.settingsFeature.updateUnsavedIndicator(),
    showToast,
  });
  const dialogShell = createDialogShell();
  const railShell = createRailShell({
    claudeStates,
    connectionAdvancedDialog,
    getActiveSessionId: () => getWorkspaceState().activeSessionId,
    getSelectedProviderId: () => shells.connectionForm.getSelectedProviderId(),
    setProviderGroupExpansionPending: (value) => {
      shells.connectionForm.setProviderGroupExpansionPending(value);
    },
    applyDefaultProviderGroupExpansion: (providerId) =>
      shells.connectionForm.applyDefaultProviderGroupExpansion(providerId),
    renderProviderPicker: () => shells.connectionForm.renderProviderPicker(),
    loadChatConfig: (force) => features.chatFeature.loadChatConfig(force),
    loadChatHistory: () => features.chatFeature.loadChatHistory(),
    renderChatUsage: () => features.chatFeature.renderChatUsage(),
    focusInputAfterNavigation: () => features.chatFeature.focusInputAfterNavigation(),
    loadPluginsCatalog: () => {
      void features.pluginsFeature.loadCatalog(false);
    },
    loadMcpCatalog: () => {
      void features.mcpFeature.loadCatalog(false);
    },
    setConnectionPolling: (enabled) => features.connectionFeature.setConnectionPolling(enabled),
    getSettingsSelectedTab: () => features.settingsFeature.getSelectedTab(),
    getPanelResizer: () => features.terminalFeature.panelResizer,
    retryTerminalFitUntilMeasured: () => features.terminalFeature.retryTerminalFitUntilMeasured(),
  });
  const openExternal = async (url: string): Promise<void> => {
    if (!(await window.controlPanel.openExternal(url))) {
      showToast('无法打开该帮助或管理地址。', 'error');
    }
  };
  shells.toastShell = toastShell;
  shells.themeShell = themeShell;
  shells.dialogShell = dialogShell;
  shells.railShell = railShell;
  shells.openExternal = openExternal;
};

const installConnectionStack = (
  state: RuntimeState,
  features: FeatureBundle,
  shells: ShellStack,
): void => {
  const { claudeStates, developmentRuntimeStates, getWorkspaceState, runGuarded } = state;
  const { requestConfirmation } = shells.dialogShell;
  const { showToast } = shells.toastShell;
  const { openExternal } = shells;

  const activeStatus = (): TerminalStatus | undefined =>
    getWorkspaceState().sessions.find(
      (status) => status.id === getWorkspaceState().activeSessionId,
    );

  const activeDevelopmentRuntime = (): DevelopmentRuntime => {
    const status = activeStatus();
    return status ? (developmentRuntimeStates.get(status.id)?.runtime ?? 'claude') : 'claude';
  };

  const connectionForm = createConnectionForm({
    getActiveSessionId: () => getWorkspaceState().activeSessionId,
    claudeStates,
    activeStatus,
    renderClaudeState: (state) => shells.terminalProjectState.renderClaudeState(state),
    runGuarded,
    requestConfirmation,
    openExternal: (url) => openExternal(url),
    showToast,
    connectionFeature: {
      clearTestResult: () => features.connectionFeature.clearTestResult(),
      runConnectionTest: (saveOnSuccess, configInput) =>
        features.connectionFeature.runConnectionTest(saveOnSuccess, configInput),
      getDiagnostics: () => features.connectionFeature.getDiagnostics(),
      isTestInProgress: () => features.connectionFeature.isTestInProgress(),
      isRemedyInProgress: () => features.connectionFeature.isRemedyInProgress(),
    },
    loadConnectionHistory: () => {
      void shells.connectionHistory.load();
    },
  });
  shells.connectionForm = connectionForm;
  shells.activeStatus = activeStatus;
  shells.activeDevelopmentRuntime = activeDevelopmentRuntime;
};

const installTerminalProjectStack = (
  state: RuntimeState,
  features: FeatureBundle,
  shells: ShellStack,
): void => {
  const {
    claudeStates,
    codexStates,
    developmentRuntimeStates,
    claudeStateLoadGenerations,
    codexStateLoadGenerations,
    runtimeStateLoadGenerations,
    claudeLaunchAttempts,
    codexLaunchAttempts,
    getWorkspaceState,
  } = state;
  const { connectionForm, activeStatus, activeDevelopmentRuntime } = shells;
  const { requestConfirmation } = shells.dialogShell;
  const { showToast } = shells.toastShell;

  const terminalProjectState = createTerminalProjectState({
    getWorkspaceState,
    activeDevelopmentRuntime,
    claudeStates,
    codexStates,
    developmentRuntimeStates,
    claudeStateLoadGenerations,
    codexStateLoadGenerations,
    runtimeStateLoadGenerations,
    claudeLaunchAttempts,
    codexLaunchAttempts,
    isCodexOperationInProgress: () => shells.codexLaunchShell.isCodexOperationInProgress(),
    connectionForm,
    requestConfirmation,
    showToast,
    setWorkbenchOpen: (open) => shells.workbenchShell.setWorkbenchOpen(open),
    setRuntimeSummaryOpen: (open) => shells.runtimeActivityShell.setRuntimeSummaryOpen(open),
    renderFooterResource: (usage, selectable) =>
      shells.footerShell.renderFooterResource(usage, selectable),
    managedContextWindowSelectable: (state) =>
      shells.footerShell.managedContextWindowSelectable(state),
    renderTerminalFooterChips: (state) => shells.footerShell.renderTerminalFooterChips(state),
    getClaudeContextWindowMode: () => shells.footerShell.getClaudeContextWindowMode(),
    getClaudeContextWindowCustomTokens: () =>
      shells.footerShell.getClaudeContextWindowCustomTokens(),
    applyContextWindowSettings: (settings) =>
      shells.footerShell.applyContextWindowSettings(settings),
    conversationFeature: {
      startingSessionId: () => features.conversationFeature.startingSessionId(),
      hasActiveConversation: () => features.conversationFeature.hasActiveConversation(),
      renderActiveFooter: () => features.conversationFeature.renderActiveFooter(),
    },
    terminalFeature: {
      getTerminalView: (sessionId) => features.terminalFeature.getTerminalView(sessionId),
      setComposerEnabled: (enabled) => features.terminalFeature.setComposerEnabled(enabled),
      showTerminalDiagnostic: (status) => features.terminalFeature.showTerminalDiagnostic(status),
      relaunchClaudeSession: (summary, input) =>
        features.terminalFeature.relaunchClaudeSession(summary, input),
    },
    projectsFeature: {
      displayedConversationTitle: (status) =>
        features.projectsFeature.displayedConversationTitle(status),
      isTitleAnimating: (sessionId) => features.projectsFeature.isTitleAnimating(sessionId),
      renderWorkspace: (state) => features.projectsFeature.renderWorkspace(state),
    },
    routerFeature: {
      getManagementState: () => features.routerFeature.getManagementState(),
      renderRemediation: (state) => features.routerFeature.renderRemediation(state),
    },
    connectionFeature: {
      isTestInProgress: () => features.connectionFeature.isTestInProgress(),
      updateSmartGuidance: () => features.connectionFeature.updateSmartGuidance(),
      scheduleAutomaticConnectionTest: (state) =>
        features.connectionFeature.scheduleAutomaticConnectionTest(state),
    },
    preflightFeature: {
      runActiveNetworkPreflight: (force) =>
        features.preflightFeature.runActiveNetworkPreflight(force),
      isBlocked: (key) => features.preflightFeature.isBlocked(key),
      renderActiveNetworkPreflight: () => features.preflightFeature.renderActiveNetworkPreflight(),
    },
  });
  shells.terminalProjectState = terminalProjectState;

  const codexLaunchShell = createCodexLaunch({
    getWorkspaceState,
    activeStatus,
    activeDevelopmentRuntime,
    codexStates,
    developmentRuntimeStates,
    runtimeStateLoadGenerations,
    codexLaunchAttempts,
    terminalState: terminalProjectState,
    requestConfirmation,
    showToast,
    setWorkbenchOpen: (open) => shells.workbenchShell.setWorkbenchOpen(open),
    terminalFeature: {
      getTerminalView: (sessionId) => features.terminalFeature.getTerminalView(sessionId),
      requestComposerFocus: (sessionId) => features.terminalFeature.requestComposerFocus(sessionId),
      launchClaudeTerminal: (mode) => features.terminalFeature.launchClaudeTerminal(mode),
    },
    preflightFeature: {
      invalidateAndRun: (reason) => features.preflightFeature.invalidateAndRun(reason),
    },
  });
  shells.codexLaunchShell = codexLaunchShell;
};

const installSecondaryShells = (
  state: RuntimeState,
  features: FeatureBundle,
  shells: ShellStack,
): void => {
  const {
    claudeStates,
    codexStates,
    claudeLaunchAttempts,
    claudeSpeedOperations,
    effortRecoveryNotifications,
    runtimeActivityStates,
    titleStatus,
    getWorkspaceState,
  } = state;
  const {
    railShell,
    connectionForm,
    terminalProjectState,
    activeStatus,
    activeDevelopmentRuntime,
    openExternal,
  } = shells;
  const { requestConfirmation } = shells.dialogShell;
  const { showToast } = shells.toastShell;

  const footerShell = createFooterShell({
    activeDevelopmentRuntime,
    activeStatus,
    beginClaudeLaunchAttempt: terminalProjectState.beginClaudeLaunchAttempt,
    beginTerminalMask: (sessionId, label) =>
      features.terminalFeature.beginTerminalMask(sessionId, label),
    claudeLaunchAttempts,
    claudeSpeedOperations,
    claudeStates,
    codexStates,
    effortRecoveryNotifications,
    failClaudeLaunchAttempt: terminalProjectState.failClaudeLaunchAttempt,
    formatTokenCount,
    hasActiveConversation: () => features.conversationFeature.hasActiveConversation(),
    loadClaudeState: terminalProjectState.loadClaudeState,
    openNativeEffortMenu: () => features.conversationFeature.openNativeEffortMenu(),
    openNativeModeMenu: () => features.conversationFeature.openNativeModeMenu(),
    openNativeModelMenu: () => features.conversationFeature.openNativeModelMenu(),
    openNativeSpeedMenu: () => features.conversationFeature.openNativeSpeedMenu(),
    refreshClaudeLaunchControls: terminalProjectState.refreshClaudeLaunchControls,
    relaunchClaudeSession: (summary, input) =>
      features.terminalFeature.relaunchClaudeSession(summary, input),
    renderActiveConversation: () => features.conversationFeature.renderActiveConversation(),
    renderClaudeState: terminalProjectState.renderClaudeState,
    requestConfirmation,
    resultFailureMessage,
    showToast,
  });
  shells.footerShell = footerShell;

  const workbenchShell = createWorkbenchShell({
    closeRailPreview: railShell.closeRailPreview,
    getActiveSessionId: () => getWorkspaceState().activeSessionId,
    activeDevelopmentRuntime,
    activeStatus,
    loadCodexState: terminalProjectState.loadCodexState,
    loadClaudeState: terminalProjectState.loadClaudeState,
    loadConnectionAdvice: () => features.connectionFeature.loadConnectionAdvice(),
    requestConfirmation,
    renderClaudeState: terminalProjectState.renderClaudeState,
    resultFailureMessage,
    getComposerInput: () => features.terminalFeature.getComposerInput(),
    resizeComposer: () => features.terminalFeature.resizeComposer(),
    focusComposer: () => features.terminalFeature.focusComposer(),
    showToast,
  });
  shells.workbenchShell = workbenchShell;

  const { footerStatus } = footerShell;
  const runtimeActivityShell = createRuntimeActivityShell({
    getActiveSessionId: () => getWorkspaceState().activeSessionId,
    runtimeActivityStates,
    getActiveConversationSnapshot: () => features.conversationFeature.activeSnapshot(),
    activeStatus,
    renderActiveStatus: (status) => terminalProjectState.renderActiveStatus(status),
    renderNoActiveSession: () => terminalProjectState.renderNoActiveSession(),
    footerStatus,
    titleStatus,
    nativePhaseLabel,
    openExternal,
    showToast,
  });
  shells.runtimeActivityShell = runtimeActivityShell;

  const requestConnectionHistoryName = (currentName: string): Promise<string | null> =>
    features.projectsFeature.requestRenamedValue(currentName, {
      description: '名称只用于区分当前项目的连接历史，不会修改实际接口配置。',
      fieldLabel: '连接名称',
      title: '重命名连接',
    });

  const connectionHistory = createConnectionHistory({
    activeStatus,
    hideTerminalContextMenu: () => features.terminalFeature.hideTerminalContextMenu(),
    hideConversationContextMenu: () => features.projectsFeature.hideConversationContextMenu(),
    populateClaudeConfigForm: connectionForm.populateClaudeConfigForm,
    renderClaudeState: terminalProjectState.renderClaudeState,
    requestConnectionHistoryName,
    resultFailureMessage,
    showToast,
  });
  shells.connectionHistory = connectionHistory;
};

/**
 * Wires the whole renderer: shared state, the shell stack, feature registration, global
 * handlers, and the startup sequence. `main.ts` only installs the component kit, creates the
 * registry, and calls this.
 */
export const bootstrapApplication = (rendererRegistry: Registry): ApplicationRuntime => {
  const state = createRuntimeState(rendererRegistry);
  const shells = {} as ShellStack;
  const features = {} as FeatureBundle;
  installPrimaryShells(state, features, shells);
  installConnectionStack(state, features, shells);
  installTerminalProjectStack(state, features, shells);
  installSecondaryShells(state, features, shells);
  installFeatureStack(rendererRegistry, state, shells, features);
  const runtime = { ...state, ...shells, ...features } as ApplicationRuntime;
  installGlobalInteractions(runtime);
  installWindowLifecycle(runtime);
  void runStartupSequence(runtime);
  return runtime;
};
