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

interface DroppedEntry {
  file: File;
  /** Undefined means the host did not expose enough metadata to distinguish a file from a folder. */
  isDirectory: boolean | undefined;
}

const droppedEntriesFromEvent = (event: DragEvent): DroppedEntry[] => {
  const transfer = event.dataTransfer;
  const files = Array.from(transfer?.files ?? []);
  const items = Array.from(transfer?.items ?? []).filter(({ kind }) => kind === 'file');
  if (items.length === 0) {
    // `DataTransfer.files` does not identify folders. Keep the drop explicitly ambiguous instead of
    // routing ordinary files through the project-add path or injecting an unverified path.
    return files.map((file) => ({ file, isDirectory: undefined }));
  }

  let fallbackFileIndex = 0;
  return items.flatMap((item) => {
    const file = item.getAsFile() ?? files[fallbackFileIndex++];
    if (!file) return [];
    const entry = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
      }
    ).webkitGetAsEntry?.();
    return [
      {
        file,
        isDirectory: typeof entry?.isDirectory === 'boolean' ? entry.isDirectory : undefined,
      },
    ];
  });
};

const readableDropPath = (value: string): string => {
  if (value.length <= 180) return value;
  return `${value.slice(0, 86)}…${value.slice(-86)}`;
};

const describeDropEntries = (
  entries: readonly DroppedEntry[],
  paths: readonly string[],
): string => {
  const visible = entries.slice(0, 12).map((entry, index) => {
    const path = paths[index] || entry.file.name;
    return `• ${entry.file.name}\n  ${readableDropPath(path)}`;
  });
  if (entries.length > visible.length) {
    visible.push(`• 以及另外 ${entries.length - visible.length} 个项目`);
  }
  return visible.join('\n');
};

const persistFileDropConfirmationDisabled = async (
  runtime: ApplicationRuntime,
  showToast: (message: string, tone?: 'error' | 'success') => void,
): Promise<void> => {
  // Keep the current session aligned with the accepted choice even when persistence is unavailable.
  runtime.setFileDropConfirmationEnabled(false);
  try {
    const settings = await window.controlPanel.getAppSettings();
    await window.controlPanel.setAdvancedSettings({
      ...settings.advanced,
      confirmFileDrops: false,
    });
  } catch {
    showToast('本次操作已完成，但无法保存“以后不再提示”。', 'error');
  }
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
      const entries = droppedEntriesFromEvent(event);
      const hasDirectory = entries.some(({ isDirectory }) => isDirectory === true);
      const hasFile = entries.some(({ isDirectory }) => isDirectory === false);
      const hasUnknownType = entries.some(({ isDirectory }) => isDirectory === undefined);
      if (hasDirectory && hasFile) {
        title.textContent = '松开以查看拖放提示';
        detail.textContent = '文件夹和文件不能混合拖入；本次操作不会自动执行';
      } else if (hasUnknownType) {
        title.textContent = '松开以查看拖放提示';
        detail.textContent = '当前主机无法判断文件夹类型；本次操作不会自动执行';
      } else if (hasDirectory) {
        title.textContent = '松开以添加项目';
        detail.textContent = '将为该项目创建独立终端会话';
      } else if (railShell.getMainView() === 'chat') {
        title.textContent = '松开以添加到当前消息';
        detail.textContent = '支持图片、PDF、CSV 与纯文本；文件只会复制到本机应用数据目录';
      } else if (hasFile) {
        title.textContent = '松开以插入文件路径';
        detail.textContent = '路径会追加到当前 Claude Code 提示词草稿，不会自动发送';
      } else {
        title.textContent = '松开以查看拖放提示';
        detail.textContent = '没有检测到可识别的拖放类型';
      }
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

    const entries = droppedEntriesFromEvent(event);
    if (entries.length === 0) {
      showToast('没有检测到可处理的文件。', 'error');
      return;
    }

    void (async () => {
      if (entries.some(({ isDirectory }) => isDirectory === undefined)) {
        showToast('当前主机无法判断文件夹类型，拖放未执行。', 'error');
        return;
      }
      const directories = entries.filter(({ isDirectory }) => isDirectory === true);
      const files = entries.filter(({ isDirectory }) => isDirectory === false);
      // A mixed drop has no unambiguous destination: never silently discard files or add a
      // directory while pretending the remaining files were handled.
      if (directories.length > 0 && files.length > 0) {
        showToast('请一次只拖入文件或文件夹，混合拖放未执行。', 'error');
        return;
      }
      if (directories.length > 1) {
        showToast('一次只能添加一个文件夹项目。', 'error');
        return;
      }

      const paths = entries.map(({ file }) => {
        try {
          return window.controlPanel.getDroppedPath(file);
        } catch {
          return '';
        }
      });
      const isChat = railShell.getMainView() === 'chat';
      const action =
        directories.length > 0
          ? '将这个文件夹添加为新项目'
          : isChat
            ? '将这些文件添加到当前消息作为附件'
            : '将这些文件的路径追加到当前 Claude Code 提示词末尾';
      const confirmationMessage =
        `${action}：\n\n${describeDropEntries(entries, paths)}\n\n` +
        (directories.length > 0
          ? '确认后会沿用现有项目添加流程。'
          : isChat
            ? '确认后才会导入附件。'
            : '确认后只会修改提示词草稿，不会自动发送，也不会写入正在运行的终端。');

      let suppressDialog = false;
      if (runtime.getFileDropConfirmationEnabled()) {
        const result = await runtime.dialogShell.requestConfirmationResult({
          message: confirmationMessage,
          showSuppressOption: true,
          suppressLabel: '以后不再提示文件拖放',
          title: directories.length > 0 ? '确认添加项目？' : '确认处理拖入文件？',
        });
        if (!result.confirmed) return;
        suppressDialog = result.suppressDialog;
      }

      if (directories.length > 0) {
        const directoryPath = paths[0];
        if (!directoryPath) {
          showToast('无法读取拖入项目的路径。', 'error');
          return;
        }
        try {
          await projectsFeature.addProject(directoryPath);
        } catch {
          showToast('无法添加拖入的项目文件夹。', 'error');
          return;
        }
        if (suppressDialog) {
          await persistFileDropConfirmationDisabled(runtime, showToast);
        }
        return;
      }
      if (isChat) {
        const queued = chatFeature.queueAttachmentImport(
          entries.map(({ file }) => file),
          suppressDialog
            ? (succeeded) => {
                if (succeeded) {
                  void persistFileDropConfirmationDisabled(runtime, showToast);
                }
              }
            : undefined,
        );
        if (!queued) {
          showToast('当前对话正在运行，暂不能添加附件。', 'error');
        }
        return;
      }
      if (paths.some((path) => !path)) {
        showToast('无法读取一个或多个拖入文件的路径。', 'error');
        return;
      }
      const appended = terminalFeature.appendDroppedPaths(paths);
      if (appended && suppressDialog) {
        await persistFileDropConfirmationDisabled(runtime, showToast);
      }
    })().catch(() => {
      showToast('无法处理拖入的文件。', 'error');
    });
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
    preflightFeature.setPreferences(initialSettings.advanced.networkPreflight);
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
