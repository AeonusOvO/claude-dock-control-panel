import type {
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
} from '../../../shared/contracts';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import type { RouterState } from './state';

export interface RouterBackendBindings {
  bindRouterBackend: () => void;
}

export const createRouterBackendBindings = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  handleRouterResult: (result: ClaudeRouterOperationResult) => boolean,
  loadAdvancedRouterBackends: () => Promise<void>,
  runKernelOperation: (
    action: (sessionId: string) => Promise<RouterKernelOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>,
): RouterBackendBindings => {
  const bindRouterBackend = (): void => {
    elements.settingsOpenCcrBackend.addEventListener('click', () => {
      const status = dependencies.activeStatus();
      if (!status || elements.settingsOpenCcrBackend.disabled) {
        return;
      }
      void dependencies.runGuarded(elements.settingsOpenCcrBackend, '正在打开…', async () => {
        const result = await window.controlPanel.openClaudeRouterManagement(status.id);
        handleRouterResult(result);
        await loadAdvancedRouterBackends();
      });
    });
    elements.settingsOpenChatGptGateway.addEventListener('click', () => {
      if (elements.settingsOpenChatGptGateway.disabled) {
        return;
      }
      void dependencies.runGuarded(elements.settingsOpenChatGptGateway, '正在打开…', async () => {
        const result = await window.controlPanel.openManagedChatGptGatewayManagement();
        dependencies.showToast(
          result.ok
            ? (result.message ?? '已打开 ChatGPT 网关后台。')
            : dependencies.resultFailureMessage(result, '无法打开 ChatGPT 网关后台。'),
          result.ok ? 'success' : 'error',
        );
        await loadAdvancedRouterBackends();
      });
    });
    elements.installCcSwitchButton.addEventListener('click', () => {
      void runKernelOperation(
        (sessionId) => window.controlPanel.installCcSwitch(sessionId),
        '正在安装…',
        elements.installCcSwitchButton,
      );
    });
    elements.exportCcSwitchButton.addEventListener('click', () => {
      void runKernelOperation(
        (sessionId) => window.controlPanel.exportCurrentProviderToCcSwitch(sessionId),
        '正在导出…',
        elements.exportCcSwitchButton,
      );
    });
    elements.uninstallCcSwitchButton.addEventListener('click', async () => {
      const residuals = state.routerKernelState?.ccSwitch.residuals ?? [];
      if (
        !(await dependencies.requestConfirmation({
          confirmLabel: '彻底卸载',
          message:
            '将通过 Windows Installer 卸载 CC Switch，并删除以下已知数据目录：\n' +
            (residuals.length > 0
              ? residuals.join('\n')
              : '卸载后扫描到的 CC Switch 专属数据目录') +
            '\n\n不会读取或修改 CC Switch 的 SQLite 内容；目录将整体删除且无法恢复。',
          title: '彻底卸载 CC Switch',
          tone: 'danger',
        }))
      ) {
        return;
      }
      void runKernelOperation(
        (sessionId) => window.controlPanel.uninstallCcSwitch(sessionId),
        '正在卸载…',
        elements.uninstallCcSwitchButton,
      );
    });
  };

  return {
    bindRouterBackend,
  };
};
