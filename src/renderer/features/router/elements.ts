import { CLAUDE_PROVIDERS } from '../../../shared/claude/providers';
import { ROUTER_CAPABILITIES } from '../../../shared/router/capabilities';
import { requiredElement } from '../../platform/dom';

export interface RouterElements {
  addRouterProviderButton: HTMLButtonElement;
  cancelRouterProviderButton: HTMLButtonElement;
  ccSwitchResiduals: HTMLOListElement;
  configureRouterProviderButton: HTMLButtonElement;
  exportCcSwitchButton: HTMLButtonElement;
  installCcSwitchButton: HTMLButtonElement;
  openRouterManagementButton: HTMLButtonElement;
  repairRouterFromProjectButton: HTMLButtonElement;
  routerCapabilityList: HTMLElement;
  routerKernelStatus: HTMLElement;
  routerOperationDetail: HTMLElement;
  routerOperationMeter: HTMLProgressElement;
  routerOperationProgress: HTMLElement;
  routerOperationStage: HTMLElement;
  routerProviderApiKey: HTMLInputElement;
  routerProviderBaseUrl: HTMLInputElement;
  routerProviderForm: HTMLFormElement;
  routerProviderFormTitle: HTMLElement;
  routerProviderId: HTMLInputElement;
  routerProviderList: HTMLElement;
  routerProviderModels: HTMLTextAreaElement;
  routerProviderName: HTMLInputElement;
  routerProviderPreferred: HTMLInputElement;
  routerProviderProtocol: HTMLSelectElement;
  routerProviderUseProject: HTMLInputElement;
  routerRemediation: HTMLElement;
  routerRemediationDetail: HTMLElement;
  routerRemediationTitle: HTMLElement;
  routerStatus: HTMLElement;
  routerStatusDetail: HTMLElement;
  routerStatusTitle: HTMLElement;
  routerVersion: HTMLElement;
  routerWizardBaseUrl: HTMLInputElement;
  routerWizardBaseUrlField: HTMLElement;
  routerWizardCredential: HTMLInputElement;
  routerWizardCredentialField: HTMLElement;
  routerWizardDecision: HTMLElement;
  routerWizardForm: HTMLFormElement;
  routerWizardModel: HTMLSelectElement;
  routerWizardProvider: HTMLSelectElement;
  routerWizardSubmit: HTMLButtonElement;
  routerWizardUseRoute: HTMLInputElement;
  saveRouterProviderButton: HTMLButtonElement;
  settingsCcrBackendStatus: HTMLElement;
  settingsChatGptGatewayStatus: HTMLElement;
  settingsOpenCcrBackend: HTMLButtonElement;
  settingsOpenChatGptGateway: HTMLButtonElement;
  stopRouterButton: HTMLButtonElement;
  uninstallCcSwitchButton: HTMLButtonElement;
  uninstallRouterButton: HTMLButtonElement;
}

export const createRouterElements = (): RouterElements => {
  const elements: RouterElements = {
    addRouterProviderButton: requiredElement<HTMLButtonElement>('#add-router-provider'),
    cancelRouterProviderButton: requiredElement<HTMLButtonElement>('#cancel-router-provider'),
    ccSwitchResiduals: requiredElement<HTMLOListElement>('#cc-switch-residuals'),
    configureRouterProviderButton: requiredElement<HTMLButtonElement>('#configure-router-provider'),
    exportCcSwitchButton: requiredElement<HTMLButtonElement>('#export-cc-switch'),
    installCcSwitchButton: requiredElement<HTMLButtonElement>('#install-cc-switch'),
    openRouterManagementButton: requiredElement<HTMLButtonElement>('#open-router-management'),
    repairRouterFromProjectButton: requiredElement<HTMLButtonElement>(
      '#repair-router-from-project',
    ),
    routerCapabilityList: requiredElement<HTMLElement>('#router-capability-list'),
    routerKernelStatus: requiredElement<HTMLElement>('#router-kernel-status'),
    routerOperationDetail: requiredElement<HTMLElement>('#router-operation-detail'),
    routerOperationMeter: requiredElement<HTMLProgressElement>('#router-operation-meter'),
    routerOperationProgress: requiredElement<HTMLElement>('#router-operation-progress'),
    routerOperationStage: requiredElement<HTMLElement>('#router-operation-stage'),
    routerProviderApiKey: requiredElement<HTMLInputElement>('#router-provider-api-key'),
    routerProviderBaseUrl: requiredElement<HTMLInputElement>('#router-provider-base-url'),
    routerProviderForm: requiredElement<HTMLFormElement>('#router-provider-form'),
    routerProviderFormTitle: requiredElement<HTMLElement>('#router-provider-form-title'),
    routerProviderId: requiredElement<HTMLInputElement>('#router-provider-id'),
    routerProviderList: requiredElement<HTMLElement>('#router-provider-list'),
    routerProviderModels: requiredElement<HTMLTextAreaElement>('#router-provider-models'),
    routerProviderName: requiredElement<HTMLInputElement>('#router-provider-name'),
    routerProviderPreferred: requiredElement<HTMLInputElement>('#router-provider-preferred'),
    routerProviderProtocol: requiredElement<HTMLSelectElement>('#router-provider-protocol'),
    routerProviderUseProject: requiredElement<HTMLInputElement>('#router-provider-use-project'),
    routerRemediation: requiredElement<HTMLElement>('#router-remediation'),
    routerRemediationDetail: requiredElement<HTMLElement>('#router-remediation-detail'),
    routerRemediationTitle: requiredElement<HTMLElement>('#router-remediation-title'),
    routerStatus: requiredElement<HTMLElement>('#router-status'),
    routerStatusDetail: requiredElement<HTMLElement>('#router-status-detail'),
    routerStatusTitle: requiredElement<HTMLElement>('#router-status-title'),
    routerVersion: requiredElement<HTMLElement>('#router-version'),
    routerWizardBaseUrl: requiredElement<HTMLInputElement>('#router-wizard-base-url'),
    routerWizardBaseUrlField: requiredElement<HTMLElement>('#router-wizard-base-url-field'),
    routerWizardCredential: requiredElement<HTMLInputElement>('#router-wizard-credential'),
    routerWizardCredentialField: requiredElement<HTMLElement>('#router-wizard-credential-field'),
    routerWizardDecision: requiredElement<HTMLElement>('#router-wizard-decision'),
    routerWizardForm: requiredElement<HTMLFormElement>('#router-wizard-form'),
    routerWizardModel: requiredElement<HTMLSelectElement>('#router-wizard-model'),
    routerWizardProvider: requiredElement<HTMLSelectElement>('#router-wizard-provider'),
    routerWizardSubmit: requiredElement<HTMLButtonElement>('#router-wizard-submit'),
    routerWizardUseRoute: requiredElement<HTMLInputElement>('#router-wizard-use-route'),
    saveRouterProviderButton: requiredElement<HTMLButtonElement>('#save-router-provider'),
    settingsCcrBackendStatus: requiredElement<HTMLElement>('#settings-ccr-backend-status'),
    settingsChatGptGatewayStatus: requiredElement<HTMLElement>('#settings-chatgpt-gateway-status'),
    settingsOpenCcrBackend: requiredElement<HTMLButtonElement>('#settings-open-ccr-backend'),
    settingsOpenChatGptGateway: requiredElement<HTMLButtonElement>(
      '#settings-open-chatgpt-gateway',
    ),
    stopRouterButton: requiredElement<HTMLButtonElement>('#stop-router'),
    uninstallCcSwitchButton: requiredElement<HTMLButtonElement>('#uninstall-cc-switch'),
    uninstallRouterButton: requiredElement<HTMLButtonElement>('#uninstall-router'),
  };
  elements.routerCapabilityList.replaceChildren(
    ...CLAUDE_PROVIDERS.map((provider) => {
      const capability = ROUTER_CAPABILITIES[provider.id];
      const card = document.createElement('article');
      card.className = 'router-capability-card';
      card.dataset.mode = capability.mode;
      const heading = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = provider.label;
      const badge = document.createElement('span');
      badge.textContent =
        provider.id === 'chatgpt-subscription' || isSubscriptionProvider(provider.id)
          ? '本机网关'
          : capability.mode === 'direct'
            ? '直连'
            : capability.mode === 'router-required'
              ? '必须路由'
              : '路由可选';
      heading.append(title, badge);
      const detail = document.createElement('p');
      detail.textContent = capability.reason;
      const verified = document.createElement('small');
      verified.textContent = `复核：${capability.verifiedAt}`;
      card.append(heading, detail, verified);
      return card;
    }),
  );
  elements.routerWizardProvider.replaceChildren(
    ...CLAUDE_PROVIDERS.filter(
      (provider) =>
        provider.id !== 'curl' && provider.id !== 'gateway' && !isSubscriptionProvider(provider.id),
    ).map((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      return option;
    }),
  );
  return elements;
};
import { isSubscriptionProvider } from '../../../shared/claude/subscriptions';
