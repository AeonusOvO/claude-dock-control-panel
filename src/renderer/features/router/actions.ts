import type {
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
  SaveClaudeRouterProviderInput,
} from '../../../shared/contracts';
import { createRouterBackendBindings } from './bindings-backend';
import { createRouterOperationBindings } from './bindings-operations';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import { createRouterLifecycleActions } from './lifecycle';
import { createRouterManagementActions } from './management';
import { createRouterOperationActions } from './operations';
import { createRouterProviderFormActions } from './provider-form';
import { createRouterProviderListActions } from './provider-list';
import type { RouterState } from './state';
import type { RouterView } from './view';
import { createRouterWizardActions } from './wizard';
import { createRouterWizardRunActions } from './wizard-run';

export type { RouterActionsDependencies, RouterConfirmationRequest } from './dependencies';

export interface RouterActions {
  bind: () => () => void;
  handleRouterResult: (result: ClaudeRouterOperationResult) => boolean;
  loadAdvancedBackends: () => Promise<void>;
  loadKernelState: () => Promise<void>;
  loadManagement: () => Promise<void>;
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void;
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
  setUpdateAction: (visible: boolean, label: string) => void;
  syncRouterWizard: () => void;
  uninstallRouterCli: (button: HTMLButtonElement) => Promise<void>;
}

export const createRouterActions = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  view: RouterView,
): RouterActions => {
  const formActions = createRouterProviderFormActions(
    elements,
    state,
    dependencies,
    (managementState) => managementActions.renderRouterManagement(managementState),
    (result) => operationActions.handleRouterResult(result),
  );
  const managementActions = createRouterManagementActions(
    elements,
    state,
    dependencies,
    view,
    (managementState) => listActions.renderRouterProviderList(managementState),
  );
  const listActions = createRouterProviderListActions(
    elements,
    state,
    dependencies,
    view,
    (action, busyLabel, button) => operationActions.runRouterOperation(action, busyLabel, button),
    (result) => operationActions.handleRouterResult(result),
    managementActions.renderRouterManagement,
    formActions.openRouterProviderForm,
    formActions.runRouterProviderSave,
  );
  const operationActions = createRouterOperationActions(
    elements,
    state,
    dependencies,
    view,
    managementActions.renderRouterManagement,
  );
  const wizardActions = createRouterWizardActions(elements, state, () =>
    wizardRunActions.runRouterWizard(),
  );
  const wizardRunActions = createRouterWizardRunActions(
    elements,
    state,
    dependencies,
    view,
    wizardActions.wizardDirectInput,
    wizardActions.setRouterWizardModels,
    wizardActions.verifySavedRouterConfiguration,
    managementActions.renderRouterManagement,
    operationActions.loadRouterKernelState,
  );
  const lifecycleActions = createRouterLifecycleActions(
    elements,
    state,
    dependencies,
    operationActions.runRouterOperation,
  );
  const backendBindings = createRouterBackendBindings(
    elements,
    state,
    dependencies,
    operationActions.handleRouterResult,
    lifecycleActions.loadAdvancedBackends,
    operationActions.runKernelOperation,
  );
  const operationBindings = createRouterOperationBindings(
    elements,
    state,
    dependencies,
    view,
    operationActions.runRouterOperation,
    lifecycleActions.uninstallRouterCli,
    formActions.openRouterProviderForm,
    formActions.resetProviderForm,
    formActions.runRouterProviderSave,
    managementActions.renderRouterManagement,
  );

  const bind = (): (() => void) => {
    backendBindings.bindRouterBackend();
    wizardActions.bindRouterWizard();
    return operationBindings.bindRouterOperations();
  };

  return {
    bind,
    handleRouterResult: operationActions.handleRouterResult,
    loadAdvancedBackends: lifecycleActions.loadAdvancedBackends,
    loadKernelState: operationActions.loadRouterKernelState,
    loadManagement: operationActions.loadRouterManagement,
    renderRouterManagement: managementActions.renderRouterManagement,
    resetProviderForm: formActions.resetProviderForm,
    runKernelOperation: operationActions.runKernelOperation,
    runOperation: operationActions.runRouterOperation,
    runRouterProviderSave: formActions.runRouterProviderSave,
    runRouterWizard: wizardRunActions.runRouterWizard,
    runUpdate: lifecycleActions.runUpdate,
    setUpdateAction: lifecycleActions.setUpdateAction,
    syncRouterWizard: wizardActions.syncRouterWizard,
    uninstallRouterCli: lifecycleActions.uninstallRouterCli,
  };
};
