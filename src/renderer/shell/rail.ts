import { requiredElement } from '../platform/dom';
import type { ClaudeConfigView } from '../../shared/contracts';
import { createModelRail } from './model-rail';
import { createRailPreviewActions } from './rail-preview';
import { createRailMutableState, type RailMutableState } from './rail-state';

export type { RailShellDeps } from './rail-dependencies';
import type { RailShellDeps } from './rail-dependencies';

export interface RailShell {
  renderModelConnection: (config?: ClaudeConfigView) => void;
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

const bindActivityRailButtons = (
  activityRail: HTMLElement,
  handlers: {
    closePreviewSoon: () => void;
    preview: (tab: string) => void;
    toggle: (tab: string) => void;
  },
): void => {
  for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
    const railTab = button.dataset.railTab ?? 'projects';
    button.addEventListener('click', () => handlers.toggle(railTab));
    const preview = (): void => {
      if (railTab !== 'connection' && railTab !== 'extensions') handlers.preview(railTab);
    };
    button.addEventListener('pointerenter', preview);
    button.addEventListener('focusin', preview);
    button.addEventListener('pointerleave', handlers.closePreviewSoon);
  }
};

const bindExtensionSwitcher = (select: (tab: 'mcp' | 'plugins') => void): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-extension-tab]')) {
    button.addEventListener('click', () => {
      const nextTab = button.dataset.extensionTab;
      if (nextTab === 'plugins' || nextTab === 'mcp') select(nextTab);
    });
  }
};

const normalizeRailTab = (state: RailMutableState, tab: string): string => {
  if (tab === 'plugins' || tab === 'mcp') {
    state.extensionDirection = tab === 'mcp' ? 'forward' : 'backward';
    state.extensionTab = tab;
    return 'extensions';
  }
  return tab;
};

const effectiveRailPage = (state: RailMutableState, tab: string | undefined): string | undefined =>
  tab === 'extensions' ? state.extensionTab : tab;

const bindTerminalFitSettlement = (workspace: HTMLElement, settle: () => void): void => {
  workspace.addEventListener('transitionend', (event) => {
    if (event.target === workspace && event.propertyName === 'grid-template-columns') settle();
  });
};

export const createRailShell = (deps: RailShellDeps): RailShell => {
  const {
    connectionAdvancedDialog,
    getSelectedProviderId,
    setProviderGroupExpansionPending,
    applyDefaultProviderGroupExpansion,
    renderProviderPicker,
    loadNextClaudeConnection,
    showConnectionChoice,
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
  const renderModelConnection = createModelRail(
    requiredElement<HTMLButtonElement>('[data-rail-tab="connection"]'),
  );
  renderModelConnection();
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
      showConnectionChoice();
      void loadNextClaudeConnection().catch(() => undefined);
      const lastProvider = getSelectedProviderId();
      applyDefaultProviderGroupExpansion(lastProvider);
      setProviderGroupExpansionPending(!lastProvider);
      renderProviderPicker();
    } else if (tab === 'extensions') {
      if (state.extensionTab === 'plugins') loadPluginsCatalog();
      else loadMcpCatalog();
    }
  };

  const renderRailPresentation = (tab: string | undefined, preview: boolean): void => {
    const normalizedTab = tab ? normalizeRailTab(state, tab) : undefined;
    const pageTab = effectiveRailPage(state, normalizedTab);
    const fullCanvas = normalizedTab === 'connection' || normalizedTab === 'extensions';
    const collapsed = state.selectedRailTab === undefined;
    workspace.classList.toggle('workspace--rail-collapsed', collapsed);
    workspace.classList.toggle('workspace--rail-preview', preview && tab !== undefined);
    workspace.dataset.railPanel = normalizedTab ?? 'collapsed';
    controlPanel.inert = normalizedTab === undefined;
    controlPanel.setAttribute('aria-hidden', String(normalizedTab === undefined));
    getPanelResizer().tabIndex = collapsed || fullCanvas ? -1 : 0;
    for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
      const selected = button.dataset.railTab === state.selectedRailTab;
      const transient = preview && button.dataset.railTab === normalizedTab;
      button.classList.toggle('activity-rail__button--active', selected);
      button.classList.toggle('activity-rail__button--preview', transient);
      button.setAttribute('aria-expanded', String(selected || transient));
      button.setAttribute('aria-pressed', String(selected));
      const label = button.querySelector<HTMLElement>('.activity-rail__label')?.textContent;
      button.title = selected ? `${label ?? '侧栏'}（再次点击可收起侧栏）` : (label ?? '打开侧栏');
    }
    for (const page of document.querySelectorAll<HTMLElement>('[data-rail-page]')) {
      const active = page.dataset.railPage === pageTab;
      page.classList.toggle('rail-page--active', active);
      if (active && normalizedTab === 'extensions') {
        page.dataset.motionDirection = state.extensionDirection;
      } else {
        delete page.dataset.motionDirection;
      }
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-extension-tab]')) {
      const active = button.dataset.extensionTab === state.extensionTab;
      button.dataset.active = String(active);
      button.setAttribute('aria-pressed', String(active));
    }
    const chatVisible = state.mainView === 'chat';
    terminalShell.hidden = chatVisible;
    chatShell.hidden = !chatVisible;
    terminalShell.inert = fullCanvas;
    chatShell.inert = fullCanvas;
    terminalShell.setAttribute('aria-hidden', String(chatVisible || fullCanvas));
    chatShell.setAttribute('aria-hidden', String(!chatVisible || fullCanvas));
    setConnectionPolling(
      normalizedTab === 'connection' ||
        (connectionAdvancedDialog.open &&
          (getSettingsSelectedTab() === 'connection' || getSettingsSelectedTab() === 'router')),
    );
    if (!chatVisible && !preview) {
      retryTerminalFitUntilMeasured();
    }
  };

  const applyRailTab = (tab?: string): void => {
    const normalizedTab = tab ? normalizeRailTab(state, tab) : undefined;
    previewActions.closeRailPreview();
    if (normalizedTab === 'chat') state.mainView = 'chat';
    else if (normalizedTab !== undefined) state.mainView = 'terminal';
    const entering = normalizedTab !== undefined && normalizedTab !== state.selectedRailTab;
    state.selectedRailTab = normalizedTab;
    if (entering && normalizedTab) prepareRailTab(normalizedTab);
    renderRailPresentation(normalizedTab, false);
  };

  bindTerminalFitSettlement(workspace, retryTerminalFitUntilMeasured);

  const compactWorkspaceViewportWidth = (): number =>
    Math.min(window.innerWidth, window.visualViewport?.width ?? window.innerWidth);

  const isCompactWorkspaceViewport = (): boolean => compactWorkspaceViewportWidth() <= 680;

  const toggleRailTab = (tab: string): void => {
    const normalizedTab = normalizeRailTab(state, tab);
    if (normalizedTab === 'connection' || normalizedTab === 'extensions') {
      applyRailTab(state.selectedRailTab === normalizedTab ? 'projects' : normalizedTab);
      return;
    }
    if (isCompactWorkspaceViewport()) {
      const closingPreview = state.previewRailTab === normalizedTab;
      if (state.selectedRailTab !== undefined) {
        state.compactRailRestoreTab = state.selectedRailTab;
        applyRailTab(undefined);
      } else {
        previewActions.closeRailPreview();
      }
      if (!closingPreview) previewActions.showRailPreview(normalizedTab);
      if (normalizedTab === 'chat') focusInputAfterNavigation();
      return;
    }
    applyRailTab(state.selectedRailTab === normalizedTab ? undefined : normalizedTab);
    if (normalizedTab === 'chat') {
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

  bindActivityRailButtons(activityRail, {
    closePreviewSoon: previewActions.scheduleRailPreviewClose,
    preview: previewActions.showRailPreview,
    toggle: toggleRailTab,
  });
  bindExtensionSwitcher((nextTab) => {
    if (nextTab === state.extensionTab) return;
    state.extensionDirection = nextTab === 'mcp' ? 'forward' : 'backward';
    state.extensionTab = nextTab;
    prepareRailTab('extensions');
    applyRailTab('extensions');
    document
      .querySelector<HTMLElement>(`[data-rail-page="${nextTab}"]`)
      ?.focus({ preventScroll: true });
  });

  return {
    renderModelConnection,
    selectRailTab: applyRailTab,
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
