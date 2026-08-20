import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionState } from './state';

export interface AdvancedDialogActions {
  closeAdvancedConnectionDialog: (complete: boolean) => void;
  openAdvancedConnectionDialog: () => void;
}

export const createAdvancedDialogActions = (
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  setConnectionPolling: (enabled: boolean) => void,
): AdvancedDialogActions => {
  const openAdvancedConnectionDialog = (): void => {
    if (dependencies.connectionAdvancedDialog.open) {
      return;
    }
    dependencies.closeRailPreview();
    state.advancedConnectionSnapshot = dependencies.captureAdvancedConnectionSnapshot();
    const loadGeneration = dependencies.proxy.beginDialogLoad();
    dependencies.completeConnectionAdvancedButton.disabled = true;
    dependencies.settings.selectGeneralTab();
    void Promise.all([
      dependencies.settings.loadAppSettings(),
      dependencies.proxy.loadState(false, loadGeneration),
    ]).then(([, proxyLoaded]) => {
      if (!dependencies.proxy.completeDialogLoad(loadGeneration, proxyLoaded)) return;
      dependencies.completeConnectionAdvancedButton.disabled = false;
      dependencies.settings.updateUnsavedIndicator();
    });
    dependencies.connectionAdvancedDialog.showModal();
  };

  const closeAdvancedConnectionDialog = (complete: boolean): void => {
    if (!dependencies.connectionAdvancedDialog.open) {
      return;
    }
    if (!complete && state.advancedConnectionSnapshot) {
      dependencies.restoreAdvancedConnectionSnapshot(state.advancedConnectionSnapshot);
    }
    dependencies.settings.endDialogSession(!complete);
    dependencies.proxy.endDialogSession(!complete);
    dependencies.connectionAdvancedDialog.close(complete ? 'complete' : 'cancel');
    setConnectionPolling(dependencies.getSelectedRailTab() === 'connection');
    dependencies.openConnectionAdvancedButton.focus();
  };

  return {
    closeAdvancedConnectionDialog,
    openAdvancedConnectionDialog,
  };
};
