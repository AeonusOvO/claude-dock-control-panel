import type {
  ClaudeContextWindowMode,
  ClaudePermissionMode,
  ClaudeProjectState,
  CodexProjectState,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
} from '../../../shared/contracts';
import {
  claudeContextWindowCustomInput,
  footerConnection,
  footerConnectionLabel,
  footerContextLabel,
  footerContextRing,
  footerEffort,
  footerEffortMenu,
  footerMode,
  footerModeMenu,
  footerModel,
  footerModelMenu,
  footerResource,
  footerResourceMenu,
  footerSessionSettings,
  footerSessionSettingsRegion,
  footerSpeed,
  footerSpeedMenu,
  footerStatus,
} from './elements';
import { footerState } from './state';
import { createFooterMenus, type FooterMenusDeps } from './menus';
import { installSessionSettings } from './session-settings';
import { createFooterSwitches, type FooterSwitchesDeps } from './switches';

export interface FooterShellDeps extends FooterMenusDeps, FooterSwitchesDeps {}

export interface FooterLoadedSettings {
  claudeContextWindowCustomTokens?: number;
  claudeContextWindowMode: ClaudeContextWindowMode;
  footerResourcePreference: FooterResourcePreference;
  managedChatGptContextWindowMode: ManagedChatGptContextWindowMode;
}

export interface FooterShell {
  readonly footerStatus: HTMLElement;
  readonly footerConnection: HTMLButtonElement;
  readonly footerConnectionLabel: HTMLElement;
  readonly footerContextLabel: HTMLElement;
  readonly footerContextRing: HTMLElement;
  readonly footerEffort: HTMLButtonElement;
  readonly footerEffortMenu: HTMLElement;
  readonly footerMode: HTMLButtonElement;
  readonly footerModeMenu: HTMLElement;
  readonly footerModel: HTMLButtonElement;
  readonly footerModelMenu: HTMLElement;
  readonly footerSpeed: HTMLButtonElement;
  readonly footerSpeedMenu: HTMLElement;
  readonly footerResource: HTMLButtonElement;
  readonly footerResourceMenu: HTMLElement;
  readonly footerSessionSettings: HTMLButtonElement;
  readonly footerSessionSettingsRegion: HTMLElement;
  hideFooterMenus: () => void;
  setSessionSettingsOpen: (open: boolean) => void;
  openFooterMenu: (menu: HTMLElement, trigger: HTMLButtonElement) => void;
  buildFooterRadioMenuItem: (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled?: boolean,
    triggerButton?: HTMLButtonElement,
  ) => HTMLButtonElement;
  renderFooterResource: (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
    contextWindowSelectable?: boolean,
  ) => void;
  renderTerminalFooterChips: (state: ClaudeProjectState) => void;
  managedContextWindowSelectable: (
    state: ClaudeProjectState | undefined,
    selectedModel?: string,
  ) => boolean;
  requestedClaudeContextWindowTokens: () => number | undefined;
  syncClaudeContextWindowSelection: () => void;
  setFooterResourcePreference: (preference: FooterResourcePreference) => void;
  setManagedChatGptContextWindowMode: (mode: ManagedChatGptContextWindowMode) => void;
  getManagedChatGptContextWindowMode: () => ManagedChatGptContextWindowMode;
  getClaudeContextWindowMode: () => ClaudeContextWindowMode;
  getClaudeContextWindowCustomTokens: () => number | undefined;
  applyContextWindowSettings: (settings: FooterLoadedSettings) => void;
  applyLoadedSettings: (settings: FooterLoadedSettings) => void;
  switchPermissionMode: (mode: ClaudePermissionMode) => Promise<void>;
}

export const createFooterShell = (deps: FooterShellDeps): FooterShell => {
  const menus = createFooterMenus({ formatTokenCount: deps.formatTokenCount });
  const switches = createFooterSwitches(menus, deps);
  const sessionSettings = installSessionSettings({
    document,
    ownedPopups: [footerModelMenu, footerSpeedMenu, footerModeMenu, footerEffortMenu],
    region: footerSessionSettingsRegion,
    trigger: footerSessionSettings,
    window,
  });

  footerResource.addEventListener('click', () => {
    if (footerResourceMenu.hidden) {
      menus.openFooterMenu(footerResourceMenu, footerResource);
    } else {
      menus.hideFooterMenus();
    }
  });
  claudeContextWindowCustomInput.addEventListener('change', () => {
    const tokens = Number(claudeContextWindowCustomInput.value);
    if (!Number.isInteger(tokens) || tokens < 8_000 || tokens > 2_000_000) {
      deps.showToast('窗口 token 数需为 8000 到 2000000 之间的整数。', 'error');
      return;
    }
    switches.applyClaudeContextWindowMode('custom', tokens);
  });
  footerResourceMenu.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-resource-preference], [data-context-window-mode], [data-claude-context-window-mode]',
    );
    const claudeWindowMode = button?.dataset.claudeContextWindowMode as
      ClaudeContextWindowMode | undefined;
    if (claudeWindowMode) {
      if (claudeWindowMode === 'custom') {
        // A custom value is only selected after validation succeeds. Reveal the draft field without
        // changing either the saved preference or the radio's committed aria state.
        footerState.claudeContextWindowCustomDraftOpen = true;
        menus.syncClaudeContextWindowSelection();
        claudeContextWindowCustomInput.focus();
        return;
      }
      footerState.claudeContextWindowCustomDraftOpen = false;
      switches.applyClaudeContextWindowMode(claudeWindowMode);
      return;
    }
    const contextWindowMode = button?.dataset.contextWindowMode as
      ManagedChatGptContextWindowMode | undefined;
    if (contextWindowMode) {
      switches.applyManagedChatGptContextWindowMode(contextWindowMode);
      return;
    }
    const preference = button?.dataset.resourcePreference as FooterResourcePreference | undefined;
    if (!preference) return;
    switches.applyFooterResourcePreference(preference);
  });
  footerModel.addEventListener('click', () => {
    if (footerModelMenu.hidden) {
      void switches.openModelMenu();
    } else {
      menus.hideFooterMenus();
    }
  });
  footerSpeed.addEventListener('click', () => {
    if (footerSpeedMenu.hidden) {
      switches.openSpeedMenu();
    } else {
      menus.hideFooterMenus();
    }
  });
  footerMode.addEventListener('click', () => {
    if (footerModeMenu.hidden) {
      switches.openModeMenu();
    } else {
      menus.hideFooterMenus();
    }
  });
  footerEffort.addEventListener('click', () => {
    if (footerEffortMenu.hidden) {
      switches.openEffortMenu();
    } else {
      menus.hideFooterMenus();
    }
  });

  return {
    footerStatus,
    footerConnection,
    footerConnectionLabel,
    footerContextLabel,
    footerContextRing,
    footerEffort,
    footerEffortMenu,
    footerMode,
    footerModeMenu,
    footerModel,
    footerModelMenu,
    footerSpeed,
    footerSpeedMenu,
    footerResource,
    footerResourceMenu,
    footerSessionSettings,
    footerSessionSettingsRegion,
    hideFooterMenus: menus.hideFooterMenus,
    setSessionSettingsOpen: sessionSettings.setOpen,
    openFooterMenu: menus.openFooterMenu,
    buildFooterRadioMenuItem: menus.buildFooterRadioMenuItem,
    renderFooterResource: menus.renderFooterResource,
    renderTerminalFooterChips: switches.renderTerminalFooterChips,
    managedContextWindowSelectable: menus.managedContextWindowSelectable,
    requestedClaudeContextWindowTokens: menus.requestedClaudeContextWindowTokens,
    syncClaudeContextWindowSelection: menus.syncClaudeContextWindowSelection,
    setFooterResourcePreference: (preference) => {
      footerState.footerResourcePreference = preference;
    },
    setManagedChatGptContextWindowMode: (mode) => {
      footerState.managedChatGptContextWindowMode = mode;
    },
    getManagedChatGptContextWindowMode: () => footerState.managedChatGptContextWindowMode,
    getClaudeContextWindowMode: () => footerState.claudeContextWindowMode,
    getClaudeContextWindowCustomTokens: () => footerState.claudeContextWindowCustomTokens,
    applyContextWindowSettings: (settings) => {
      footerState.claudeContextWindowMode = settings.claudeContextWindowMode;
      footerState.claudeContextWindowCustomTokens = settings.claudeContextWindowCustomTokens;
      footerState.claudeContextWindowCustomDraftOpen = false;
      menus.syncClaudeContextWindowSelection();
    },
    applyLoadedSettings: (settings) => {
      footerState.footerResourcePreference = settings.footerResourcePreference;
      footerState.managedChatGptContextWindowMode = settings.managedChatGptContextWindowMode;
      footerState.claudeContextWindowMode = settings.claudeContextWindowMode;
      footerState.claudeContextWindowCustomTokens = settings.claudeContextWindowCustomTokens;
      menus.syncClaudeContextWindowSelection();
    },
    switchPermissionMode: switches.switchPermissionMode,
  };
};
