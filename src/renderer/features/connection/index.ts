import type {
  ClaudeConnectionTestResult,
  ClaudeGatewayDiagnostics,
  ClaudeProjectState,
  SaveClaudeConfigInput,
  SoftwareUpdateState,
} from '../../../shared/contracts';
import type { ClaudeCurlAnalysis } from '../../../shared/claude/curl';
import { createRegistryToken, type Registry } from '../../platform/registry';
import { createConnectionActions, type ConnectionActionsDependencies } from './actions';
import { createConnectionElements } from './elements';
import { createConnectionState } from './state';
import { createConnectionView, type ConnectionViewDependencies } from './view';

export type ConnectionFeatureDependencies = ConnectionActionsDependencies &
  ConnectionViewDependencies;

export interface ConnectionFeature {
  applyRouterRelevance: (updates: SoftwareUpdateState | undefined) => void;
  clearTestResult: () => void;
  closeAdvancedDialog: (complete: boolean) => void;
  dispose: () => void;
  forgetSession: (sessionId: string) => void;
  getCurlAnalysis: () => ClaudeCurlAnalysis | undefined;
  getDiagnostics: () => ClaudeGatewayDiagnostics | undefined;
  isRemedyInProgress: () => boolean;
  isTestInProgress: () => boolean;
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

export const CONNECTION_FEATURE = createRegistryToken<ConnectionFeature>(
  'renderer.feature.connection',
);

const createConnectionFeature = (
  dependencies: ConnectionFeatureDependencies,
): ConnectionFeature => {
  const elements = createConnectionElements();
  const state = createConnectionState();
  const view = createConnectionView(elements, state, {
    routerActions: dependencies.routerActions,
    routerManager: dependencies.routerManager,
  });
  const actions = createConnectionActions(elements, state, dependencies, view);
  const disposeBindings = actions.bind();

  return {
    applyRouterRelevance: view.applyRouterRelevance,
    clearTestResult: actions.clearTestResult,
    closeAdvancedDialog: actions.closeAdvancedConnectionDialog,
    dispose: () => {
      if (state.gatewayRefreshTimer !== undefined) {
        window.clearInterval(state.gatewayRefreshTimer);
        state.gatewayRefreshTimer = undefined;
      }
      disposeBindings();
    },
    forgetSession: actions.forgetSession,
    getCurlAnalysis: () => state.lastCurlAnalysis,
    getDiagnostics: () => state.gatewayDiagnostics,
    isRemedyInProgress: () => state.connectionRemedyInProgress,
    isTestInProgress: () => state.connectionTestInProgress,
    loadConnectionAdvice: actions.loadConnectionAdvice,
    loadGatewayDiagnostics: actions.loadGatewayDiagnostics,
    renderConnectionTest: actions.renderConnectionTest,
    resetForProjectChange: actions.resetForProjectChange,
    rerunAutomaticConnectionTestForActiveProject:
      actions.rerunAutomaticConnectionTestForActiveProject,
    runConnectionTest: actions.runConnectionTest,
    scheduleAutomaticConnectionTest: actions.scheduleAutomaticConnectionTest,
    setConnectionPolling: actions.setConnectionPolling,
    updateSmartGuidance: actions.updateSmartGuidance,
  };
};

export const registerConnectionFeature = (
  registry: Registry,
  dependencies: ConnectionFeatureDependencies,
): void => {
  registry.register(CONNECTION_FEATURE, () => createConnectionFeature(dependencies));
};

export type {
  AdvancedConnectionSnapshot,
  AdvancedDraftControl,
  AdvancedDraftControlState,
} from './state';
