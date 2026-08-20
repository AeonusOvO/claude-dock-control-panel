import type {
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  ClaudeRouterProviderView,
  SaveClaudeRouterProviderInput,
} from '../../../shared/contracts';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import { routerProviderInput } from './provider-form';
import type { RouterState } from './state';
import type { RouterView } from './view';

export interface RouterProviderListActions {
  renderRouterProviderList: (managementState: ClaudeRouterManagementState) => void;
}

export const createRouterProviderListActions = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  view: RouterView,
  runRouterOperation: (
    action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>,
  handleRouterResult: (result: ClaudeRouterOperationResult) => boolean,
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void,
  openRouterProviderForm: (provider?: ClaudeRouterProviderView) => void,
  runRouterProviderSave: (input: SaveClaudeRouterProviderInput) => Promise<boolean>,
): RouterProviderListActions => {
  const renderRouterProviderList = (managementState: ClaudeRouterManagementState): void => {
    elements.routerProviderList.replaceChildren();
    if (!managementState.managementAvailable) {
      const empty = document.createElement('div');
      empty.className = 'router-provider-empty';
      const copy = document.createElement('span');
      copy.textContent = managementState.installed
        ? '启动路由器后即可在这里增删、编辑网关服务提供方。'
        : '完成路由器安装后，点击“启动路由器”即可管理网关。';
      empty.append(copy);
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'button button--secondary button--small';
      action.textContent = managementState.installed ? '启动路由器以管理网关' : '安装路由器';
      action.disabled = state.routerOperationInProgress;
      action.addEventListener('click', () => {
        void runRouterOperation(
          (sessionId) =>
            managementState.installed
              ? window.controlPanel.startClaudeRouter(sessionId)
              : window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
          managementState.installed ? '正在启动…' : '正在安装…',
          action,
        );
      });
      empty.append(action);
      elements.routerProviderList.append(empty);
      dependencies.updateSmartGuidance();
      return;
    }
    if (managementState.providers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'router-provider-empty';
      const copy = document.createElement('span');
      copy.textContent = '还没有服务提供方；可手动添加，或粘贴 OpenAI cURL 后一键导入。';
      empty.append(copy);
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'button button--secondary button--small';
      action.textContent = '添加第一个服务提供方';
      action.disabled = state.routerOperationInProgress;
      action.addEventListener('click', () => {
        openRouterProviderForm();
      });
      empty.append(action);
      elements.routerProviderList.append(empty);
      dependencies.updateSmartGuidance();
      return;
    }

    for (const provider of managementState.providers) {
      const card = document.createElement('article');
      card.className = 'router-provider-card';
      const headline = document.createElement('div');
      headline.className = 'router-provider-card__headline';
      const title = document.createElement('strong');
      title.textContent = provider.name;
      const badge = document.createElement('span');
      badge.textContent = provider.preferred ? '首选' : view.routerProtocolLabel(provider.protocol);
      headline.append(title, badge);

      const endpoint = document.createElement('code');
      endpoint.textContent = provider.baseUrl;
      const meta = document.createElement('span');
      meta.textContent = `${view.routerProtocolLabel(provider.protocol)} · ${
        provider.credentialConfigured ? '已保存上游密钥' : '未保存上游密钥'
      }`;
      const models = document.createElement('small');
      models.textContent = `模型：${provider.models.join('、') || '未配置'}`;

      const actions = document.createElement('div');
      actions.className = 'router-provider-card__actions';
      const useButton = document.createElement('button');
      useButton.type = 'button';
      useButton.textContent = '用于当前项目';
      useButton.disabled =
        provider.models.length === 0 ||
        !/^[A-Za-z0-9._-]+$/.test(provider.name) ||
        provider.models.some((model) => !/^[A-Za-z0-9._/-]+$/.test(model));
      useButton.addEventListener('click', () => {
        void runRouterProviderSave(routerProviderInput(provider, true));
      });
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.textContent = '编辑';
      editButton.addEventListener('click', () => {
        openRouterProviderForm(provider);
      });
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.textContent = '删除';
      deleteButton.addEventListener('click', async () => {
        const status = dependencies.activeStatus();
        if (!status || state.routerOperationInProgress) {
          return;
        }
        if (
          !(await dependencies.requestConfirmation({
            confirmLabel: '删除',
            message: `从路由器删除服务提供方“${provider.name}”？`,
            title: '删除服务提供方',
            tone: 'danger',
          }))
        ) {
          return;
        }
        state.routerOperationInProgress = true;
        try {
          handleRouterResult(
            await window.controlPanel.deleteClaudeRouterProvider(status.id, provider.id),
          );
          void dependencies.loadGatewayDiagnostics();
        } catch {
          dependencies.showToast('删除路由器服务提供方时发生异常。', 'error');
        } finally {
          state.routerOperationInProgress = false;
          if (state.routerManagementState) {
            renderRouterManagement(state.routerManagementState);
          }
        }
      });
      actions.append(useButton, editButton, deleteButton);
      card.append(headline, endpoint, meta, models, actions);
      elements.routerProviderList.append(card);
    }
    dependencies.updateSmartGuidance();
  };

  return {
    renderRouterProviderList,
  };
};
