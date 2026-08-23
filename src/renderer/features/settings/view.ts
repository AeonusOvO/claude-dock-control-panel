import type { AppSettingsView } from '../../../shared/contracts';
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  type TerminalThemeId,
} from '../../../shared/ui/terminal-themes';
import type { SettingsElements } from './elements';
import type { SettingsState, SettingsTab } from './state';

export interface SettingsViewDependencies {
  applySettingsThemeSelect: (theme: string) => void;
  applyTerminalTheme: (themeId: TerminalThemeId, announce?: boolean, persist?: boolean) => void;
  getSelectedRailTab: () => string | undefined;
  getSettingsThemeValue: () => string;
  isClaudeExecutionDirty: () => boolean;
  isProxyDirty: () => boolean;
  onAdvancedTabSelected: () => void;
  onClaudeExecutionTabSelected: () => void;
  onNetworkTabSelected: () => void;
  onProxyTabSelected: () => void;
  onRouterTabSelected: () => void;
  setConnectionPolling: (enabled: boolean) => void;
}

export interface SettingsView {
  applySettings: (settings: AppSettingsView) => void;
  pendingSettings: () => Pick<
    AppSettingsView,
    'advanced' | 'closeBehavior' | 'launchAtLogin' | 'theme'
  >;
  selectTab: (tab: SettingsTab) => void;
  setCloseBehaviorValue: (value: string) => void;
  updateUnsavedIndicator: () => number;
}

interface SettingsViewContext {
  dependencies: SettingsViewDependencies;
  elements: SettingsElements;
  state: SettingsState;
}

const selectSettingsTab = (context: SettingsViewContext, tab: SettingsTab): void => {
  const { dependencies, state } = context;
  state.selectedTab = tab;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')) {
    const selected = button.dataset.settingsTab === tab;
    button.classList.toggle('settings-tab--active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
    panel.classList.toggle('settings-panel--active', panel.dataset.settingsPanel === tab);
  }
  if (tab === 'connection' || tab === 'router') {
    dependencies.setConnectionPolling(true);
  } else {
    dependencies.setConnectionPolling(dependencies.getSelectedRailTab() === 'connection');
  }
  if (tab === 'proxy') {
    dependencies.onProxyTabSelected();
  }
  if (tab === 'advanced') {
    dependencies.onAdvancedTabSelected();
  }
  if (tab === 'claude-execution') {
    dependencies.onClaudeExecutionTabSelected();
  }
  if (tab === 'network') {
    dependencies.onNetworkTabSelected();
  }
  if (tab === 'router') {
    dependencies.onRouterTabSelected();
  }
};

const pendingAppSettings = (
  context: SettingsViewContext,
): Pick<AppSettingsView, 'advanced' | 'closeBehavior' | 'launchAtLogin' | 'theme'> => {
  const { dependencies, elements } = context;
  const themeValue = dependencies.getSettingsThemeValue();
  const savedNetwork = context.state.saved?.advanced.networkPreflight ?? {
    checkOnNewSession: true,
    checkOnProviderLogin: true,
  };
  return {
    advanced: {
      chatIdleTimeoutMinutes: Number(elements.chatIdleTimeout.value) as 0 | 5 | 10 | 30,
      networkPreflight: {
        checkOnNewSession: elements.networkNewSession.checked,
        checkOnProviderLogin: elements.networkProviderLogin.checked,
        ...(savedNetwork.cliTimezone ? { cliTimezone: savedNetwork.cliTimezone } : {}),
        ...(savedNetwork.cliLanguages
          ? {
              cliLanguages: [...savedNetwork.cliLanguages],
            }
          : {}),
      },
      webResearchIsolation: elements.webResearchIsolation.checked,
    },
    closeBehavior: elements.closeBehavior.value === 'exit' ? 'exit' : 'tray',
    launchAtLogin: elements.launchAtLogin.checked,
    theme: isTerminalThemeId(themeValue) ? themeValue : DEFAULT_TERMINAL_THEME,
  };
};

const updateSettingsUnsavedIndicator = (context: SettingsViewContext): number => {
  const { dependencies, elements, state } = context;
  if (!state.saved) {
    const count =
      Number(dependencies.isProxyDirty()) + Number(dependencies.isClaudeExecutionDirty());
    elements.unsavedIndicator.hidden = count === 0;
    elements.unsavedIndicator.textContent = `*${count} 项未保存`;
    return count;
  }
  const pending = pendingAppSettings(context);
  const savedNetwork = state.saved.advanced.networkPreflight ?? {
    checkOnNewSession: true,
    checkOnProviderLogin: true,
  };
  const count = [
    pending.launchAtLogin !== state.saved.launchAtLogin,
    pending.closeBehavior !== state.saved.closeBehavior,
    pending.theme !== state.saved.theme,
    pending.advanced.chatIdleTimeoutMinutes !== state.saved.advanced.chatIdleTimeoutMinutes,
    pending.advanced.webResearchIsolation !== state.saved.advanced.webResearchIsolation,
    pending.advanced.networkPreflight.checkOnNewSession !== savedNetwork.checkOnNewSession,
    pending.advanced.networkPreflight.checkOnProviderLogin !== savedNetwork.checkOnProviderLogin,
    dependencies.isClaudeExecutionDirty(),
    dependencies.isProxyDirty(),
  ].filter(Boolean).length;
  elements.unsavedIndicator.hidden = count === 0;
  elements.unsavedIndicator.textContent = `*${count} 项未保存`;
  return count;
};

const applyAppSettingsToControls = (
  context: SettingsViewContext,
  settings: AppSettingsView,
): void => {
  const { dependencies, elements } = context;
  elements.launchAtLogin.checked = settings.launchAtLogin;
  elements.closeBehavior.value = settings.closeBehavior;
  elements.chatIdleTimeout.value = String(settings.advanced.chatIdleTimeoutMinutes);
  elements.webResearchIsolation.checked = settings.advanced.webResearchIsolation;
  const networkPreflight = settings.advanced.networkPreflight ?? {
    checkOnNewSession: true,
    checkOnProviderLogin: true,
  };
  elements.networkNewSession.checked = networkPreflight.checkOnNewSession;
  elements.networkProviderLogin.checked = networkPreflight.checkOnProviderLogin;
  elements.language.value = settings.language;
  elements.version.value = settings.version;
  elements.version.textContent = settings.version;
  dependencies.applySettingsThemeSelect(settings.theme);
  dependencies.applyTerminalTheme(settings.theme, false, false);
};

export const createSettingsView = (
  elements: SettingsElements,
  state: SettingsState,
  dependencies: SettingsViewDependencies,
): SettingsView => {
  const context: SettingsViewContext = { dependencies, elements, state };
  const view: SettingsView = {
    applySettings: (settings) => applyAppSettingsToControls(context, settings),
    pendingSettings: () => pendingAppSettings(context),
    selectTab: (tab) => selectSettingsTab(context, tab),
    setCloseBehaviorValue: (value) => {
      elements.closeBehavior.value = value;
    },
    updateUnsavedIndicator: () => updateSettingsUnsavedIndicator(context),
  };
  return view;
};
