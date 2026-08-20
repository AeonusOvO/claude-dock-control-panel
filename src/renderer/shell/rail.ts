import { requiredElement } from '../platform/dom';
import { createRailPreviewActions } from './rail-preview';
import { createRailMutableState } from './rail-state';

export type { RailShellDeps } from './rail-dependencies';
import type { RailShellDeps } from './rail-dependencies';

export interface RailShell {
  selectRailTab: (tab: string) => void;
  toggleRailTab: (tab: string) => void;
  closeRailPreview: () => void;
  getSelectedRailTab: () => string | undefined;
  getPreviewRailTab: () => string | undefined;
  getMainView: () => 'chat' | 'terminal';
  escapeRailPreview: () => boolean;
  reconcileCompactRail: () => void;
  dispose: () => void;
  readonly terminalShell: HTMLElement;
  readonly chatShell: HTMLElement;
}

export const createRailShell = (deps: RailShellDeps): RailShell => {
  const {
    claudeStates,
    connectionAdvancedDialog,
    getActiveSessionId,
    getSelectedProviderId,
    setProviderGroupExpansionPending,
    applyDefaultProviderGroupExpansion,
    renderProviderPicker,
    loadChatConfig,
    loadChatHistory,
    renderChatUsage,
    focusInputAfterNavigation,
    loadPluginsCatalog,
    loadMcpCatalog,
    setConnectionPolling,
    getSettingsSelectedTab,
    getPanelResizer,
    retryTerminalFitUntilMeasured,
  } = deps;

  const activityRail = requiredElement<HTMLElement>('#activity-rail');
  const workspace = requiredElement<HTMLElement>('#workspace');
  const controlPanel = requiredElement<HTMLElement>('#control-panel');
  const terminalShell = requiredElement<HTMLElement>('#terminal-shell');
  const chatShell = requiredElement<HTMLElement>('#chat-shell');
  const state = createRailMutableState();

  const previewActions = createRailPreviewActions(
    state,
    activityRail,
    controlPanel,
    (tab) => prepareRailTab(tab),
    (tab, preview) => renderRailPresentation(tab, preview),
  );

  const prepareRailTab = (tab: string): void => {
    if (tab === 'chat') {
      void loadChatConfig();
      void loadChatHistory();
      renderChatUsage();
    } else if (tab === 'connection') {
      const lastProvider =
        getSelectedProviderId() ?? claudeStates.get(getActiveSessionId())?.config.preset;
      applyDefaultProviderGroupExpansion(lastProvider);
      setProviderGroupExpansionPending(Boolean(getActiveSessionId() && !lastProvider));
      renderProviderPicker();
    } else if (tab === 'plugins') {
      loadPluginsCatalog();
    } else if (tab === 'mcp') {
      loadMcpCatalog();
    }
  };

  const renderRailPresentation = (tab: string | undefined, preview: boolean): void => {
    const collapsed = state.selectedRailTab === undefined;
    workspace.classList.toggle('workspace--rail-collapsed', collapsed);
    workspace.classList.toggle('workspace--rail-preview', preview && tab !== undefined);
    workspace.dataset.railPanel = tab ?? 'collapsed';
    controlPanel.inert = tab === undefined;
    controlPanel.setAttribute('aria-hidden', String(tab === undefined));
    getPanelResizer().tabIndex = collapsed ? -1 : 0;
    for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
      const selected = button.dataset.railTab === state.selectedRailTab;
      const transient = preview && button.dataset.railTab === tab;
      button.classList.toggle('activity-rail__button--active', selected);
      button.classList.toggle('activity-rail__button--preview', transient);
      button.setAttribute('aria-expanded', String(selected || transient));
      button.setAttribute('aria-pressed', String(selected));
      const label = button.querySelector<HTMLElement>('span:not(.activity-rail__dot)')?.textContent;
      button.title = selected ? `${label ?? '侧栏'}（再次点击可收起侧栏）` : (label ?? '打开侧栏');
    }
    for (const page of document.querySelectorAll<HTMLElement>('[data-rail-page]')) {
      page.classList.toggle('rail-page--active', page.dataset.railPage === tab);
    }
    const chatVisible = state.mainView === 'chat';
    terminalShell.hidden = chatVisible;
    chatShell.hidden = !chatVisible;
    setConnectionPolling(
      tab === 'connection' ||
        (connectionAdvancedDialog.open &&
          (getSettingsSelectedTab() === 'connection' || getSettingsSelectedTab() === 'router')),
    );
    if (!chatVisible && !preview) {
      retryTerminalFitUntilMeasured();
    }
  };

  const applyRailTab = (tab?: string): void => {
    previewActions.closeRailPreview();
    if (tab === 'chat') state.mainView = 'chat';
    else if (tab !== undefined) state.mainView = 'terminal';
    const entering = tab !== undefined && tab !== state.selectedRailTab;
    state.selectedRailTab = tab;
    if (entering && tab) prepareRailTab(tab);
    renderRailPresentation(tab, false);
  };

  /**
   * The sidebar column eases open and closed now, so the fit `applyRailTab` schedules lands while the
   * grid is still moving. One more pass once the transition ends settles xterm on the final width —
   * and doing it here rather than per animation frame keeps ConPTY from being resized dozens of times.
   */
  workspace.addEventListener('transitionend', (event) => {
    if (event.target === workspace && event.propertyName === 'grid-template-columns') {
      retryTerminalFitUntilMeasured();
    }
  });

  function selectRailTab(tab: string): void {
    applyRailTab(tab);
  }

  const compactWorkspaceViewportWidth = (): number =>
    Math.min(window.innerWidth, window.visualViewport?.width ?? window.innerWidth);

  const isCompactWorkspaceViewport = (): boolean => compactWorkspaceViewportWidth() <= 680;

  const toggleRailTab = (tab: string): void => {
    if (isCompactWorkspaceViewport()) {
      const closingPreview = state.previewRailTab === tab;
      if (state.selectedRailTab !== undefined) {
        state.compactRailRestoreTab = state.selectedRailTab;
        applyRailTab(undefined);
      } else {
        previewActions.closeRailPreview();
      }
      if (!closingPreview) previewActions.showRailPreview(tab);
      if (tab === 'chat') focusInputAfterNavigation();
      return;
    }
    applyRailTab(state.selectedRailTab === tab ? undefined : tab);
    if (tab === 'chat') {
      focusInputAfterNavigation();
    }
  };

  const reconcileCompactRail = (): void => {
    const compact = isCompactWorkspaceViewport();
    document.documentElement.dataset.compactViewport = String(compact);
    if (compact && state.selectedRailTab !== undefined) {
      state.compactRailRestoreTab = state.selectedRailTab;
      applyRailTab(undefined);
      return;
    }
    if (!compact && state.compactRailRestoreTab && state.selectedRailTab === undefined) {
      const restore = state.compactRailRestoreTab;
      state.compactRailRestoreTab = undefined;
      applyRailTab(restore);
    }
  };

  const scheduleCompactRailReconciliation = (): void => {
    if (state.compactRailResizeFrame !== undefined) {
      window.cancelAnimationFrame(state.compactRailResizeFrame);
    }
    state.compactRailResizeFrame = window.requestAnimationFrame(() => {
      state.compactRailResizeFrame = undefined;
      reconcileCompactRail();
    });
  };

  window.addEventListener('resize', scheduleCompactRailReconciliation);
  window.visualViewport?.addEventListener('resize', scheduleCompactRailReconciliation);

  for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
    const railTab = button.dataset.railTab ?? 'projects';
    button.addEventListener('click', () => {
      toggleRailTab(railTab);
    });
    button.addEventListener('pointerenter', () => previewActions.showRailPreview(railTab));
    button.addEventListener('focusin', () => previewActions.showRailPreview(railTab));
    button.addEventListener('pointerleave', () => previewActions.scheduleRailPreviewClose());
  }

  return {
    selectRailTab,
    toggleRailTab,
    closeRailPreview: previewActions.closeRailPreview,
    getSelectedRailTab: () => state.selectedRailTab,
    getPreviewRailTab: () => state.previewRailTab,
    getMainView: () => state.mainView,
    escapeRailPreview: previewActions.escapeRailPreview,
    reconcileCompactRail,
    dispose: () => {
      previewActions.dispose();
    },
    terminalShell,
    chatShell,
  };
};
