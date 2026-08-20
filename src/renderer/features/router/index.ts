import type {
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
  SaveClaudeRouterProviderInput,
} from '../../../shared/contracts';
import { createRegistryToken, type Registry } from '../../platform/registry';
import { createRouterActions, type RouterActionsDependencies } from './actions';
import { createRouterElements } from './elements';
import { createRouterState } from './state';
import { createRouterView, type RouterViewDependencies } from './view';

export type RouterFeatureDependencies = RouterActionsDependencies & RouterViewDependencies;

export interface RouterFeature {
  dispose: () => void;
  getManagementState: () => ClaudeRouterManagementState | undefined;
  handleRouterResult: (result: ClaudeRouterOperationResult) => boolean;
  isOperationInProgress: () => boolean;
  loadAdvancedBackends: () => Promise<void>;
  loadKernelState: () => Promise<void>;
  loadManagement: () => Promise<void>;
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void;
  renderRemediation: (managementState: ClaudeRouterManagementState) => void;
  resetProviderForm: () => void;
  runKernelOperation: (
    action: (sessionId: string) => Promise<RouterKernelOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>;
  runOperation: (
    action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>;
  runRouterProviderSave: (input: SaveClaudeRouterProviderInput) => Promise<boolean>;
  runRouterWizard: () => Promise<void>;
  runUpdate: () => Promise<void>;
  setOperationStage: (stage: string, detail: string, percent?: number) => void;
  setUpdateAction: (visible: boolean, label: string) => void;
  syncRouterWizard: () => void;
  uninstallRouterCli: (button: HTMLButtonElement) => Promise<void>;
}

export const ROUTER_FEATURE = createRegistryToken<RouterFeature>('renderer.feature.router');

const createRouterFeature = (dependencies: RouterFeatureDependencies): RouterFeature => {
  const elements = createRouterElements();
  const state = createRouterState();
  const view = createRouterView(elements, state, {
    activeStatus: dependencies.activeStatus,
    getActiveProjectState: dependencies.getActiveProjectState,
  });
  const actions = createRouterActions(elements, state, dependencies, view);
  const disposeBindings = actions.bind();

  return {
    dispose: () => {
      disposeBindings();
    },
    getManagementState: () => state.routerManagementState,
    handleRouterResult: actions.handleRouterResult,
    isOperationInProgress: () => state.routerOperationInProgress,
    loadAdvancedBackends: actions.loadAdvancedBackends,
    loadKernelState: actions.loadKernelState,
    loadManagement: actions.loadManagement,
    renderRouterManagement: actions.renderRouterManagement,
    renderRemediation: view.renderRouterRemediation,
    resetProviderForm: actions.resetProviderForm,
    runKernelOperation: actions.runKernelOperation,
    runOperation: actions.runOperation,
    runRouterProviderSave: actions.runRouterProviderSave,
    runRouterWizard: actions.runRouterWizard,
    runUpdate: actions.runUpdate,
    setOperationStage: view.setRouterOperationStage,
    setUpdateAction: actions.setUpdateAction,
    syncRouterWizard: actions.syncRouterWizard,
    uninstallRouterCli: actions.uninstallRouterCli,
  };
};

export const registerRouterFeature = (
  registry: Registry,
  dependencies: RouterFeatureDependencies,
): void => {
  registry.register(ROUTER_FEATURE, () => createRouterFeature(dependencies));
};
