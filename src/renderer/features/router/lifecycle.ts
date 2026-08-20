import type { ClaudeRouterOperationResult } from '../../../shared/contracts';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import type { RouterState } from './state';

export interface RouterLifecycleActions {
  loadAdvancedBackends: () => Promise<void>;
  runUpdate: () => Promise<void>;
  setUpdateAction: (visible: boolean, label: string) => void;
  uninstallRouterCli: (button: HTMLButtonElement) => Promise<void>;
}

export const createRouterLifecycleActions = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  runRouterOperation: (
    action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>,
): RouterLifecycleActions => {
  const loadAdvancedRouterBackends = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    elements.settingsCcrBackendStatus.textContent = status
      ? '正在检查 CCR CLI 后台状态…'
      : '请先打开一个项目后再检查 CCR CLI 后台。';
    elements.settingsChatGptGatewayStatus.textContent = '正在检查 ChatGPT 本地网关状态…';
    elements.settingsOpenCcrBackend.disabled = true;
    elements.settingsOpenChatGptGateway.disabled = true;

    const [routerResult, gatewayResult] = await Promise.allSettled([
      status
        ? window.controlPanel.getClaudeRouterManagementState(status.id)
        : Promise.resolve(undefined),
      window.controlPanel.getManagedChatGptGatewayState(),
    ]);
    if (routerResult.status === 'fulfilled' && routerResult.value) {
      const managementState = routerResult.value;
      state.routerManagementState = managementState;
      elements.settingsCcrBackendStatus.textContent = managementState.serviceRunning
        ? managementState.managementAvailable
          ? `运行中 · ${managementState.version ? `v${managementState.version}` : '版本待识别'}`
          : '检测到后台进程，但不是可安全接管的 CCR CLI。'
        : managementState.installed
          ? 'CCR CLI 已安装，后台当前未运行。'
          : 'CCR CLI 尚未安装。';
      elements.settingsOpenCcrBackend.disabled =
        !managementState.serviceRunning || !managementState.managementAvailable;
    } else if (status) {
      elements.settingsCcrBackendStatus.textContent = '无法读取 CCR CLI 后台状态。';
    }

    if (gatewayResult.status === 'fulfilled') {
      elements.settingsChatGptGatewayStatus.textContent = gatewayResult.value.message;
      elements.settingsOpenChatGptGateway.disabled = !gatewayResult.value.managementAvailable;
    } else {
      elements.settingsChatGptGatewayStatus.textContent = '无法读取 ChatGPT 本地网关状态。';
    }
  };

  const uninstallRouterCli = async (button: HTMLButtonElement): Promise<void> => {
    if (
      !(await dependencies.requestConfirmation({
        confirmLabel: '卸载 CLI',
        message:
          '卸载 ClaudeDock 管理的 CCR CLI？\n\n' +
          '不会卸载 CCR 桌面版，不会改写 Claude/Codex App，也不会删除桌面版可能使用的共享配置。\n' +
          '以后需要时，可在 ClaudeDock 中一键重新安装。',
        title: '卸载 CLI 路由',
        tone: 'danger',
      }))
    ) {
      return;
    }
    void runRouterOperation(
      async (sessionId) => {
        return window.controlPanel.uninstallClaudeRouter(sessionId);
      },
      '正在卸载…',
      button,
    );
  };

  const runUpdate = async (): Promise<void> => {
    await runRouterOperation(
      (sessionId) => window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
      '正在更新…',
      dependencies.installRouterButton,
    );
  };

  const setUpdateAction = (visible: boolean, label: string): void => {
    dependencies.installRouterButton.hidden = !visible;
    dependencies.installRouterButton.textContent = label;
  };

  return {
    loadAdvancedBackends: loadAdvancedRouterBackends,
    runUpdate,
    setUpdateAction,
    uninstallRouterCli,
  };
};
