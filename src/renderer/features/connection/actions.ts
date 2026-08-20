import type {
  ClaudeConnectionTestResult,
  ClaudeProjectState,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
import { createAdvancedDialogActions } from './advanced-dialog';
import { createConnectionAdviceActions } from './connection-advice';
import { createConnectionLifecycleActions } from './connection-lifecycle';
import { createConnectionRemedyActions } from './connection-remedy';
import { createConnectionTestActions } from './connection-test';
import { createCurlAnalysisActions } from './curl-analysis';
import { createGatewayDiagnosticsActions } from './gateway-diagnostics';
import { createSmartGuidanceActions } from './smart-guidance';
import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';
import type { ConnectionView } from './view';

export type { ConnectionActionsDependencies } from './dependencies';

export interface ConnectionActions {
  bind: () => () => void;
  clearTestResult: () => void;
  closeAdvancedConnectionDialog: (complete: boolean) => void;
  forgetSession: (sessionId: string) => void;
  loadConnectionAdvice: () => Promise<void>;
  loadGatewayDiagnostics: () => Promise<void>;
  renderConnectionTest: (result: ClaudeConnectionTestResult) => void;
  resetForProjectChange: () => void;
  rerunAutomaticConnectionTestForActiveProject: () => void;
  runConnectionTest: (
    saveOnSuccess?: boolean,
    configInput?: SaveClaudeConfigInput,
  ) => Promise<void>;
  scheduleAutomaticConnectionTest: (projectState: ClaudeProjectState) => void;
  setConnectionPolling: (enabled: boolean) => void;
  updateSmartGuidance: () => void;
}

export const createConnectionActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  view: ConnectionView,
): ConnectionActions => {
  const gatewayDiagnosticsActions = createGatewayDiagnosticsActions(elements, state, dependencies);
  const remedyActions = createConnectionRemedyActions(
    elements,
    state,
    dependencies,
    (saveOnSuccess, configInput) => testActions.runConnectionTest(saveOnSuccess, configInput),
  );
  const testActions = createConnectionTestActions(
    elements,
    state,
    dependencies,
    view,
    remedyActions.renderConnectionTest,
  );
  const guidanceActions = createSmartGuidanceActions(elements, state, dependencies, () =>
    curlAnalysisActions.importCurlIntoRouter(),
  );
  const curlAnalysisActions = createCurlAnalysisActions(
    elements,
    state,
    dependencies,
    gatewayDiagnosticsActions.preferredRouter,
    guidanceActions.updateSmartGuidance,
  );
  const adviceActions = createConnectionAdviceActions(
    elements,
    state,
    dependencies,
    testActions.runConnectionTest,
  );
  const lifecycleActions = createConnectionLifecycleActions(
    elements,
    state,
    dependencies,
    gatewayDiagnosticsActions.loadGatewayDiagnostics,
    adviceActions.loadConnectionAdvice,
    testActions.runConnectionTest,
  );
  const advancedDialogActions = createAdvancedDialogActions(
    state,
    dependencies,
    lifecycleActions.setConnectionPolling,
  );

  const { openAdvancedConnectionDialog, closeAdvancedConnectionDialog } = advancedDialogActions;
  const { applyGatewayCandidate, loadGatewayDiagnostics, preferredRouter } =
    gatewayDiagnosticsActions;
  const { loadConnectionAdvice } = adviceActions;
  const { importCurlIntoRouter, analyzeCurlInput, applyDirectCurlAnalysis } = curlAnalysisActions;
  const { updateSmartGuidance } = guidanceActions;
  const { runConnectionTest } = testActions;
  const { renderConnectionTest } = remedyActions;
  const {
    clearTestResult,
    forgetSession,
    resetForProjectChange,
    rerunAutomaticConnectionTestForActiveProject,
    scheduleAutomaticConnectionTest,
    setConnectionPolling,
  } = lifecycleActions;

  const bind = (): (() => void) => {
    const handleCompleteClick = (): void => {
      void dependencies.settings.savePending();
    };
    const handleCancelClick = (): void => {
      closeAdvancedConnectionDialog(false);
    };
    const handleCloseClick = (): void => {
      closeAdvancedConnectionDialog(false);
    };
    const handleDialogCancel = (event: Event): void => {
      event.preventDefault();
      closeAdvancedConnectionDialog(false);
    };
    const handleImportCurlClick = (): void => {
      void importCurlIntoRouter();
    };
    const handleUseDetectedRouterClick = (): void => {
      const router = preferredRouter();
      if (router) {
        applyGatewayCandidate(router);
      }
    };
    const handleOpenDetectedRouterClick = (): void => {
      void dependencies.router.runOperation(
        (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
        '正在打开…',
        elements.openDetectedRouterButton,
      );
    };
    const handleRefreshGatewaysClick = (): void => {
      void dependencies.runGuarded(elements.refreshGatewaysButton, '正在检测…', async () => {
        await Promise.all([
          loadGatewayDiagnostics(),
          dependencies.router.loadManagement(),
          loadConnectionAdvice(),
          dependencies.updates.loadSoftwareUpdates(true),
        ]);
      });
    };

    dependencies.openConnectionAdvancedButton.addEventListener(
      'click',
      openAdvancedConnectionDialog,
    );
    dependencies.completeConnectionAdvancedButton.addEventListener('click', handleCompleteClick);
    dependencies.cancelConnectionAdvancedButton.addEventListener('click', handleCancelClick);
    dependencies.closeConnectionAdvancedButton.addEventListener('click', handleCloseClick);
    dependencies.connectionAdvancedDialog.addEventListener('cancel', handleDialogCancel);
    elements.analyzeCurlButton.addEventListener('click', analyzeCurlInput);
    elements.applyCurlDirectButton.addEventListener('click', applyDirectCurlAnalysis);
    dependencies.importCurlRouterButton.addEventListener('click', handleImportCurlClick);
    elements.useDetectedRouterButton.addEventListener('click', handleUseDetectedRouterClick);
    elements.openDetectedRouterButton.addEventListener('click', handleOpenDetectedRouterClick);
    elements.refreshGatewaysButton.addEventListener('click', handleRefreshGatewaysClick);

    return () => {
      dependencies.openConnectionAdvancedButton.removeEventListener(
        'click',
        openAdvancedConnectionDialog,
      );
      dependencies.completeConnectionAdvancedButton.removeEventListener(
        'click',
        handleCompleteClick,
      );
      dependencies.cancelConnectionAdvancedButton.removeEventListener('click', handleCancelClick);
      dependencies.closeConnectionAdvancedButton.removeEventListener('click', handleCloseClick);
      dependencies.connectionAdvancedDialog.removeEventListener('cancel', handleDialogCancel);
      elements.analyzeCurlButton.removeEventListener('click', analyzeCurlInput);
      elements.applyCurlDirectButton.removeEventListener('click', applyDirectCurlAnalysis);
      dependencies.importCurlRouterButton.removeEventListener('click', handleImportCurlClick);
      elements.useDetectedRouterButton.removeEventListener('click', handleUseDetectedRouterClick);
      elements.openDetectedRouterButton.removeEventListener('click', handleOpenDetectedRouterClick);
      elements.refreshGatewaysButton.removeEventListener('click', handleRefreshGatewaysClick);
    };
  };

  return {
    bind,
    clearTestResult,
    closeAdvancedConnectionDialog,
    forgetSession,
    loadConnectionAdvice,
    loadGatewayDiagnostics,
    renderConnectionTest,
    resetForProjectChange,
    rerunAutomaticConnectionTestForActiveProject,
    runConnectionTest,
    scheduleAutomaticConnectionTest,
    setConnectionPolling,
    updateSmartGuidance,
  };
};
