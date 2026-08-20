import type { ClaudeProjectState, SaveClaudeConfigInput } from '../../../shared/contracts';
import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';

export interface ConnectionLifecycleActions {
  clearTestResult: () => void;
  forgetSession: (sessionId: string) => void;
  resetForProjectChange: () => void;
  rerunAutomaticConnectionTestForActiveProject: () => void;
  scheduleAutomaticConnectionTest: (projectState: ClaudeProjectState) => void;
  setConnectionPolling: (enabled: boolean) => void;
}

export const createConnectionLifecycleActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  loadGatewayDiagnostics: () => Promise<void>,
  loadConnectionAdvice: () => Promise<void>,
  runConnectionTest: (
    saveOnSuccess?: boolean,
    configInput?: SaveClaudeConfigInput,
  ) => Promise<void>,
): ConnectionLifecycleActions => {
  const scheduleAutomaticConnectionTest = (projectState: ClaudeProjectState): void => {
    if (
      projectState.sessionId !== dependencies.getActiveSessionId() ||
      dependencies.getDevelopmentRuntime(projectState.sessionId)?.runtime !== 'claude' ||
      state.automaticConnectionTestSessions.has(projectState.sessionId)
    ) {
      return;
    }
    state.automaticConnectionTestSessions.add(projectState.sessionId);
    window.setTimeout(() => {
      const currentState = dependencies.getClaudeState(projectState.sessionId);
      if (
        !currentState ||
        dependencies.getActiveSessionId() !== projectState.sessionId ||
        dependencies.getDevelopmentRuntime(projectState.sessionId)?.runtime !== 'claude'
      ) {
        state.automaticConnectionTestSessions.delete(projectState.sessionId);
        return;
      }
      if (state.connectionTestInProgress) {
        state.automaticConnectionTestSessions.delete(projectState.sessionId);
        window.setTimeout(() => scheduleAutomaticConnectionTest(currentState), 250);
        return;
      }
      void runConnectionTest(false, dependencies.savedClaudeConfigInput(currentState.config));
    }, 0);
  };

  const rerunAutomaticConnectionTestForActiveProject = (): void => {
    const status = dependencies.activeStatus();
    const projectState = status ? dependencies.getClaudeState(status.id) : undefined;
    if (
      !projectState ||
      dependencies.getDevelopmentRuntime(projectState.sessionId)?.runtime !== 'claude'
    ) {
      return;
    }
    state.automaticConnectionTestSessions.delete(projectState.sessionId);
    scheduleAutomaticConnectionTest(projectState);
  };

  /**
   * The connection page polls, because Router state changes underneath us (installs, crashes, the
   * user starting CCR by hand). Nothing else needs a timer, so it only runs while that tab is open.
   */
  const setConnectionPolling = (enabled: boolean): void => {
    if (enabled) {
      void loadGatewayDiagnostics();
      void dependencies.router.loadManagement();
      void loadConnectionAdvice();
      void dependencies.updates.loadSoftwareUpdates(false);
      if (state.gatewayRefreshTimer === undefined) {
        state.gatewayRefreshTimer = window.setInterval(() => {
          if (state.connectionTestInProgress) {
            return;
          }
          void loadGatewayDiagnostics();
          void dependencies.router.loadManagement();
          void loadConnectionAdvice();
          void dependencies.updates.loadSoftwareUpdates(false);
        }, 6_000);
      }
      return;
    }
    if (state.gatewayRefreshTimer !== undefined) {
      window.clearInterval(state.gatewayRefreshTimer);
      state.gatewayRefreshTimer = undefined;
    }
  };

  const clearTestResult = (): void => {
    elements.connectionTestResult.hidden = true;
    elements.connectionRemedy.hidden = true;
  };

  const resetForProjectChange = (): void => {
    state.advancedConnectionSnapshot = undefined;
    if (dependencies.connectionAdvancedDialog.open) {
      dependencies.connectionAdvancedDialog.close('project-changed');
    }
    state.gatewayDiagnostics = undefined;
    state.lastCurlAnalysis = undefined;
    elements.curlInput.value = '';
    elements.curlAnalysis.hidden = true;
    dependencies.importCurlRouterButton.hidden = true;
    elements.connectionTestResult.hidden = true;
    elements.gatewayCandidates.replaceChildren();
    elements.gatewayDiagnosticsSummary.textContent = '正在检查常见本地端口、命令和 Claude 设置…';
    elements.gatewayCheckedAt.textContent = '等待首次检测';
  };

  const forgetSession = (sessionId: string): void => {
    state.automaticConnectionTestSessions.delete(sessionId);
  };

  return {
    clearTestResult,
    forgetSession,
    resetForProjectChange,
    rerunAutomaticConnectionTestForActiveProject,
    scheduleAutomaticConnectionTest,
    setConnectionPolling,
  };
};
