import type {
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  ClaudeRouterProviderView,
  SaveClaudeRouterProviderInput,
} from '../../../shared/contracts';
import type { RouterActionsDependencies } from './dependencies';
import type { RouterElements } from './elements';
import type { RouterState } from './state';
import type { RouterView } from './view';

export interface RouterOperationBindings {
  bindRouterOperations: () => () => void;
}

export const createRouterOperationBindings = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterActionsDependencies,
  view: RouterView,
  runRouterOperation: (
    action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
    busyLabel: string,
    button: HTMLButtonElement,
  ) => Promise<void>,
  uninstallRouterCli: (button: HTMLButtonElement) => Promise<void>,
  openRouterProviderForm: (provider?: ClaudeRouterProviderView) => void,
  resetProviderForm: () => void,
  runRouterProviderSave: (input: SaveClaudeRouterProviderInput) => Promise<boolean>,
  renderRouterManagement: (managementState: ClaudeRouterManagementState) => void,
): RouterOperationBindings => {
  const bindRouterOperations = (): (() => void) => {
    dependencies.installRouterButton.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) => window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
        '正在安装…',
        dependencies.installRouterButton,
      );
    });
    elements.uninstallRouterButton.addEventListener('click', () => {
      void uninstallRouterCli(elements.uninstallRouterButton);
    });
    dependencies.startRouterButton.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
        '正在启动…',
        dependencies.startRouterButton,
      );
    });
    elements.stopRouterButton.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) => window.controlPanel.stopClaudeRouter(sessionId),
        '正在停止…',
        elements.stopRouterButton,
      );
    });
    elements.openRouterManagementButton.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
        '正在打开…',
        elements.openRouterManagementButton,
      );
    });
    elements.repairRouterFromProjectButton.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) => window.controlPanel.repairClaudeRouterFromProject(sessionId),
        '正在创建服务提供方并启动…',
        elements.repairRouterFromProjectButton,
      );
    });
    elements.configureRouterProviderButton.addEventListener('click', () => {
      const provider =
        state.routerManagementState?.providers.find((candidate) => candidate.preferred) ??
        state.routerManagementState?.providers[0];
      openRouterProviderForm(provider);
      if (provider) {
        return;
      }
      const config = dependencies.getActiveProjectState()?.config;
      if (
        !config ||
        config.provider !== 'gateway' ||
        !view.projectUsesHttpsGateway(config.baseUrl) ||
        view.projectUsesDefaultRouter(config.baseUrl)
      ) {
        return;
      }
      const endpoint = new URL(config.baseUrl);
      const pathname = endpoint.pathname.replace(/\/+$/, '');
      endpoint.pathname = /\/v1\/messages$/i.test(pathname)
        ? pathname
        : `${pathname}/v1/messages`.replace(/\/{2,}/g, '/');
      const providerSuffix =
        endpoint.hostname
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 65) || 'current-project';
      elements.routerProviderName.value = `claudedock-${providerSuffix}`;
      elements.routerProviderProtocol.value = 'anthropic_messages';
      elements.routerProviderBaseUrl.value = endpoint.toString();
      elements.routerProviderModels.value = config.model;
    });
    elements.addRouterProviderButton.addEventListener('click', () => {
      openRouterProviderForm();
    });
    elements.cancelRouterProviderButton.addEventListener('click', () => {
      resetProviderForm();
    });
    elements.routerProviderForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const apiKey = elements.routerProviderApiKey.value.trim();
      void runRouterProviderSave({
        apiKey: apiKey || undefined,
        baseUrl: elements.routerProviderBaseUrl.value,
        credentialAction: elements.routerProviderId.value && !apiKey ? 'keep' : 'replace',
        id: elements.routerProviderId.value || undefined,
        makePreferred: elements.routerProviderPreferred.checked,
        models: elements.routerProviderModels.value.split(/\r?\n/),
        name: elements.routerProviderName.value,
        protocol: elements.routerProviderProtocol
          .value as SaveClaudeRouterProviderInput['protocol'],
        useForCurrentProject: elements.routerProviderUseProject.checked,
      });
    });

    const unsubscribeRouterOperationProgress = window.controlPanel.onRouterOperationProgress(
      (progress) => {
        state.lastRouterOperationProgress = progress;
        state.routerOperationInProgress = progress.active;
        view.setRouterOperationStage(
          `${view.routerOperationLabel(progress)} · 第 ${progress.step}/${progress.totalSteps} 步`,
          progress.detail,
          (progress.step / Math.max(1, progress.totalSteps)) * 100,
        );
        if (state.routerManagementState) {
          renderRouterManagement(state.routerManagementState);
        }
        if (!progress.active) {
          window.setTimeout(() => {
            if (
              state.lastRouterOperationProgress?.updatedAt === progress.updatedAt &&
              state.routerManagementState
            ) {
              renderRouterManagement(state.routerManagementState);
            }
          }, 6_100);
        }
      },
    );

    return () => {
      unsubscribeRouterOperationProgress();
    };
  };

  return {
    bindRouterOperations,
  };
};
