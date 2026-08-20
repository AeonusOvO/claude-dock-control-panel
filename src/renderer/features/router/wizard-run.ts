import type {
  ClaudeConnectionTestResult,
  ClaudeProjectState,
  ClaudeRouterManagementState,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
import { findClaudeProvider } from '../../../shared/claude/providers';
import { ROUTER_CAPABILITIES } from '../../../shared/router/capabilities';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import type { RouterState } from './state';
import type { RouterView } from './view';

export interface RouterWizardRunActions {
  runRouterWizard: () => Promise<void>;
}

export const createRouterWizardRunActions = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  view: RouterView,
  wizardDirectInput: () => SaveClaudeConfigInput,
  setRouterWizardModels: (models: readonly string[], preferred?: string) => void,
  verifySavedRouterConfiguration: (
    sessionId: string,
    projectState: ClaudeProjectState | undefined,
  ) => Promise<ClaudeConnectionTestResult | undefined>,
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void,
  loadRouterKernelState: () => Promise<void>,
): RouterWizardRunActions => {
  const runRouterWizard = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    const provider = findClaudeProvider(elements.routerWizardProvider.value);
    if (
      !status ||
      !provider ||
      state.routerOperationInProgress ||
      !elements.routerWizardForm.reportValidity()
    ) {
      return;
    }
    const capability = ROUTER_CAPABILITIES[provider.id];
    const routed = capability.mode === 'router-required';
    state.routerOperationInProgress = true;
    view.setRouterOperationStage('准备', `正在校验 ${provider.label} 接入参数…`, 5);
    await dependencies.runGuarded(elements.routerWizardSubmit, '正在自动配置…', async () => {
      try {
        if (!routed) {
          const input = wizardDirectInput();
          view.setRouterOperationStage(
            '连通性校验',
            '先验证端点、认证与模型，避免写入不可用配置。',
            55,
          );
          const test = await window.controlPanel.testClaudeConnection(status.id, input);
          dependencies.renderConnectionTest(test);
          if (!test.ok) {
            throw new Error(test.message);
          }
          view.setRouterOperationStage('写入配置', '正在保存项目级 Claude Code CLI 接入配置…', 80);
          const saved = await window.controlPanel.saveClaudeConfig(status.id, input);
          dependencies.renderClaudeState(saved.state);
          if (!saved.ok) {
            throw new Error(saved.error ?? '无法保存接入配置。');
          }
          dependencies.populateClaudeConfigForm(saved.state);
        } else {
          const upstreamBaseUrl = provider.editableBaseUrl
            ? elements.routerWizardBaseUrl.value.trim()
            : provider.baseUrl;
          const upstreamCredential =
            provider.id === 'ollama'
              ? undefined
              : elements.routerWizardCredential.value.trim() || undefined;
          view.setRouterOperationStage(
            '发现模型',
            '正在读取当前接口的实时模型列表；这一步同时验证地址与密钥。',
            10,
          );
          const discovery = await window.controlPanel.discoverClaudeProviderModels({
            baseUrl: upstreamBaseUrl,
            credential: upstreamCredential,
          });
          if (!discovery.ok || discovery.models.length === 0) {
            throw new Error(discovery.error ?? discovery.message);
          }
          const selectedBeforeDiscovery = elements.routerWizardModel.value;
          setRouterWizardModels(
            discovery.models,
            discovery.models.includes(selectedBeforeDiscovery)
              ? selectedBeforeDiscovery
              : discovery.models[0],
          );
          view.setRouterOperationStage('检查路由内核', '正在确认 CCR 已安装且管理接口可用…', 15);
          let management = await window.controlPanel.getClaudeRouterManagementState(status.id);
          if (!management.installed) {
            view.setRouterOperationStage('安装路由内核', '正在通过受管下载与 npm 安装 CCR…', 25);
            const installed = await window.controlPanel.installClaudeRouterFromSource(
              status.id,
              'npm',
            );
            renderRouterManagement(installed.routerState);
            if (!installed.ok) {
              throw new Error(installed.message);
            }
            management = installed.routerState;
          }
          if (!management.managementAvailable) {
            view.setRouterOperationStage('启动路由内核', '正在启动 CCR 并等待本地管理端点…', 65);
            const started = await window.controlPanel.startClaudeRouter(status.id);
            renderRouterManagement(started.routerState);
            if (!started.routerState.managementAvailable) {
              throw new Error(started.message);
            }
            management = started.routerState;
          }
          view.setRouterOperationStage('写入路由配置', '正在写入上游、模型与当前项目绑定…', 80);
          const baseUrl = upstreamBaseUrl;
          const existing = management.providers.find(
            (item) => item.name === `wizard-${provider.id}`,
          );
          const saved = await window.controlPanel.saveClaudeRouterProvider(status.id, {
            apiKey:
              provider.id === 'ollama'
                ? elements.routerWizardCredential.value.trim() || 'ollama'
                : elements.routerWizardCredential.value.trim(),
            baseUrl,
            credentialAction: 'replace',
            id: existing?.id,
            makePreferred: true,
            models: [elements.routerWizardModel.value],
            name: `wizard-${provider.id}`,
            protocol: 'openai_chat_completions',
            useForCurrentProject: true,
          });
          renderRouterManagement(saved.routerState);
          if (saved.projectState) {
            dependencies.renderClaudeState(saved.projectState);
            dependencies.populateClaudeConfigForm(saved.projectState);
          }
          if (!saved.ok) {
            throw new Error(saved.message);
          }
          view.setRouterOperationStage('连通性校验', '正在通过本地路由验证端点、认证与模型…', 92);
          const test = await verifySavedRouterConfiguration(status.id, saved.projectState);
          if (test) {
            dependencies.renderConnectionTest(test);
            if (!test.ok) {
              throw new Error(test.message);
            }
          }
        }
        elements.routerWizardCredential.value = '';
        view.setRouterOperationStage('完成', `${provider.label} 已配置并通过真实连接校验。`, 100);
        dependencies.showToast(`${provider.label} 接入已完成`);
        void dependencies.loadConnectionHistory();
        void dependencies.loadGatewayDiagnostics();
      } catch (error) {
        const message = error instanceof Error ? error.message : '自动配置失败。';
        view.setRouterOperationStage('未完成', message, 100);
        dependencies.showToast(message, 'error');
      } finally {
        state.routerOperationInProgress = false;
        void loadRouterKernelState();
      }
    });
  };

  return {
    runRouterWizard,
  };
};
