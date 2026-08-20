import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';

export interface SmartGuidanceActions {
  updateSmartGuidance: () => void;
}

export const createSmartGuidanceActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  importCurlIntoRouter: () => Promise<void>,
): SmartGuidanceActions => {
  const updateSmartGuidance = (): void => {
    const projectState = dependencies.getClaudeState(dependencies.getActiveSessionId());
    const curlResult = state.lastCurlAnalysis;
    const routerState = dependencies.router.getManagementState();

    // Guidance here is strictly about the pasted cURL. The project-level "how should this connect"
    // question is answered unconditionally by #connection-advice, so there is nothing to say yet.
    if (!curlResult) {
      elements.smartGuidance.hidden = true;
      return;
    }

    const projectConfig = projectState?.config;
    const routerRunning = routerState?.gatewayState === 'running';
    const routerInstalled = routerState?.installed ?? false;

    // Scenario 1: Anthropic direct + Router running unused
    if (
      curlResult.protocol === 'anthropic' &&
      routerRunning &&
      projectConfig?.provider !== 'gateway'
    ) {
      elements.smartGuidance.hidden = false;
      elements.smartGuidance.dataset.tone = 'info';
      elements.smartGuidanceTitle.textContent = '检测到可直连的 Anthropic 接口';
      elements.smartGuidanceDetail.textContent =
        '路由器当前未被使用。您可以直接接入，或者停止路由器以节省系统资源。';

      elements.smartGuidanceActions.replaceChildren();
      const stopButton = document.createElement('button');
      stopButton.type = 'button';
      stopButton.textContent = '停止空闲路由器';
      stopButton.className = 'button button--secondary button--small';
      stopButton.addEventListener('click', () => {
        void dependencies.router.runOperation(
          (sessionId) => window.controlPanel.stopClaudeRouter(sessionId),
          '正在停止…',
          stopButton,
        );
      });
      elements.smartGuidanceActions.append(stopButton);
      return;
    }

    // Scenario 2: OpenAI format + Router not running
    if (curlResult.protocol === 'openai' && !routerRunning) {
      elements.smartGuidance.hidden = false;
      elements.smartGuidance.dataset.tone = 'warning';
      elements.smartGuidanceTitle.textContent = 'OpenAI 格式需要转换器';
      elements.smartGuidanceDetail.textContent = routerInstalled
        ? '检测到 OpenAI 格式接口，需要先启动路由器将其转换为 Anthropic 格式。'
        : '检测到 OpenAI 格式接口，需要安装 Claude Code 路由器转换器。';

      elements.smartGuidanceActions.replaceChildren();
      if (routerInstalled && curlResult.model && curlResult.credentialDetected) {
        const importButton = document.createElement('button');
        importButton.type = 'button';
        importButton.textContent = '一键导入路由器';
        importButton.className = 'button button--primary button--small';
        importButton.addEventListener('click', () => {
          void importCurlIntoRouter();
        });
        elements.smartGuidanceActions.append(importButton);
      } else if (!routerInstalled) {
        const installButton = document.createElement('button');
        installButton.type = 'button';
        installButton.textContent = '安装路由器';
        installButton.className = 'button button--primary button--small';
        installButton.addEventListener('click', () => {
          void dependencies.router.runOperation(
            (sessionId) => window.controlPanel.installClaudeRouter(sessionId),
            '正在下载…',
            installButton,
          );
        });
        elements.smartGuidanceActions.append(installButton);
      }
      return;
    }

    // Scenario 3: Project using Router + Router stopped
    if (
      projectConfig?.provider === 'gateway' &&
      projectConfig.baseUrl.includes('127.0.0.1:3456') &&
      routerState?.gatewayState === 'stopped'
    ) {
      elements.smartGuidance.hidden = false;
      elements.smartGuidance.dataset.tone = 'error';
      elements.smartGuidanceTitle.textContent = '当前项目依赖路由器';
      elements.smartGuidanceDetail.textContent =
        '项目配置指向本地路由器，但网关未运行。请启动路由器。';

      elements.smartGuidanceActions.replaceChildren();
      const startButton = document.createElement('button');
      startButton.type = 'button';
      startButton.textContent = '启动路由器';
      startButton.className = 'button button--primary button--small';
      startButton.addEventListener('click', () => {
        void dependencies.router.runOperation(
          (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
          '正在启动…',
          startButton,
        );
      });
      elements.smartGuidanceActions.append(startButton);
      return;
    }

    // No guidance needed
    elements.smartGuidance.hidden = true;
  };

  return { updateSmartGuidance };
};
