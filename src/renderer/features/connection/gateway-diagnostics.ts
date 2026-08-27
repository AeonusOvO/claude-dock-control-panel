import type {
  ClaudeGatewayCandidate,
  ClaudeGatewayDiagnostics,
  ClaudePreset,
} from '../../../shared/contracts';
import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';

export interface GatewayDiagnosticsActions {
  applyGatewayCandidate: (candidate: ClaudeGatewayCandidate) => void;
  loadGatewayDiagnostics: () => Promise<void>;
  preferredRouter: () => ClaudeGatewayCandidate | undefined;
}

export const createGatewayDiagnosticsActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
): GatewayDiagnosticsActions => {
  const applyGatewayCandidate = (candidate: ClaudeGatewayCandidate): void => {
    const preset: ClaudePreset = 'gateway';
    dependencies.claudePreset.value = preset;
    dependencies.applyPresetUi(preset, false);
    dependencies.claudeBaseUrl.value = candidate.apiBaseUrl;
    dependencies.claudeModel.value =
      state.lastCurlAnalysis?.model ||
      (dependencies.claudeModel.value === 'default' ? '' : dependencies.claudeModel.value);
    dependencies.claudeModelFast.value = dependencies.claudeModel.value;
    dependencies.claudeAuthMode.value = candidate.authRequired ? 'authToken' : 'none';
    dependencies.claudeCredential.value = '';
    dependencies.credentialField.hidden = dependencies.claudeAuthMode.value === 'none';
    elements.connectionTestResult.hidden = true;
    dependencies.showToast(
      candidate.authRequired
        ? `已选用 ${candidate.label}；请填写路由器自己的访问密钥`
        : `已选用 ${candidate.label}；下一步执行真实连接测试`,
    );
    dependencies.claudeConfigForm.scrollIntoView({
      behavior: userScrollBehavior(),
      block: 'start',
    });
  };

  const renderGatewayDiagnostics = (diagnostics: ClaudeGatewayDiagnostics): void => {
    state.gatewayDiagnostics = diagnostics;
    elements.gatewayDiagnosticsSummary.textContent = diagnostics.message;
    elements.gatewayCheckedAt.textContent = `上次检测 ${new Date(
      diagnostics.checkedAt,
    ).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    elements.gatewayCandidates.replaceChildren();

    if (diagnostics.candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'gateway-empty';
      empty.textContent = '没有发现 CCR、CLIProxyAPI、LiteLLM 或当前项目保存的本机服务。';
      elements.gatewayCandidates.append(empty);
    }

    for (const candidate of diagnostics.candidates) {
      const card = document.createElement('article');
      card.className = 'gateway-candidate';
      card.dataset.status = candidate.status;

      const headline = document.createElement('div');
      headline.className = 'gateway-candidate__headline';
      const title = document.createElement('strong');
      title.textContent = candidate.label;
      const status = document.createElement('span');
      status.textContent =
        candidate.status === 'ready'
          ? '模型接口已运行'
          : candidate.status === 'partial'
            ? '需要处理'
            : '未运行';
      headline.append(title, status);

      const endpoint = document.createElement('code');
      endpoint.textContent = candidate.apiBaseUrl;
      const detail = document.createElement('p');
      detail.textContent = candidate.detail;
      const detected = document.createElement('small');
      detected.textContent = `依据：${candidate.detectedBy.join('、')}`;

      const actions = document.createElement('div');
      actions.className = 'gateway-candidate__actions';
      const useButton = document.createElement('button');
      useButton.type = 'button';
      useButton.textContent = '选用这个接口';
      useButton.disabled = candidate.status === 'offline';
      useButton.addEventListener('click', () => {
        applyGatewayCandidate(candidate);
      });
      actions.append(useButton);
      if (candidate.managementUrl) {
        const manageButton = document.createElement('button');
        manageButton.type = 'button';
        manageButton.textContent = '打开管理页';
        manageButton.addEventListener('click', () => {
          const status = dependencies.activeStatus();
          if (candidate.kind === 'claude-code-router' && status) {
            void dependencies.router.runOperation(
              (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
              '正在打开…',
              manageButton,
            );
          } else {
            void dependencies.openExternal(candidate.managementUrl ?? '');
          }
        });
        actions.append(manageButton);
      }
      if (candidate.kind === 'claude-code-router') {
        // Swapping gateways starts here, where the user actually sees what is installed.
        const purgeButton = document.createElement('button');
        purgeButton.type = 'button';
        purgeButton.textContent = '卸载 CLI 路由';
        purgeButton.addEventListener('click', () => {
          void dependencies.router.uninstallRouterCli(purgeButton);
        });
        actions.append(purgeButton);
      }

      card.append(headline, endpoint, detail, detected, actions);
      elements.gatewayCandidates.append(card);
    }

    elements.configurationHints.replaceChildren();
    elements.configurationHints.hidden = diagnostics.configurationHints.length === 0;
    if (diagnostics.configurationHints.length > 0) {
      const heading = document.createElement('strong');
      heading.textContent = '还发现了外部 Claude 配置（只读）';
      elements.configurationHints.append(heading);
      for (const hint of diagnostics.configurationHints) {
        const item = document.createElement('span');
        item.textContent = [
          `${hint.label}：${hint.baseUrl ?? '未设置基址'}`,
          hint.authConfigured ? '已配置静态凭据' : '未发现静态凭据',
          hint.apiKeyHelperConfigured ? '已配置 apiKeyHelper' : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        elements.configurationHints.append(item);
      }
    }
    dependencies.syncApiKeyHelperPolicyUi();
  };

  const loadGatewayDiagnostics = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.gatewayRefreshInProgress) {
      return;
    }
    state.gatewayRefreshInProgress = true;
    elements.refreshGatewaysButton.disabled = true;
    try {
      renderGatewayDiagnostics(await window.controlPanel.getClaudeGatewayDiagnostics(status.id));
    } catch {
      elements.gatewayDiagnosticsSummary.textContent = '自动检测失败；仍可手动填写接入配置。';
    } finally {
      state.gatewayRefreshInProgress = false;
      elements.refreshGatewaysButton.disabled = false;
    }
  };

  const preferredRouter = (): ClaudeGatewayCandidate | undefined =>
    state.gatewayDiagnostics?.candidates.find(
      (candidate) => candidate.kind === 'claude-code-router' && candidate.status === 'ready',
    );

  return {
    applyGatewayCandidate,
    loadGatewayDiagnostics,
    preferredRouter,
  };
};
import { userScrollBehavior } from '../../platform/motion';
