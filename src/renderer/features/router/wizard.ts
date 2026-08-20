import type {
  ClaudeConnectionTestResult,
  ClaudeProjectState,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
import { findClaudeProvider, providerForPreset } from '../../../shared/claude/providers';
import { ROUTER_CAPABILITIES } from '../../../shared/router/capabilities';
import type { RouterElements } from './elements';
import type { RouterState } from './state';

export interface RouterWizardActions {
  bindRouterWizard: () => void;
  setRouterWizardModels: (models: readonly string[], preferred?: string) => void;
  syncRouterWizard: () => void;
  verifySavedRouterConfiguration: (
    sessionId: string,
    projectState: ClaudeProjectState | undefined,
  ) => Promise<ClaudeConnectionTestResult | undefined>;
  wizardDirectInput: () => SaveClaudeConfigInput;
}

export const createRouterWizardActions = (
  elements: RouterElements,
  state: RouterState,
  runRouterWizard: () => Promise<void>,
): RouterWizardActions => {
  const setRouterWizardModels = (models: readonly string[], preferred?: string): void => {
    const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    const selected = preferred && unique.includes(preferred) ? preferred : unique[0];
    elements.routerWizardModel.replaceChildren(
      ...unique.map((model) => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        return option;
      }),
    );
    if (selected) {
      elements.routerWizardModel.value = selected;
    }
  };

  const syncRouterWizard = (): void => {
    const provider = findClaudeProvider(elements.routerWizardProvider.value);
    if (!provider) {
      return;
    }
    const capability = ROUTER_CAPABILITIES[provider.id];
    const needsCredential = provider.authMode === 'apiKey' || provider.authMode === 'authToken';
    elements.routerWizardBaseUrlField.hidden = !provider.editableBaseUrl;
    elements.routerWizardBaseUrl.required = provider.editableBaseUrl;
    if (!provider.editableBaseUrl || !elements.routerWizardBaseUrl.value.trim()) {
      elements.routerWizardBaseUrl.value = provider.editableBaseUrl ? '' : provider.baseUrl;
    }
    elements.routerWizardCredentialField.hidden = !needsCredential;
    elements.routerWizardCredential.required = needsCredential && provider.id !== 'ollama';
    elements.routerWizardCredential.placeholder =
      provider.keyHint ?? '仅在提交时交给主进程安全保存';
    const previousProvider = elements.routerWizardModel.dataset.providerId;
    const existingModels = state.routerManagementState?.providers.find(
      (item) => item.name === `wizard-${provider.id}`,
    )?.models;
    setRouterWizardModels(
      [
        ...(existingModels ?? []),
        provider.model,
        ...(provider.modelFast ? [provider.modelFast] : []),
      ],
      previousProvider === provider.id ? elements.routerWizardModel.value : provider.model,
    );
    elements.routerWizardModel.dataset.providerId = provider.id;
    if (capability.mode === 'direct') {
      elements.routerWizardUseRoute.checked = false;
    } else if (capability.mode === 'router-required') {
      elements.routerWizardUseRoute.checked = true;
    } else {
      elements.routerWizardUseRoute.checked = false;
    }
    elements.routerWizardUseRoute.disabled = true;
    const routed = elements.routerWizardUseRoute.checked;
    elements.routerWizardDecision.dataset.mode = routed ? 'router' : 'direct';
    elements.routerWizardDecision.textContent = `${routed ? '将使用 CCR 完成协议转换' : '将直接写入 Claude Code CLI 配置'}：${capability.reason}`;
  };

  const wizardDirectInput = (): SaveClaudeConfigInput => {
    const provider = findClaudeProvider(elements.routerWizardProvider.value);
    if (!provider) {
      throw new Error('请选择有效的服务提供方。');
    }
    const credential =
      provider.id === 'ollama'
        ? elements.routerWizardCredential.value.trim() || 'ollama'
        : elements.routerWizardCredential.value.trim();
    const needsCredential = provider.authMode === 'apiKey' || provider.authMode === 'authToken';
    return {
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: provider.authMode,
      baseUrl: provider.editableBaseUrl
        ? elements.routerWizardBaseUrl.value.trim()
        : provider.baseUrl,
      credential: needsCredential ? credential : undefined,
      credentialAction: needsCredential ? 'replace' : 'clear',
      model: elements.routerWizardModel.value.trim() || provider.model,
      modelFast: provider.modelFast,
      preset: provider.id,
      protocol: 'anthropic',
      provider: providerForPreset(provider.id),
    };
  };

  const verifySavedRouterConfiguration = async (
    sessionId: string,
    projectState: ClaudeProjectState | undefined,
  ): Promise<ClaudeConnectionTestResult | undefined> => {
    const config = projectState?.config;
    if (!config) {
      return undefined;
    }
    return window.controlPanel.testClaudeConnection(sessionId, {
      apiKeyHelperPolicy: config.apiKeyHelperPolicy,
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      credentialAction: 'keep',
      model: config.model,
      modelFast: config.modelFast,
      preset: config.preset,
      protocol: config.protocol === 'unknown' ? 'anthropic' : config.protocol,
      provider: config.provider,
      routerProviderId: config.routerProviderId,
    });
  };

  const bindRouterWizard = (): void => {
    elements.routerWizardProvider.addEventListener('change', () => {
      elements.routerWizardBaseUrl.value = '';
      elements.routerWizardModel.value = '';
      syncRouterWizard();
    });
    elements.routerWizardForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void runRouterWizard();
    });
    syncRouterWizard();
  };

  return {
    bindRouterWizard,
    setRouterWizardModels,
    syncRouterWizard,
    verifySavedRouterConfiguration,
    wizardDirectInput,
  };
};
