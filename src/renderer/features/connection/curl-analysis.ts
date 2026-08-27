import { parseClaudeCurl, type ClaudeCurlAnalysis } from '../../../shared/claude/curl';
import type { ClaudeGatewayCandidate } from '../../../shared/contracts';
import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';

export interface CurlAnalysisActions {
  analyzeCurlInput: () => void;
  applyDirectCurlAnalysis: () => void;
  importCurlIntoRouter: () => Promise<void>;
}

export const createCurlAnalysisActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  preferredRouter: () => ClaudeGatewayCandidate | undefined,
  updateSmartGuidance: () => void,
): CurlAnalysisActions => {
  const uniqueCurlProviderName = (analysis: ClaudeCurlAnalysis): string => {
    const base =
      new URL(analysis.endpoint).hostname
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'openai-relay';
    const names = new Set(
      (dependencies.router.getManagementState()?.providers ?? []).map((provider) => provider.name),
    );
    if (!names.has(base)) {
      return base;
    }
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base.slice(0, 55)}-${index}`;
      if (!names.has(candidate)) {
        return candidate;
      }
    }
    return `${base.slice(0, 45)}-${Date.now()}`;
  };

  const importCurlIntoRouter = async (): Promise<void> => {
    const analysis = state.lastCurlAnalysis;
    const status = dependencies.activeStatus();
    if (
      !analysis ||
      analysis.protocol !== 'openai' ||
      !analysis.model ||
      !analysis.credential ||
      !status ||
      dependencies.router.isOperationInProgress()
    ) {
      dependencies.showToast('cURL 需要同时包含 OpenAI 接口、模型和新密钥。', 'error');
      return;
    }

    if (!dependencies.router.getManagementState()?.managementAvailable) {
      const startResult = await window.controlPanel.startClaudeRouter(status.id);
      dependencies.router.renderRouterManagement(startResult.routerState);
      if (!startResult.routerState.managementAvailable) {
        dependencies.showToast(startResult.message, 'error');
        return;
      }
    }
    const existing = dependencies.router
      .getManagementState()
      ?.providers.find(
        (provider) =>
          provider.baseUrl.replace(/\/+$/, '') === analysis.endpoint.replace(/\/+$/, ''),
      );
    const imported = await dependencies.router.runRouterProviderSave({
      apiKey: analysis.credential,
      baseUrl: analysis.endpoint,
      credentialAction: 'replace',
      id: existing?.id,
      makePreferred: true,
      models: [analysis.model],
      name: existing?.name ?? uniqueCurlProviderName(analysis),
      protocol: 'openai_chat_completions',
      useForCurrentProject: true,
    });
    if (imported) {
      elements.curlInput.value = '';
      state.lastCurlAnalysis = undefined;
      elements.curlAnalysis.hidden = true;
      dependencies.importCurlRouterButton.hidden = true;
    }
  };

  const analyzeCurlInput = (): void => {
    try {
      const analysis = parseClaudeCurl(elements.curlInput.value);
      state.lastCurlAnalysis = analysis;
      elements.curlAnalysis.hidden = false;
      elements.curlAnalysis.dataset.protocol = analysis.protocol;
      elements.curlProtocolBadge.textContent =
        analysis.protocol === 'anthropic'
          ? 'Anthropic 格式'
          : analysis.protocol === 'openai'
            ? 'OpenAI 格式'
            : '协议待确认';
      elements.curlAnalysisTitle.textContent =
        analysis.protocol === 'anthropic'
          ? '可以直接接入 Claude Code'
          : analysis.protocol === 'openai'
            ? '不能直接接入，需要转换器'
            : '请向服务商确认 /v1/messages';
      elements.curlAnalysisDetail.textContent = analysis.explanation;
      elements.curlAnalysisEndpoint.textContent = analysis.endpoint;
      elements.curlAnalysisModel.textContent = analysis.model || '没有识别到模型名';
      elements.curlAnalysisAuth.textContent =
        analysis.authMode === 'authToken'
          ? `持有者令牌（Authorization / Bearer）${analysis.credentialDetected ? ' · 已识别密钥但不显示' : ''}`
          : analysis.authMode === 'apiKey'
            ? `接口密钥（x-api-key）${analysis.credentialDetected ? ' · 已识别密钥但不显示' : ''}`
            : '没有识别到认证头';
      elements.curlNextStep.replaceChildren();

      const router = preferredRouter();
      elements.applyCurlDirectButton.hidden = analysis.protocol !== 'anthropic';
      dependencies.importCurlRouterButton.hidden =
        analysis.protocol !== 'openai' ||
        !analysis.model ||
        !analysis.credentialDetected ||
        !dependencies.router.getManagementState()?.installed ||
        !dependencies.router.getManagementState()?.manageable;
      elements.useDetectedRouterButton.hidden = analysis.protocol !== 'openai' || !router;
      elements.openDetectedRouterButton.hidden =
        analysis.protocol !== 'openai' || !router?.managementUrl;

      const nextTitle = document.createElement('strong');
      const nextDetail = document.createElement('span');
      if (analysis.protocol === 'anthropic') {
        nextTitle.textContent = '下一步：自动填入并执行真实测试';
        nextDetail.textContent = '确认测试通过后再保存；保存时密钥才会进入 Windows 安全存储。';
      } else if (analysis.protocol === 'openai') {
        nextTitle.textContent = router
          ? '下一步：先在路由器管理页添加这个上游'
          : '下一步：先安装并启动本地转换器';
        nextDetail.textContent = router
          ? `服务提供方选择 OpenAI 兼容协议，接口填 ${analysis.endpoint}，模型填 ${
              analysis.model || '服务商提供的模型名'
            }；上游密钥只填在路由器中。然后回到这里选用 3456。`
          : '推荐从下方打开 Claude Code 路由器图形版安装页。配置完成后，重新检测会自动发现 3456。';
      } else {
        nextTitle.textContent = '下一步：向服务商确认协议';
        nextDetail.textContent =
          '需要明确询问："是否提供 Anthropic 消息协议的 /v1/messages 接口？"';
      }
      elements.curlNextStep.append(nextTitle, nextDetail);
      updateSmartGuidance();
    } catch (error) {
      state.lastCurlAnalysis = undefined;
      elements.curlAnalysis.hidden = true;
      dependencies.importCurlRouterButton.hidden = true;
      dependencies.showToast(
        error instanceof Error ? error.message : '无法识别这段 cURL。',
        'error',
      );
    }
  };

  const applyDirectCurlAnalysis = (): void => {
    const analysis = state.lastCurlAnalysis;
    if (!analysis || analysis.protocol !== 'anthropic') {
      return;
    }
    dependencies.claudePreset.value = 'custom';
    dependencies.applyPresetUi('custom', false);
    dependencies.claudeBaseUrl.value = analysis.baseUrl;
    dependencies.claudeModel.value = analysis.model;
    dependencies.claudeModelFast.value = analysis.model;
    dependencies.claudeAuthMode.value = analysis.authMode;
    dependencies.claudeCredential.value = analysis.credential ?? '';
    dependencies.credentialField.hidden = analysis.authMode === 'none';
    elements.connectionTestResult.hidden = true;
    dependencies.claudeConfigForm.scrollIntoView({
      behavior: userScrollBehavior(),
      block: 'start',
    });
    dependencies.showToast('已填入直连接口；请先进行真实连接测试');
    updateSmartGuidance();
  };

  return {
    analyzeCurlInput,
    applyDirectCurlAnalysis,
    importCurlIntoRouter,
  };
};
import { userScrollBehavior } from '../../platform/motion';
