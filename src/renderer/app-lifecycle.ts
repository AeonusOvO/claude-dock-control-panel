import {
  handleFooterMenuArrowKey,
  handleFooterMenuEscape,
  type FooterMenuPair,
} from './shell/footer-keyboard';
import { resultFailureMessage } from './platform/format';
import type { AppSettingsView } from '../shared/contracts';
import type { ApplicationRuntime } from './runtime-types';

/**
 * Installs document- and window-level interaction handlers that span features: keyboard
 * navigation, footer triggers, launch controls, external links, and dismiss-on-pointerdown.
 */
export const installGlobalInteractions = (runtime: ApplicationRuntime): void => {
  const {
    claudeStates,
    connectionForm,
    activeStatus,
    activeDevelopmentRuntime,
    runGuarded,
    openExternal,
    terminalProjectState,
    terminalFeature,
    preflightFeature,
    connectionFeature,
    artifactFeature,
    railShell,
    projectsFeature,
    connectionHistory,
    runtimeActivityShell,
  } = runtime;
  const { showToast } = runtime.toastShell;
  const {
    footerConnection,
    footerResource,
    footerModel,
    footerSpeed,
    footerMode,
    footerEffort,
    footerResourceMenu,
    footerModelMenu,
    footerSpeedMenu,
    footerModeMenu,
    footerEffortMenu,
    hideFooterMenus,
  } = runtime.footerShell;

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && artifactFeature.isDetailsOpen()) {
      event.preventDefault();
      artifactFeature.setDetailsOpen(false);
    }
    if (event.key === 'Escape' && railShell.escapeRailPreview()) {
      event.preventDefault();
    }
    // Escape closes any open option menu before the containing session-settings region. This keeps
    // focus on a visible setting trigger so a second Escape can close the disclosure.
    const footerMenuPairs: readonly FooterMenuPair[] = [
      { menu: footerResourceMenu, trigger: footerResource },
      { menu: footerModelMenu, trigger: footerModel },
      { menu: footerSpeedMenu, trigger: footerSpeed },
      { menu: footerModeMenu, trigger: footerMode },
      { menu: footerEffortMenu, trigger: footerEffort },
    ];
    if (event.key === 'Escape') {
      if (handleFooterMenuEscape(footerMenuPairs)) {
        event.preventDefault();
        return;
      }
    }
    // Arrow key navigation within footer menus
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      if (handleFooterMenuArrowKey(footerMenuPairs, event.key, document.activeElement)) {
        event.preventDefault();
      }
    }
  });
  footerConnection.addEventListener('click', () => {
    if (activeDevelopmentRuntime() === 'codex') {
      void preflightFeature.openNetworkPreflightDialog();
      if (!preflightFeature.hasActiveResult()) {
        void preflightFeature.runActiveNetworkPreflight(false);
      }
      return;
    }
    if (connectionFeature.isTestInProgress()) {
      return;
    }
    const status = activeStatus();
    const state = status ? claudeStates.get(status.id) : undefined;
    if (!state) {
      showToast('无法读取当前接入配置。', 'error');
      return;
    }
    void connectionFeature.runConnectionTest(
      false,
      connectionForm.savedClaudeConfigInput(state.config),
    );
  });
  terminalProjectState.allowBypassPermissions.addEventListener('change', () => {
    const status = activeStatus();
    if (!status) {
      return;
    }
    void window.controlPanel
      .setClaudeAllowBypassPermissions(
        status.id,
        terminalProjectState.allowBypassPermissions.checked,
      )
      .then((result) => {
        terminalProjectState.renderClaudeState(result.state);
        if (!result.ok) {
          showToast(resultFailureMessage(result, '无法保存放权设置。'), 'error');
        }
      })
      .catch(() => {
        showToast('无法保存放权设置。', 'error');
      });
  });
  terminalProjectState.launchNewButton.addEventListener('click', () => {
    void terminalFeature.launchClaudeTerminal('new');
  });
  terminalProjectState.launchContinueButton.addEventListener('click', () => {
    void terminalFeature.launchClaudeTerminal('continue');
  });
  terminalProjectState.launchResumeButton.addEventListener('click', () => {
    void terminalFeature.launchClaudeTerminal('resume');
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-external-url]')) {
    button.addEventListener('click', () => {
      const url = button.dataset.externalUrl;
      if (url) {
        void runGuarded(button, '正在打开…', () => openExternal(url));
      }
    });
  }
  document.addEventListener('pointerdown', (event) => {
    if (!terminalFeature.terminalContextMenu.contains(event.target as Node)) {
      terminalFeature.hideTerminalContextMenu();
    }
    if (!projectsFeature.conversationContextMenu.contains(event.target as Node)) {
      projectsFeature.hideConversationContextMenu();
    }
    if (!connectionHistory.historyContextMenu.contains(event.target as Node)) {
      connectionHistory.hideContextMenu();
    }
    if (
      !footerResourceMenu.contains(event.target as Node) &&
      !footerModelMenu.contains(event.target as Node) &&
      !footerSpeedMenu.contains(event.target as Node) &&
      !footerModeMenu.contains(event.target as Node) &&
      !footerEffortMenu.contains(event.target as Node) &&
      !footerResource.contains(event.target as Node) &&
      !footerModel.contains(event.target as Node) &&
      !footerSpeed.contains(event.target as Node) &&
      !footerMode.contains(event.target as Node) &&
      !footerEffort.contains(event.target as Node)
    ) {
      hideFooterMenus();
    }
    if (
      !runtimeActivityShell.runtimeActivityPanel.hidden &&
      !runtimeActivityShell.runtimeActivityPanel.contains(event.target as Node) &&
      !runtimeActivityShell.runtimeActivityTrigger.contains(event.target as Node)
    ) {
      runtimeActivityShell.setRuntimeSummaryOpen(false);
    }
  });
};

const waitForStartupModelConnection = async (): Promise<void> => {
  let initial;
  try {
    initial = await window.controlPanel.getStartupModelConnection();
  } catch {
    return;
  }
  if (!initial.active) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let unsubscribe = (): void => undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      unsubscribe();
      resolve();
    };
    const reconcile = (): void => {
      void window.controlPanel
        .getStartupModelConnection()
        .then((state) => {
          if (!state.active) finish();
        })
        .catch(() => undefined);
    };
    unsubscribe = window.controlPanel.onStartupModelConnectionChanged((state) => {
      if (!state.active) finish();
    });
    const pollTimer = window.setInterval(reconcile, 1_000);
    reconcile();
  });
};

/**
 * Installs window-level lifecycle handlers: focus/blur/visibility reconciliation, drag-and-drop
 * project import, and window resize cleanups.
 */
export const installWindowLifecycle = (runtime: ApplicationRuntime): void => {
  const {
    dropOverlay,
    getDragDepth,
    setDragDepth,
    railShell,
    terminalFeature,
    projectsFeature,
    connectionHistory,
    runtimeActivityShell,
    chatFeature,
  } = runtime;
  const { showToast } = runtime.toastShell;
  const { hideFooterMenus } = runtime.footerShell;

  window.addEventListener('blur', () => {
    terminalFeature.cancelActiveResizes();
    terminalFeature.hideTerminalContextMenu();
    projectsFeature.hideConversationContextMenu();
    connectionHistory.hideContextMenu();
    hideFooterMenus();
    runtimeActivityShell.setRuntimeSummaryOpen(false);
    railShell.closeRailPreview();
  });
  window.addEventListener('resize', () => {
    railShell.closeRailPreview();
  });

  window.addEventListener('focus', () => {
    // Tray restoration is a fresh layout/focus boundary even when Chromium missed the earlier blur.
    terminalFeature.cancelActiveResizes();
    void projectsFeature.reconcileWorkspaceAfterActivation();
    terminalFeature.retryTerminalFitUntilMeasured();
    terminalFeature.flushPendingComposerFocus();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void projectsFeature.reconcileWorkspaceAfterActivation();
      terminalFeature.retryTerminalFitUntilMeasured();
      terminalFeature.flushPendingComposerFocus();
    } else {
      terminalFeature.cancelActiveResizes();
    }
  });

  document.addEventListener('dragenter', (event) => {
    event.preventDefault();
    setDragDepth(getDragDepth() + 1);
    const title = dropOverlay.querySelector('strong');
    const detail = dropOverlay.querySelector('span');
    if (title && detail) {
      title.textContent =
        railShell.getMainView() === 'chat' ? '松开以添加到当前消息' : '松开以添加项目';
      detail.textContent =
        railShell.getMainView() === 'chat'
          ? '支持图片、PDF、CSV 与纯文本；文件只会复制到本机应用数据目录'
          : '将为该项目创建独立终端会话';
    }
    dropOverlay.classList.add('drop-overlay--visible');
  });
  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });
  document.addEventListener('dragleave', (event) => {
    event.preventDefault();
    setDragDepth(Math.max(0, getDragDepth() - 1));
    if (getDragDepth() === 0) {
      dropOverlay.classList.remove('drop-overlay--visible');
    }
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    setDragDepth(0);
    dropOverlay.classList.remove('drop-overlay--visible');

    const files = Array.from(event.dataTransfer?.files ?? []);
    const file = files[0];
    if (!file) {
      showToast('没有检测到文件夹。', 'error');
      return;
    }

    try {
      if (railShell.getMainView() === 'chat') {
        chatFeature.queueAttachmentImport(files);
        return;
      }
      const directoryPath = window.controlPanel.getDroppedPath(file);
      if (!directoryPath) {
        showToast('无法读取拖入项目的路径。', 'error');
        return;
      }
      void projectsFeature.addProject(directoryPath);
    } catch {
      showToast('无法读取拖入项目的路径。', 'error');
    }
  });
};

/**
 * Runs the post-registration startup sequence: initial downloads, settings hydration, theme
 * application, workspace render, deferred update checks, and terminal launch for a running
 * session.
 */
export const runStartupSequence = async (runtime: ApplicationRuntime): Promise<void> => {
  const {
    downloadsFeature,
    proxyFeature,
    artifactFeature,
    footerShell,
    settingsFeature,
    themeShell,
    projectsFeature,
    runtimeActivityShell,
    preflightFeature,
    updatesFeature,
    activeStatus,
    connectionHistory,
    terminalFeature,
    onboardingFeature,
    setWindowsBuildNumber,
  } = runtime;
  const { applyTerminalTheme } = themeShell;
  let initialSettings: AppSettingsView | undefined;

  await downloadsFeature.load();
  void proxyFeature.loadState();
  try {
    initialSettings = await window.controlPanel.getAppSettings();
    const reportedWindowsBuild = initialSettings.windowsBuildNumber;
    setWindowsBuildNumber(
      typeof reportedWindowsBuild === 'number' &&
        Number.isInteger(reportedWindowsBuild) &&
        reportedWindowsBuild > 0
        ? reportedWindowsBuild
        : undefined,
    );
    artifactFeature.applyNetworkAllowed(initialSettings.artifactNetworkAllowed ?? true);
    footerShell.applyLoadedSettings(initialSettings);
    settingsFeature.setCloseBehaviorValue(initialSettings.closeBehavior);
    artifactFeature.renderNetworkLog();
    if (initialSettings.theme !== themeShell.getActiveTerminalTheme()) {
      applyTerminalTheme(initialSettings.theme, false, false);
    }
  } catch {
    // The terminal still works without Windows-specific reflow hints; settings can be retried later.
  }
  projectsFeature.renderWorkspace(await window.controlPanel.getWorkspace());
  await onboardingFeature.initialize();
  if (initialSettings) {
    if (initialSettings.conversationResume.autoLoadLastConversationModelOnStartup) {
      await waitForStartupModelConnection();
    }
    await projectsFeature.restoreLastConversationOnStartup(initialSettings.conversationResume);
  }
  void runtimeActivityShell.loadActiveRuntimeActivity();
  window.setTimeout(() => {
    void preflightFeature.runActiveNetworkPreflight(false);
  }, 0);
  // Let first paint and workspace hydration complete, then check all update sources without
  // blocking terminal startup or requiring the user to open the connection/plugins pages.
  window.setTimeout(() => {
    void updatesFeature.refreshAvailableUpdates(false);
  }, 0);
  const status = activeStatus();
  // No session means no project has been opened yet: leave the empty state up rather than
  // spawning a terminal the user did not ask for.
  if (!status) {
    return;
  }

  const preserveComposerFocusIntent = status.phase === 'running' || status.phase === 'starting';
  if (status.phase !== 'running' && status.phase !== 'starting') {
    await terminalFeature.startTerminal(status);
  }
  void connectionHistory.load();
  terminalFeature.retryTerminalFitUntilMeasured();
  if (preserveComposerFocusIntent) {
    terminalFeature.requestComposerFocus(status.id);
  }
};
