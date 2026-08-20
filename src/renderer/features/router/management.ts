import type { ClaudeRouterManagementState } from '../../../shared/contracts';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import type { RouterState } from './state';
import type { RouterView } from './view';

export interface RouterManagementActions {
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void;
}

export const createRouterManagementActions = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  view: RouterView,
  renderRouterProviderList: (managementState: ClaudeRouterManagementState) => void,
): RouterManagementActions => {
  const renderRouterManagement = (managementState: ClaudeRouterManagementState): void => {
    state.routerManagementState = managementState;
    const displayState = managementState.installed ? managementState.gatewayState : 'not-installed';
    elements.routerStatus.dataset.state = displayState;
    elements.routerStatusTitle.textContent = !managementState.installed
      ? '尚未安装 Claude Code 路由器'
      : managementState.gatewayState === 'running'
        ? '路由器网关正在运行'
        : managementState.serviceRunning
          ? '路由器管理服务已运行'
          : '路由器已安装但未运行';
    elements.routerStatusDetail.textContent = managementState.message;
    const progress = state.lastRouterOperationProgress;
    if (progress && (progress.active || Date.now() - progress.updatedAt < 6_000)) {
      elements.routerStatus.dataset.state = progress.stage === 'error' ? 'error' : 'starting';
      elements.routerStatusTitle.textContent = `${view.routerOperationLabel(progress)} · 第 ${progress.step}/${progress.totalSteps} 步`;
      elements.routerStatusDetail.textContent = progress.detail;
    }
    elements.routerVersion.textContent = managementState.version
      ? `v${managementState.version}`
      : '版本待识别';
    view.renderRouterRemediation(managementState);
    dependencies.applyRouterRelevance();

    dependencies.installRouterButton.disabled = state.routerOperationInProgress;
    dependencies.syncUpdateActionVisibility();
    elements.uninstallRouterButton.disabled =
      state.routerOperationInProgress || !managementState.canUninstall;
    elements.uninstallRouterButton.title = managementState.canUninstall
      ? '只卸载 ClaudeDock 管理的 CCR CLI；不会卸载桌面版或改写 Claude/Codex App'
      : '未检测到可由 ClaudeDock 卸载的 CCR CLI';
    dependencies.startRouterButton.textContent = managementState.runtimeMismatch
      ? '修复运行环境并重启'
      : '启动路由器';
    dependencies.startRouterButton.disabled =
      state.routerOperationInProgress ||
      !managementState.installed ||
      !managementState.manageable ||
      (!managementState.runtimeMismatch && managementState.providers.length === 0) ||
      managementState.gatewayState === 'running' ||
      managementState.gatewayState === 'starting';
    elements.stopRouterButton.disabled =
      state.routerOperationInProgress ||
      !managementState.serviceRunning ||
      managementState.gatewayState !== 'running';
    elements.openRouterManagementButton.disabled =
      state.routerOperationInProgress || !managementState.installed || !managementState.manageable;
    elements.addRouterProviderButton.disabled =
      state.routerOperationInProgress || !managementState.managementAvailable;
    elements.saveRouterProviderButton.disabled = state.routerOperationInProgress;
    const curlAnalysis = dependencies.getCurlAnalysis();
    if (curlAnalysis?.protocol === 'openai') {
      dependencies.importCurlRouterButton.hidden =
        !curlAnalysis.model ||
        !curlAnalysis.credentialDetected ||
        !managementState.installed ||
        !managementState.manageable;
    }

    renderRouterProviderList(managementState);
  };

  return {
    renderRouterManagement,
  };
};
