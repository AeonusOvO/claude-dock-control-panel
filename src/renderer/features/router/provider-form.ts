import type {
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  ClaudeRouterProviderView,
  SaveClaudeRouterProviderInput,
} from '../../../shared/contracts';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import type { RouterState } from './state';

export const routerProviderInput = (
  provider: ClaudeRouterProviderView,
  useForCurrentProject: boolean,
): SaveClaudeRouterProviderInput => ({
  baseUrl: provider.baseUrl,
  credentialAction: 'keep',
  id: provider.id,
  makePreferred: true,
  models: provider.models,
  name: provider.name,
  protocol: provider.protocol,
  useForCurrentProject,
});

export interface RouterProviderFormActions {
  openRouterProviderForm: (provider?: ClaudeRouterProviderView) => void;
  resetProviderForm: () => void;
  runRouterProviderSave: (input: SaveClaudeRouterProviderInput) => Promise<boolean>;
}

export const createRouterProviderFormActions = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void,
  handleRouterResult: (result: ClaudeRouterOperationResult) => boolean,
): RouterProviderFormActions => {
  const runRouterProviderSave = async (input: SaveClaudeRouterProviderInput): Promise<boolean> => {
    const status = dependencies.activeStatus();
    if (!status || state.routerOperationInProgress) {
      return false;
    }
    state.routerOperationInProgress = true;
    renderRouterManagement(
      state.routerManagementState ?? {
        canUninstall: false,
        checkedAt: Date.now(),
        endpoint: 'http://127.0.0.1:3456',
        gatewayState: 'unknown',
        installed: false,
        installationKind: 'unknown',
        manageable: false,
        managementAvailable: false,
        message: '正在保存路由器服务提供方…',
        providers: [],
        serviceRunning: false,
      },
    );
    try {
      const result = await window.controlPanel.saveClaudeRouterProvider(status.id, input);
      const ok = handleRouterResult(result);
      if (ok) {
        elements.routerProviderForm.hidden = true;
        elements.routerProviderApiKey.value = '';
        void dependencies.loadGatewayDiagnostics();
      }
      return ok;
    } catch {
      dependencies.showToast('保存路由器服务提供方时发生异常。', 'error');
      return false;
    } finally {
      state.routerOperationInProgress = false;
      if (state.routerManagementState) {
        renderRouterManagement(state.routerManagementState);
      }
    }
  };

  const openRouterProviderForm = (provider?: ClaudeRouterProviderView): void => {
    elements.routerProviderId.value = provider?.id ?? '';
    elements.routerProviderName.value = provider?.name ?? '';
    elements.routerProviderBaseUrl.value = provider?.baseUrl ?? '';
    elements.routerProviderProtocol.value = provider?.protocol ?? 'openai_chat_completions';
    elements.routerProviderModels.value = provider?.models.join('\n') ?? '';
    elements.routerProviderApiKey.value = '';
    elements.routerProviderPreferred.checked = provider?.preferred ?? true;
    elements.routerProviderUseProject.checked = true;
    elements.routerProviderFormTitle.textContent = provider
      ? `编辑 ${provider.name}`
      : '添加服务提供方';
    elements.routerProviderForm.hidden = false;
    elements.routerProviderForm.scrollIntoView({
      behavior: userScrollBehavior(),
      block: 'nearest',
    });
    elements.routerProviderName.focus();
  };

  const resetProviderForm = (): void => {
    elements.routerProviderForm.hidden = true;
    elements.routerProviderApiKey.value = '';
  };

  return {
    openRouterProviderForm,
    resetProviderForm,
    runRouterProviderSave,
  };
};
import { userScrollBehavior } from '../../platform/motion';
