import type { WorkspaceState } from '../shared/contracts';
import { requiredElement } from './platform/dom';
import type { Registry } from './platform/registry';
import {
  formatAttachmentSize,
  formatDuration,
  formatRelativeTime,
  formatTokenCount,
  projectNameFromPath,
  resultFailureMessage,
} from './platform/format';
import { DOWNLOADS_FEATURE, registerDownloadsFeature } from './features/downloads';
import { UPDATES_FEATURE, registerUpdatesFeature } from './features/updates';
import { PREFLIGHT_FEATURE, registerPreflightFeature } from './features/preflight';
import { MCP_FEATURE, registerMcpFeature } from './features/mcp';
import { PLUGINS_FEATURE, registerPluginsFeature } from './features/plugins';
import { PROXY_FEATURE, registerProxyFeature } from './features/proxy';
import { SETTINGS_FEATURE, registerSettingsFeature } from './features/settings';
import { createClaudeExecutionSettingsLoader } from './features/claude-execution-settings/loader';
import { ARTIFACT_FEATURE, registerArtifactFeature } from './features/artifact';
import { ROUTER_FEATURE, registerRouterFeature } from './features/router';
import { CONNECTION_FEATURE, registerConnectionFeature } from './features/connection';
import { CHAT_FEATURE, registerChatFeature } from './features/chat';
import { CONVERSATION_FEATURE, registerConversationFeature } from './features/conversation';
import { PROJECTS_FEATURE, registerProjectsFeature } from './features/projects';
import { TERMINAL_FEATURE, registerTerminalFeature } from './features/terminal';
import { ONBOARDING_FEATURE, registerOnboardingFeature } from './features/onboarding';
import { phaseCopy } from './features/terminal/project-state';
import type { FeatureBundle, RuntimeState, ShellStack } from './runtime-types';

const installUtilityFeatures = (
  rendererRegistry: Registry,
  state: RuntimeState,
  shells: ShellStack,
  features: FeatureBundle,
): void => {
  const { installRouterButton } = state;
  const { activeStatus, terminalProjectState } = shells;
  const { requestConfirmation } = shells.dialogShell;
  const { showToast } = shells.toastShell;
  registerDownloadsFeature(rendererRegistry, {
    formatDuration,
    isRouterOperationInProgress: () => features.routerFeature.isOperationInProgress(),
    requestConfirmation,
    setRouterOperationStage: (stage, detail, percent) =>
      features.routerFeature.setOperationStage(stage, detail, percent),
    showToast,
  });
  features.downloadsFeature = rendererRegistry.resolve(DOWNLOADS_FEATURE);
  const downloadsFeature = features.downloadsFeature;

  registerMcpFeature(rendererRegistry, {
    getActiveStatus: activeStatus,
    requestConfirmation,
    resultFailureMessage,
    showToast,
  });
  features.mcpFeature = rendererRegistry.resolve(MCP_FEATURE);
  const mcpFeature = features.mcpFeature;

  const updatesSyncDelegate: { current: () => void } = { current: () => undefined };
  registerPluginsFeature(rendererRegistry, {
    formatTokenCount,
    requestConfirmation,
    resultFailureMessage,
    showToast,
    syncUpdateActionVisibility: () => updatesSyncDelegate.current(),
  });
  features.pluginsFeature = rendererRegistry.resolve(PLUGINS_FEATURE);
  const pluginsFeature = features.pluginsFeature;

  registerUpdatesFeature(rendererRegistry, {
    applyRouterRelevance: (updates) => features.connectionFeature.applyRouterRelevance(updates),
    downloadsIsOpen: downloadsFeature.isOpen,
    getActiveSessionId: () => activeStatus()?.id,
    getPluginCatalog: pluginsFeature.getCatalog,
    isPluginMutationInProgress: pluginsFeature.isMutationInProgress,
    isRouterOperationInProgress: () => features.routerFeature.isOperationInProgress(),
    loadClaudeState: terminalProjectState.loadClaudeState,
    loadMcpCatalog: mcpFeature.loadCatalog,
    openDownloads: downloadsFeature.open,
    refreshPluginUpdates: pluginsFeature.refreshUpdates,
    requestConfirmation,
    resultFailureMessage,
    runAllPluginUpdates: pluginsFeature.updateAll,
    runPluginUpdate: pluginsFeature.updateOne,
    runRouterUpdate: () => features.routerFeature.runUpdate(),
    setApplicationUpdaterState: downloadsFeature.setApplicationUpdaterState,
    setPluginUpdateActionVisibility: pluginsFeature.setUpdateActionVisibility,
    setRouterUpdateAction: (visible, label) => {
      installRouterButton.hidden = !visible;
      installRouterButton.textContent = label;
    },
    showToast,
  });
  features.updatesFeature = rendererRegistry.resolve(UPDATES_FEATURE);
  const updatesFeature = features.updatesFeature;
  updatesSyncDelegate.current = updatesFeature.syncUpdateActionVisibility;
};

const installSettingsFeatures = (
  rendererRegistry: Registry,
  state: RuntimeState,
  shells: ShellStack,
  features: FeatureBundle,
): void => {
  const {
    cancelConnectionAdvancedButton,
    completeConnectionAdvancedButton,
    claudeStates,
    codexStates,
    chatMessagesElement,
    chatComposer,
    connectionAdvancedDialog,
  } = state;
  const { activeStatus, activeDevelopmentRuntime, themeShell, footerShell, railShell } = shells;
  const { applyTerminalTheme } = themeShell;
  const { footerConnection, footerConnectionLabel } = footerShell;
  const { showToast } = shells.toastShell;
  const { terminalProjectState } = shells;

  registerPreflightFeature(rendererRegistry, {
    getActiveClaudeProvider: () => {
      const status = activeStatus();
      return status ? claudeStates.get(status.id)?.config.provider : undefined;
    },
    getActiveDevelopmentRuntime: activeDevelopmentRuntime,
    refreshActiveRuntimeAfterPreflight: () => {
      const status = activeStatus();
      const codexState = status ? codexStates.get(status.id) : undefined;
      const claudeState = status ? claudeStates.get(status.id) : undefined;
      if (activeDevelopmentRuntime() === 'codex' && codexState) {
        terminalProjectState.renderCodexState(codexState, false);
        return true;
      }
      if (claudeState) {
        terminalProjectState.renderClaudeState(claudeState, true, false);
        return true;
      }
      return false;
    },
    setCodexFooterConnection: ({ busy, disabled, label, tone }) => {
      footerConnection.dataset.tone = tone;
      footerConnection.disabled = disabled;
      footerConnection.setAttribute('aria-busy', String(busy));
      footerConnectionLabel.textContent = label;
    },
    showToast,
  });
  features.preflightFeature = rendererRegistry.resolve(PREFLIGHT_FEATURE);

  const proxyDirtyDelegate: { current: () => boolean } = { current: () => false };
  let executionMutationBusy = false;
  let previousCancelDisabled = false;
  let previousCompleteDisabled = false;
  const setExecutionDialogMutationBusy = (busy: boolean): void => {
    if (busy === executionMutationBusy) return;
    executionMutationBusy = busy;
    if (busy) {
      previousCancelDisabled = cancelConnectionAdvancedButton.disabled;
      previousCompleteDisabled = completeConnectionAdvancedButton.disabled;
      cancelConnectionAdvancedButton.disabled = true;
      completeConnectionAdvancedButton.disabled = true;
      return;
    }
    cancelConnectionAdvancedButton.disabled = previousCancelDisabled;
    completeConnectionAdvancedButton.disabled = previousCompleteDisabled;
  };
  const claudeExecutionSettingsLoader = createClaudeExecutionSettingsLoader({
    featureDependencies: {
      root: requiredElement('#claude-execution-settings-root'),
      setDialogMutationBusy: setExecutionDialogMutationBusy,
      showToast,
      updateUnsavedIndicator: () => features.settingsFeature.updateUnsavedIndicator(),
    },
    importFeature: () => import('./features/claude-execution-settings'),
    showToast,
  });
  registerSettingsFeature(rendererRegistry, {
    applySettingsThemeSelect: themeShell.applySettingsThemeSelect,
    applyTerminalTheme,
    cancelButton: cancelConnectionAdvancedButton,
    closeAdvancedConnectionDialog: (complete) =>
      features.connectionFeature.closeAdvancedDialog(complete),
    completeButton: completeConnectionAdvancedButton,
    disposeClaudeExecutionSettings: claudeExecutionSettingsLoader.dispose,
    endClaudeExecutionDialogSession: claudeExecutionSettingsLoader.endDialogSession,
    getSelectedRailTab: railShell.getSelectedRailTab,
    getSettingsThemeValue: themeShell.getSettingsThemeValue,
    isClaudeExecutionDirty: claudeExecutionSettingsLoader.isDirty,
    isProxyDirty: () => proxyDirtyDelegate.current(),
    loadProxyState: (preserveDirtyDraft) => proxyFeature.loadState(preserveDirtyDraft),
    onAdvancedTabSelected: () => {
      void features.routerFeature.loadAdvancedBackends();
    },
    onClaudeExecutionTabSelected: () => {
      void claudeExecutionSettingsLoader.activate();
    },
    onNetworkTabSelected: () => {
      features.preflightFeature.renderActiveNetworkPreflight();
      void features.preflightFeature.runActiveNetworkPreflight(false);
    },
    onProxyTabSelected: () => {
      void proxyFeature.loadState();
    },
    onRouterTabSelected: () => {
      void features.routerFeature.loadManagement();
      void features.routerFeature.loadKernelState();
    },
    onSettingsLoaded: (settings) => {
      footerShell.setFooterResourcePreference(settings.footerResourcePreference);
      footerShell.setManagedChatGptContextWindowMode(settings.managedChatGptContextWindowMode);
    },
    saveClaudeExecutionPending: claudeExecutionSettingsLoader.savePending,
    saveProxyPending: () => proxyFeature.savePending(),
    setConnectionPolling: (enabled) => features.connectionFeature.setConnectionPolling(enabled),
    showToast,
  });
  features.settingsFeature = rendererRegistry.resolve(SETTINGS_FEATURE);
  const settingsFeature = features.settingsFeature;
  registerProxyFeature(rendererRegistry, {
    isAdvancedConnectionDialogOpen: () => connectionAdvancedDialog.open,
    refreshPreflight: () => features.preflightFeature.refreshAfterAuthoritativeChange(),
    showToast,
    updateSettingsUnsavedIndicator: settingsFeature.updateUnsavedIndicator,
  });
  features.proxyFeature = rendererRegistry.resolve(PROXY_FEATURE);
  const proxyFeature = features.proxyFeature;
  proxyDirtyDelegate.current = proxyFeature.isDirty;
  registerArtifactFeature(rendererRegistry, {
    getActiveTheme: themeShell.getActiveTerminalTheme,
    setChatInert: (open) => {
      chatMessagesElement.inert = open;
      chatComposer.inert = open;
    },
    showToast,
  });
  features.artifactFeature = rendererRegistry.resolve(ARTIFACT_FEATURE);
  const artifactFeature = features.artifactFeature;
  themeShell.setArtifactThemeUpdateHandler(artifactFeature.updateTheme);
};

const installConversationFeatures = (
  rendererRegistry: Registry,
  state: RuntimeState,
  shells: ShellStack,
  features: FeatureBundle,
): void => {
  const { chatMessagesElement, chatComposer, claudeStates, runtimeActivityStates } = state;
  const { getWorkspaceState, getWindowsBuildNumber } = state;
  const {
    activeStatus,
    themeShell,
    terminalProjectState,
    runtimeActivityShell,
    railShell,
    footerShell,
  } = shells;
  const { chatShell, terminalShell } = railShell;
  const {
    footerEffort,
    footerEffortMenu,
    footerMode,
    footerModeMenu,
    footerModel,
    footerModelMenu,
    footerSpeed,
    footerSpeedMenu,
    buildFooterRadioMenuItem,
    openFooterMenu,
    managedContextWindowSelectable,
    renderFooterResource,
    requestedClaudeContextWindowTokens,
  } = shells.footerShell;
  const { claudeWorkbench } = shells.workbenchShell;
  const { requestConfirmation } = shells.dialogShell;
  const { showToast } = shells.toastShell;

  registerChatFeature(rendererRegistry, {
    chatComposer,
    chatMessagesElement,
    chatShell,
    formatAttachmentSize,
    formatTokenCount,
    getMarkdownRenderer: themeShell.getMarkdownRenderer,
    isArtifactDetailsOpen: () => features.artifactFeature.isDetailsOpen(),
    isChatView: () => railShell.getMainView() === 'chat',
    playSendAnimation: (text, source, variant) =>
      terminalFeature.playSendAnimation(text, source, variant),
    requestConfirmation,
    requestConversationTitle: (currentTitle: string, historical: boolean) =>
      features.projectsFeature.requestConversationTitle(currentTitle, historical),
    resultFailureMessage,
    runGuarded: state.runGuarded,
    showToast,
    stopArtifacts: () => features.artifactFeature.stopAll(),
  });
  features.chatFeature = rendererRegistry.resolve(CHAT_FEATURE);
  registerConversationFeature(rendererRegistry, {
    terminalShell,
    footerEffort,
    footerEffortMenu,
    footerMode,
    footerModeMenu,
    footerModel,
    footerModelMenu,
    footerSpeed,
    footerSpeedMenu,
    activeStatus,
    buildFooterRadioMenuItem,
    expandFolder: (folder: string) => features.projectsFeature.expandFolder(folder),
    focusActiveTerminal: () => terminalFeature.focusActiveTerminal(),
    formatAttachmentSize,
    getActiveSessionId: () => getWorkspaceState().activeSessionId,
    getClaudeState: (sessionId: string) => claudeStates.get(sessionId),
    getManagedChatGptContextWindowMode: () => footerShell.getManagedChatGptContextWindowMode(),
    getMarkdownRenderer: themeShell.getMarkdownRenderer,
    getRuntimeActivity: (sessionId: string) => runtimeActivityStates.get(sessionId),
    getStoredConversations: (folder: string) =>
      features.projectsFeature.getStoredConversations(folder),
    getWorkspaceState,
    loadFolderHistory: (projectPath: string, force?: boolean) =>
      features.projectsFeature.loadFolderHistory(projectPath, force),
    managedContextWindowSelectable,
    openFooterMenu,
    refreshClaudeLaunchControls: terminalProjectState.refreshClaudeLaunchControls,
    renderFooterResource,
    renderRuntimeActivity: runtimeActivityShell.renderRuntimeActivity,
    renderWorkspace: (state: WorkspaceState) => features.projectsFeature.renderWorkspace(state),
    requestConfirmation,
    requestedClaudeContextWindowTokens,
    resultFailureMessage,
    retryTerminalFitUntilMeasured: () => terminalFeature.retryTerminalFitUntilMeasured(),
    selectRailTab: railShell.selectRailTab,
    setRuntimeSummaryOpen: runtimeActivityShell.setRuntimeSummaryOpen,
    showToast,
    terminalThemeSelect: themeShell.terminalThemeSelect,
  });
  features.conversationFeature = rendererRegistry.resolve(CONVERSATION_FEATURE);
  const conversationFeature = features.conversationFeature;
  registerTerminalFeature(rendererRegistry, {
    activeStatus,
    beginClaudeLaunchAttempt: terminalProjectState.beginClaudeLaunchAttempt,
    claudeLaunchAttempts: state.claudeLaunchAttempts,
    failClaudeLaunchAttempt: terminalProjectState.failClaudeLaunchAttempt,
    getActiveTheme: themeShell.getActiveTerminalTheme,
    getClaudeWorkbench: () => claudeWorkbench,
    getWindowsBuildNumber,
    getWorkspaceState,
    handleOperation: terminalProjectState.handleOperation,
    hideConversationContextMenu: () => features.projectsFeature.hideConversationContextMenu(),
    loadClaudeState: terminalProjectState.loadClaudeState,
    projectNameFromPath,
    refreshClaudeLaunchControls: terminalProjectState.refreshClaudeLaunchControls,
    setClaudeLaunchPaused: terminalProjectState.setClaudeLaunchPaused,
    renderClaudeLaunchResult: terminalProjectState.renderClaudeLaunchResult,
    requestConfirmation,
    resultFailureMessage,
    setNativePanelVisible: (visible) => conversationFeature.setPanelVisible(visible),
    showToast,
  });
  features.terminalFeature = rendererRegistry.resolve(TERMINAL_FEATURE);
  const terminalFeature = features.terminalFeature;
  themeShell.setTerminalViewsProvider(() => terminalFeature.getTerminalViews());
  railShell.reconcileCompactRail();
};

const installManagementFeatures = (
  rendererRegistry: Registry,
  state: RuntimeState,
  shells: ShellStack,
  features: FeatureBundle,
): void => {
  const {
    importCurlRouterButton,
    installRouterButton,
    startRouterButton,
    routerActions,
    routerManager,
    cancelConnectionAdvancedButton,
    closeConnectionAdvancedButton,
    completeConnectionAdvancedButton,
    connectionAdvancedDialog,
    openConnectionAdvancedButton,
    claudeStates,
    developmentRuntimeStates,
    getWorkspaceState,
    runGuarded,
  } = state;
  const {
    activeStatus,
    connectionForm,
    terminalProjectState,
    connectionHistory,
    railShell,
    openExternal,
  } = shells;
  const { requestConfirmation } = shells.dialogShell;
  const { showToast } = shells.toastShell;

  registerRouterFeature(rendererRegistry, {
    activeStatus,
    applyRouterRelevance: () => features.updatesFeature.applyRouterRelevance(),
    getCurlAnalysis: () => connectionFeature.getCurlAnalysis(),
    getActiveProjectState: () => claudeStates.get(getWorkspaceState().activeSessionId),
    importCurlRouterButton,
    installRouterButton,
    loadConnectionHistory: connectionHistory.load,
    loadGatewayDiagnostics: () => connectionFeature.loadGatewayDiagnostics(),
    loadSoftwareUpdates: features.updatesFeature.loadSoftwareUpdates,
    populateClaudeConfigForm: connectionForm.populateClaudeConfigForm,
    renderClaudeState: terminalProjectState.renderClaudeState,
    renderConnectionTest: (result) => connectionFeature.renderConnectionTest(result),
    requestConfirmation,
    resultFailureMessage,
    runGuarded,
    showToast,
    startRouterButton,
    syncUpdateActionVisibility: features.updatesFeature.syncUpdateActionVisibility,
    updateSmartGuidance: () => connectionFeature.updateSmartGuidance(),
  });
  features.routerFeature = rendererRegistry.resolve(ROUTER_FEATURE);
  const routerFeature = features.routerFeature;

  registerConnectionFeature(rendererRegistry, {
    activeStatus,
    applyPresetUi: connectionForm.applyPresetUi,
    cancelConnectionAdvancedButton,
    captureAdvancedConnectionSnapshot: connectionForm.captureAdvancedConnectionSnapshot,
    claudeAuthMode: connectionForm.claudeAuthMode,
    claudeBaseUrl: connectionForm.claudeBaseUrl,
    claudeConfigForm: connectionForm.claudeConfigForm,
    claudeCredential: connectionForm.claudeCredential,
    claudeModel: connectionForm.claudeModel,
    claudeModelFast: connectionForm.claudeModelFast,
    claudePreset: connectionForm.claudePreset,
    clearProviderSelection: connectionForm.clearProviderSelection,
    closeConnectionAdvancedButton,
    closeRailPreview: railShell.closeRailPreview,
    completeConnectionAdvancedButton,
    connectionAdvancedDialog,
    connectionAdvice: connectionForm.connectionAdvice,
    connectionRemedyActions: connectionForm.connectionRemedyActions,
    credentialField: connectionForm.credentialField,
    currentConfigInput: connectionForm.currentConfigInput,
    environmentSetup: connectionForm.environmentSetup,
    getActiveSessionId: () => getWorkspaceState().activeSessionId,
    getClaudeState: (sessionId) => claudeStates.get(sessionId),
    getDevelopmentRuntime: (sessionId) => developmentRuntimeStates.get(sessionId),
    getSelectedProviderId: connectionForm.getSelectedProviderId,
    getSelectedRailTab: railShell.getSelectedRailTab,
    importCurlRouterButton,
    installRouterButton,
    loadClaudeState: terminalProjectState.loadClaudeState,
    openConnectionAdvancedButton,
    openExternal,
    providerPicker: connectionForm.providerPicker,
    proxy: {
      beginDialogLoad: features.proxyFeature.beginDialogLoad,
      completeDialogLoad: features.proxyFeature.completeDialogLoad,
      endDialogSession: features.proxyFeature.endDialogSession,
      loadState: features.proxyFeature.loadState,
    },
    renderClaudeState: terminalProjectState.renderClaudeState,
    restoreAdvancedConnectionSnapshot: connectionForm.restoreAdvancedConnectionSnapshot,
    resultFailureMessage,
    router: {
      getManagementState: routerFeature.getManagementState,
      isOperationInProgress: routerFeature.isOperationInProgress,
      loadManagement: routerFeature.loadManagement,
      renderRouterManagement: routerFeature.renderRouterManagement,
      runOperation: routerFeature.runOperation,
      runRouterProviderSave: routerFeature.runRouterProviderSave,
      uninstallRouterCli: routerFeature.uninstallRouterCli,
    },
    routerActions,
    routerManager,
    runGuarded,
    savedClaudeConfigInput: connectionForm.savedClaudeConfigInput,
    saveClaudeConfig: connectionForm.saveClaudeConfig,
    selectRailTab: railShell.selectRailTab,
    setAuthOptions: connectionForm.setAuthOptions,
    settings: {
      endDialogSession: features.settingsFeature.endDialogSession,
      loadAppSettings: features.settingsFeature.loadAppSettings,
      savePending: features.settingsFeature.savePending,
      selectGeneralTab: () => features.settingsFeature.selectTab('general'),
      updateUnsavedIndicator: features.settingsFeature.updateUnsavedIndicator,
    },
    showToast,
    startRouterButton,
    syncApiKeyHelperPolicyUi: connectionForm.syncApiKeyHelperPolicyUi,
    syncConnectionInteractivity: connectionForm.syncConnectionInteractivity,
    updates: {
      applyRouterRelevance: features.updatesFeature.applyRouterRelevance,
      loadSoftwareUpdates: features.updatesFeature.loadSoftwareUpdates,
      runClaudeInstallUpdate: features.updatesFeature.runClaudeInstallUpdate,
    },
  });
  features.connectionFeature = rendererRegistry.resolve(CONNECTION_FEATURE);
  const connectionFeature = features.connectionFeature;
};

const installProjectFeatures = (
  rendererRegistry: Registry,
  state: RuntimeState,
  shells: ShellStack,
  features: FeatureBundle,
): void => {
  const {
    claudeLaunchAttempts,
    claudeSpeedOperations,
    claudeStateLoadGenerations,
    claudeStates,
    codexLaunchAttempts,
    codexStateLoadGenerations,
    codexStates,
    developmentRuntimeStates,
    effortRecoveryNotifications,
    runtimeActivityStates,
    runtimeStateLoadGenerations,
    getWorkspaceState,
    getLastClaudeSessionId,
    setLastClaudeSessionId,
    setWorkspaceState,
  } = state;
  const {
    activeStatus,
    activeDevelopmentRuntime,
    connectionForm,
    terminalProjectState,
    codexLaunchShell,
    connectionHistory,
    railShell,
    runtimeActivityShell,
  } = shells;
  const { workbenchScope } = shells.workbenchShell;
  const { requestConfirmation } = shells.dialogShell;
  const { showToast } = shells.toastShell;

  registerProjectsFeature(rendererRegistry, {
    activeDevelopmentRuntime,
    activeStatus,
    beginClaudeLaunchAttempt: terminalProjectState.beginClaudeLaunchAttempt,
    claudeLaunchAttempts,
    claudeSpeedOperations,
    claudeStateLoadGenerations,
    claudeStates,
    clearProviderSelection: connectionForm.clearProviderSelection,
    codexLaunchAttempts,
    codexStateLoadGenerations,
    codexStates,
    developmentRuntimeStates,
    disposeTerminalView: features.terminalFeature.disposeTerminalView,
    effortRecoveryNotifications,
    ensureTerminalView: features.terminalFeature.ensureTerminalView,
    failClaudeLaunchAttempt: terminalProjectState.failClaudeLaunchAttempt,
    flushPendingComposerFocus: features.terminalFeature.flushPendingComposerFocus,
    forgetSession: (sessionId) => features.connectionFeature.forgetSession(sessionId),
    formatRelativeTime,
    getCodexAutoLaunchSessionId: () => codexLaunchShell.getCodexAutoLaunchSessionId(),
    getLastClaudeSessionId,
    getPendingComposerFocusSessionId: () =>
      features.terminalFeature.getPendingComposerFocusSessionId(),
    getSelectedRailTab: railShell.getSelectedRailTab,
    getTerminalView: (sessionId) => features.terminalFeature.getTerminalView(sessionId),
    getTerminalViews: () => features.terminalFeature.getTerminalViews(),
    getWorkspaceState,
    hideTerminalContextMenu: features.terminalFeature.hideTerminalContextMenu,
    loadConnectionAdvice: () => features.connectionFeature.loadConnectionAdvice(),
    loadConnectionHistory: connectionHistory.load,
    loadDevelopmentRuntime: terminalProjectState.loadDevelopmentRuntime,
    loadRouterManagement: () => features.routerFeature.loadManagement(),
    phaseCopy,
    projectNameFromPath,
    pruneTerminalControlOperations: features.terminalFeature.pruneTerminalControlOperations,
    reconcileBinding: (state) => features.conversationFeature.reconcileBinding(state),
    renderActiveStatus: terminalProjectState.renderActiveStatus,
    renderConnectionHistory: connectionHistory.render,
    renderCodexState: terminalProjectState.renderCodexState,
    renderDevelopmentRuntimeState: terminalProjectState.renderDevelopmentRuntimeState,
    renderNoActiveSession: terminalProjectState.renderNoActiveSession,
    renderRuntimeActivity: runtimeActivityShell.renderRuntimeActivity,
    renderClaudeLaunchResult: terminalProjectState.renderClaudeLaunchResult,
    refreshClaudeLaunchControls: terminalProjectState.refreshClaudeLaunchControls,
    requestComposerFocus: features.terminalFeature.requestComposerFocus,
    requestConfirmation,
    resolveClaudeLaunchDecision: features.terminalFeature.resolveClaudeLaunchDecision,
    resetForProjectChange: () => features.connectionFeature.resetForProjectChange(),
    resetProviderForm: () => features.routerFeature.resetProviderForm(),
    resultFailureMessage,
    retryTerminalFitUntilMeasured: features.terminalFeature.retryTerminalFitUntilMeasured,
    runtimeActivityStates,
    runtimeStateLoadGenerations,
    setCodexAutoLaunchSessionId: (sessionId) => {
      codexLaunchShell.setCodexAutoLaunchSessionId(sessionId);
    },
    setConfigFormSessionId: connectionForm.setConfigFormSessionId,
    setConnectionEnvironmentReady: connectionForm.setConnectionEnvironmentReady,
    setConnectionHistoryEntries: connectionHistory.setEntries,
    setLastClaudeSessionId,
    setNativePanelVisible: (visible) => features.conversationFeature.setPanelVisible(visible),
    setPendingComposerFocusSessionId: (sessionId) => {
      features.terminalFeature.setPendingComposerFocusSessionId(sessionId);
    },
    setProviderGroupExpansionPending: connectionForm.setProviderGroupExpansionPending,
    setWorkspaceState,
    showToast,
    terminalProject: terminalProjectState.terminalProject,
    workbenchScope,
  });
  features.projectsFeature = rendererRegistry.resolve(PROJECTS_FEATURE);
  registerOnboardingFeature(rendererRegistry, {
    closeSettingsDialog: () => features.connectionFeature.closeAdvancedDialog(false),
    getWorkspaceState,
    openDirectoryPicker: features.projectsFeature.openDirectoryPicker,
    reopenSettingsDialog: () => state.openConnectionAdvancedButton.click(),
    selectRailTab: railShell.selectRailTab,
    showToast,
  });
  features.onboardingFeature = rendererRegistry.resolve(ONBOARDING_FEATURE);
};

/**
 * Bridge/control-plane subscriptions, the route-health shortcut, and the beforeunload teardown.
 * These run once every feature is registered, so all bundle members are safe to destructure.
 */
const installApplicationSubscriptions = (
  state: RuntimeState,
  shells: ShellStack,
  features: FeatureBundle,
): void => {
  const { routeHealthAction, runtimeActivityStates, getWorkspaceState } = state;
  const {
    terminalProjectState,
    codexLaunchShell,
    runtimeActivityShell,
    workbenchShell,
    railShell,
    dialogShell,
    connectionForm,
    themeShell,
    activeDevelopmentRuntime,
  } = shells;
  const {
    connectionFeature,
    projectsFeature,
    conversationFeature,
    downloadsFeature,
    updatesFeature,
    mcpFeature,
    pluginsFeature,
    proxyFeature,
    routerFeature,
    settingsFeature,
    artifactFeature,
    chatFeature,
    preflightFeature,
    terminalFeature,
    onboardingFeature,
  } = features;

  const unsubscribeAppWindowRestored = window.controlPanel.onAppWindowRestored(() => {
    connectionFeature.rerunAutomaticConnectionTestForActiveProject();
  });
  window.controlPanel.onClaudeState(terminalProjectState.renderClaudeState);
  window.controlPanel.onCodexState((state) => {
    terminalProjectState.renderCodexState(state);
    if (codexLaunchShell.getCodexAutoLaunchSessionId() !== state.sessionId || !state.account) {
      return;
    }
    const active = state.sessionId === getWorkspaceState().activeSessionId;
    if (!active) {
      codexLaunchShell.setCodexAutoLaunchSessionId('');
      return;
    }
    if (activeDevelopmentRuntime() === 'codex' && !codexLaunchShell.isCodexOperationInProgress()) {
      codexLaunchShell.setCodexAutoLaunchSessionId('');
      void codexLaunchShell.launchCodex('new');
    }
  });
  const unsubscribeRuntimeActivityChanged = window.controlPanel.onRuntimeActivityChanged(
    (state) => {
      runtimeActivityStates.set(state.sessionId, state);
      if (state.sessionId === getWorkspaceState().activeSessionId)
        runtimeActivityShell.renderRuntimeActivity(state);
    },
  );
  window.controlPanel.onWorkspaceState((state) => {
    projectsFeature.renderWorkspace(state);
    onboardingFeature.renderWorkspace(state);
    terminalFeature.reconcileClaudeLaunchDecision(state);
    void runtimeActivityShell.loadActiveRuntimeActivity();
    void conversationFeature.refreshRecoveries();
  });
  routeHealthAction.addEventListener('click', () => {
    workbenchShell.setWorkbenchOpen(false);
    railShell.selectRailTab('connection');
  });
  window.addEventListener('beforeunload', () => {
    railShell.dispose();
    dialogShell.dispose();
    unsubscribeAppWindowRestored();
    downloadsFeature.dispose();
    updatesFeature.dispose();
    mcpFeature.dispose();
    pluginsFeature.dispose();
    proxyFeature.dispose();
    settingsFeature.dispose();
    connectionForm.unsubscribeManagedChatGptSetupProgress();
    routerFeature.dispose();
    connectionFeature.dispose();
    unsubscribeRuntimeActivityChanged();
    conversationFeature.dispose();
    preflightFeature.dispose();
    chatFeature.dispose();
    artifactFeature.dispose();
    themeShell.dispose();
    terminalFeature.dispose();
    onboardingFeature.dispose();
  });
};

/**
 * Registers every renderer feature on the shared registry in dependency order and mounts the
 * resolved instances onto `features`.
 */
export const installFeatureStack = (
  rendererRegistry: Registry,
  state: RuntimeState,
  shells: ShellStack,
  features: FeatureBundle,
): void => {
  installUtilityFeatures(rendererRegistry, state, shells, features);
  installSettingsFeatures(rendererRegistry, state, shells, features);
  installConversationFeatures(rendererRegistry, state, shells, features);
  installManagementFeatures(rendererRegistry, state, shells, features);
  installProjectFeatures(rendererRegistry, state, shells, features);
  installApplicationSubscriptions(state, shells, features);
};
