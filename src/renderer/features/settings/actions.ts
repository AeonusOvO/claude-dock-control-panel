import type { AppSettingsView } from '../../../shared/contracts';
import type { SettingsElements } from './elements';
import type { SettingsState } from './state';
import type { SettingsView } from './view';

export interface SettingsActionsDependencies {
  cancelButton: HTMLButtonElement;
  closeAdvancedConnectionDialog: (complete: boolean) => void;
  completeButton: HTMLButtonElement;
  isProxyDirty: () => boolean;
  loadProxyState: (preserveDirtyDraft?: boolean) => Promise<boolean>;
  onSettingsLoaded: (settings: AppSettingsView) => void;
  saveProxyPending: () => Promise<boolean>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface SettingsActions {
  bind: () => () => void;
  endDialogSession: (restore: boolean) => void;
  loadAppSettings: () => Promise<void>;
  savePending: () => Promise<void>;
}

interface SettingsActionsContext {
  dependencies: SettingsActionsDependencies;
  elements: SettingsElements;
  state: SettingsState;
  view: SettingsView;
}

const loadAppSettings = async (context: SettingsActionsContext): Promise<void> => {
  const { dependencies, state, view } = context;
  try {
    const settings = await window.controlPanel.getAppSettings();
    state.saved = settings;
    dependencies.onSettingsLoaded(settings);
    view.applySettings(settings);
    view.updateUnsavedIndicator();
  } catch {
    dependencies.showToast('无法读取全局设置。', 'error');
  }
};

const endDialogSession = (context: SettingsActionsContext, restore: boolean): void => {
  const { elements, state, view } = context;
  if (restore && state.saved) {
    view.applySettings(state.saved);
  }
  state.saved = undefined;
  elements.unsavedIndicator.hidden = true;
};

const savePendingAppSettings = async (context: SettingsActionsContext): Promise<void> => {
  const { dependencies, state, view } = context;
  const saved = state.saved;
  if (!saved) {
    dependencies.showToast('全局设置仍在读取，请稍后重试。', 'error');
    return;
  }
  const proxyDirty = dependencies.isProxyDirty();
  const appSettingsDirty = view.updateUnsavedIndicator() > (proxyDirty ? 1 : 0);
  if (!appSettingsDirty && !proxyDirty) {
    dependencies.closeAdvancedConnectionDialog(true);
    return;
  }
  const pending = view.pendingSettings();
  dependencies.completeButton.disabled = true;
  dependencies.cancelButton.disabled = true;
  dependencies.completeButton.textContent = '正在保存…';
  try {
    if (proxyDirty) {
      await dependencies.saveProxyPending();
    }
    if (pending.launchAtLogin !== saved.launchAtLogin) {
      await window.controlPanel.setLaunchAtLogin(pending.launchAtLogin);
    }
    if (pending.closeBehavior !== saved.closeBehavior) {
      await window.controlPanel.setCloseBehavior(pending.closeBehavior);
    }
    if (
      pending.advanced.chatIdleTimeoutMinutes !== saved.advanced.chatIdleTimeoutMinutes ||
      pending.advanced.webResearchIsolation !== saved.advanced.webResearchIsolation
    ) {
      await window.controlPanel.setAdvancedSettings(pending.advanced);
    }
    if (pending.theme !== saved.theme) {
      await window.controlPanel.setAppTheme(pending.theme);
      localStorage.setItem('claudedock.terminalTheme', pending.theme);
    }
    dependencies.showToast('设置已保存');
    dependencies.closeAdvancedConnectionDialog(true);
  } catch {
    dependencies.showToast('部分设置未能保存，已重新读取当前值。', 'error');
    await Promise.all([loadAppSettings(context), dependencies.loadProxyState(false)]);
  } finally {
    dependencies.completeButton.disabled = false;
    dependencies.cancelButton.disabled = false;
    dependencies.completeButton.textContent = '完成';
  }
};

const bindSettingsActions = (context: SettingsActionsContext): (() => void) => {
  const { elements, view } = context;
  const handleIndicatorChange = (): void => {
    view.updateUnsavedIndicator();
  };
  const handleChatIdleTimeoutChange = (): void => {
    const requested = Number(elements.chatIdleTimeout.value);
    if (requested !== 0 && requested !== 5 && requested !== 10 && requested !== 30) {
      elements.chatIdleTimeout.value = '0';
    }
    view.updateUnsavedIndicator();
  };
  const tabBindings = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'),
    (button) => ({
      button,
      handleTab: (): void => {
        const requested = button.dataset.settingsTab;
        view.selectTab(
          requested === 'advanced' ||
            requested === 'connection' ||
            requested === 'proxy' ||
            requested === 'router'
            ? requested
            : 'general',
        );
      },
    }),
  );

  elements.launchAtLogin.addEventListener('change', handleIndicatorChange);
  elements.closeBehavior.addEventListener('change', handleIndicatorChange);
  elements.webResearchIsolation.addEventListener('change', handleIndicatorChange);
  elements.chatIdleTimeout.addEventListener('change', handleChatIdleTimeoutChange);
  for (const { button, handleTab } of tabBindings) {
    button.addEventListener('click', handleTab);
  }

  return () => {
    elements.launchAtLogin.removeEventListener('change', handleIndicatorChange);
    elements.closeBehavior.removeEventListener('change', handleIndicatorChange);
    elements.webResearchIsolation.removeEventListener('change', handleIndicatorChange);
    elements.chatIdleTimeout.removeEventListener('change', handleChatIdleTimeoutChange);
    for (const { button, handleTab } of tabBindings) {
      button.removeEventListener('click', handleTab);
    }
  };
};

export const createSettingsActions = (
  elements: SettingsElements,
  state: SettingsState,
  dependencies: SettingsActionsDependencies,
  view: SettingsView,
): SettingsActions => {
  const context = { dependencies, elements, state, view };
  return {
    bind: () => bindSettingsActions(context),
    endDialogSession: (restore) => endDialogSession(context, restore),
    loadAppSettings: () => loadAppSettings(context),
    savePending: () => savePendingAppSettings(context),
  };
};
