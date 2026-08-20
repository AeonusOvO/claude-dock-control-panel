import type {
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
} from '../../../shared/contracts';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import type { RouterState } from './state';
import type { RouterView } from './view';

export interface RouterOperationActions {
  handleRouterResult: (result: ClaudeRouterOperationResult) => boolean;
  loadRouterKernelState: () => Promise<void>;
  loadRouterManagement: () => Promise<void>;
  runKernelOperation: (
    action: (sessionId: string) => Promise<RouterKernelOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>;
  runRouterOperation: (
    action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>;
}

export const createRouterOperationActions = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  view: RouterView,
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void,
): RouterOperationActions => {
  const handleRouterResult = (result: ClaudeRouterOperationResult): boolean => {
    renderRouterManagement(result.routerState);
    if (result.projectState) {
      dependencies.renderClaudeState(result.projectState);
      dependencies.populateClaudeConfigForm(result.projectState);
    }
    dependencies.showToast(
      result.ok ? result.message : dependencies.resultFailureMessage(result, result.message),
      result.ok ? 'success' : 'error',
    );
    return result.ok;
  };

  const loadRouterKernelState = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.routerOperationInProgress) {
      return;
    }
    try {
      const kernelState = await window.controlPanel.getRouterKernelState(status.id);
      view.renderRouterKernelState(kernelState);
      renderRouterManagement(kernelState.ccr);
    } catch {
      elements.routerKernelStatus.textContent = '无法读取路由内核状态。';
      elements.routerKernelStatus.dataset.tone = 'danger';
    }
  };

  const runKernelOperation = async (
    action: (sessionId: string) => Promise<RouterKernelOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.routerOperationInProgress) {
      return;
    }
    state.routerOperationInProgress = true;
    view.setRouterOperationStage('准备', busyLabel || '正在准备路由内核操作…', 5);
    await dependencies.runGuarded(button, busyLabel, async () => {
      try {
        view.setRouterOperationStage('执行', busyLabel || '正在执行路由内核操作…', 70);
        const result = await action(status.id);
        view.renderRouterKernelState(result.state);
        renderRouterManagement(result.state.ccr);
        const message = result.ok
          ? result.message
          : dependencies.resultFailureMessage(result, result.message);
        view.setRouterOperationStage(result.ok ? '完成' : '未完成', message, 100);
        dependencies.showToast(message, result.ok ? 'success' : 'error');
      } catch {
        view.setRouterOperationStage('未完成', '路由内核操作发生异常。', 100);
        dependencies.showToast('路由内核操作发生异常。', 'error');
      } finally {
        state.routerOperationInProgress = false;
        if (state.routerKernelState) {
          view.renderRouterKernelState(state.routerKernelState);
        }
      }
    });
  };

  const loadRouterManagement = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.routerRefreshInProgress || state.routerOperationInProgress) {
      return;
    }
    state.routerRefreshInProgress = true;
    try {
      renderRouterManagement(await window.controlPanel.getClaudeRouterManagementState(status.id));
    } catch {
      elements.routerStatus.dataset.state = 'error';
      elements.routerStatusTitle.textContent = '无法读取路由器状态';
      elements.routerStatusDetail.textContent = '仍可使用下方手动 Claude 接入配置。';
    } finally {
      state.routerRefreshInProgress = false;
    }
  };

  const runRouterOperation = async (
    action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.routerOperationInProgress) {
      return;
    }
    state.routerOperationInProgress = true;
    view.setRouterOperationStage('准备', busyLabel || '正在准备路由器操作…', 5);
    await dependencies.runGuarded(button, busyLabel, async () => {
      try {
        view.setRouterOperationStage('执行', busyLabel || '正在执行路由器操作…', 70);
        const result = await action(status.id);
        handleRouterResult(result);
        view.setRouterOperationStage(
          result.ok ? '完成' : '未完成',
          result.ok ? result.message : dependencies.resultFailureMessage(result, result.message),
          100,
        );
        void dependencies.loadGatewayDiagnostics();
        void dependencies.loadSoftwareUpdates(false);
      } catch {
        view.setRouterOperationStage('未完成', '路由器操作发生异常。', 100);
        dependencies.showToast('路由器操作发生异常。', 'error');
      } finally {
        state.routerOperationInProgress = false;
        if (state.routerManagementState) {
          renderRouterManagement(state.routerManagementState);
        }
        void loadRouterKernelState();
      }
    });
  };

  return {
    handleRouterResult,
    loadRouterKernelState,
    loadRouterManagement,
    runKernelOperation,
    runRouterOperation,
  };
};
