import { requiredElement } from '../../platform/dom';
import { CLAUDE_PROVIDERS } from '../../../shared/claude/providers';

export const authModeHelp = requiredElement<HTMLElement>('#auth-mode-help');
export const authModeLabel = requiredElement<HTMLElement>('#auth-mode-label');
export const authModeField = requiredElement<HTMLElement>('#auth-mode-field');
export const claudeAuthMode = requiredElement<HTMLSelectElement>('#claude-auth-mode');
export const claudeApiKeyHelperPolicy = requiredElement<HTMLSelectElement>(
  '#claude-api-key-helper-policy',
);
export const claudeApiKeyHelperStatus = requiredElement<HTMLElement>(
  '#claude-api-key-helper-status',
);
export const claudeBaseUrl = requiredElement<HTMLInputElement>('#claude-base-url');
export const claudeConfigForm = requiredElement<HTMLFormElement>('#claude-config-form');
export const connectionSettingsModeButton = requiredElement<HTMLButtonElement>(
  '#connection-settings-mode',
);
export const claudeConfigStepTitle = requiredElement<HTMLElement>('#claude-config-step-title');
export const claudeConfigStepDescription = requiredElement<HTMLElement>(
  '#claude-config-step-description',
);
export const claudeCredential = requiredElement<HTMLInputElement>('#claude-credential');
export const claudeModel = requiredElement<HTMLInputElement>('#claude-model');
export const claudeModelFast = requiredElement<HTMLInputElement>('#claude-model-fast');
export const claudePreset = requiredElement<HTMLSelectElement>('#claude-preset');
export const claudeProtocol = requiredElement<HTMLSelectElement>('#claude-protocol');
export const baseUrlField = requiredElement<HTMLElement>('#base-url-field');
export const protocolField = requiredElement<HTMLElement>('#protocol-field');
export const protocolHelp = requiredElement<HTMLElement>('#protocol-help');
export const baseUrlHelp = requiredElement<HTMLElement>('#base-url-help');
export const clearCredentialButton = requiredElement<HTMLButtonElement>('#clear-credential');
export const connectionRemedyActions = requiredElement<HTMLElement>('#connection-remedy-actions');
export const credentialField = requiredElement<HTMLElement>('#credential-field');
export const credentialSourceSettings = requiredElement<HTMLElement>('#credential-source-settings');
export const credentialLabel = requiredElement<HTMLElement>('#credential-label');
export const credentialStatus = requiredElement<HTMLElement>('#credential-status');
export const gatewayDiscoverySection = requiredElement<HTMLElement>('#gateway-discovery');
export const modelHelp = requiredElement<HTMLElement>('#model-help');
export const environmentSetup = requiredElement<HTMLElement>('#environment-setup');
export const providerGroups = requiredElement<HTMLElement>('#connection-provider-groups');
export const providerPicker = requiredElement<HTMLElement>('#connection-provider-picker');
export const providerSetup = requiredElement<HTMLElement>('#connection-provider-setup');
export const providerTitle = requiredElement<HTMLElement>('#connection-provider-title');
export const providerDescription = requiredElement<HTMLElement>('#connection-provider-description');
export const providerCaveat = requiredElement<HTMLElement>('#connection-provider-caveat');
export const providerSpecialSetup = requiredElement<HTMLElement>('#connection-provider-special');
export const openProviderConsoleButton =
  requiredElement<HTMLButtonElement>('#open-provider-console');
export const openProviderDocsButton = requiredElement<HTMLButtonElement>('#open-provider-docs');
export const connectionAdvancedContent = requiredElement<HTMLElement>(
  '#connection-advanced-content',
);
export const curlOnboarding = requiredElement<HTMLElement>('#curl-onboarding');
export const converterHelp = requiredElement<HTMLElement>('#converter-help');
export const connectionGlossary = requiredElement<HTMLElement>('.connection-glossary');
export const saveClaudeConfigButton = requiredElement<HTMLButtonElement>('#save-claude-config');
export const connectionAdvice = requiredElement<HTMLElement>('#connection-advice');
export const connectionWizardViewport = requiredElement<HTMLElement>('#connection-wizard-viewport');
export const connectionWizardChoiceStep = requiredElement<HTMLElement>(
  '[data-connection-wizard-step="choice"]',
);
export const connectionWizardConfigureStep = requiredElement<HTMLElement>(
  '[data-connection-wizard-step="configure"]',
);
export const connectionWizardChoiceProgress = requiredElement<HTMLButtonElement>(
  '#connection-wizard-progress-choice',
);
export const connectionWizardConfigureProgress = requiredElement<HTMLButtonElement>(
  '#connection-wizard-progress-configure',
);
export const connectionWizardPreviousButton = requiredElement<HTMLButtonElement>(
  '#connection-wizard-previous',
);
export const connectionWizardNextButton =
  requiredElement<HTMLButtonElement>('#connection-wizard-next');
export const connectionWizardStatus = requiredElement<HTMLElement>('#connection-wizard-status');

connectionWizardConfigureStep.prepend(environmentSetup);

connectionAdvancedContent.append(
  credentialSourceSettings,
  connectionAdvice,
  gatewayDiscoverySection,
  curlOnboarding,
  converterHelp,
  connectionGlossary,
);
claudePreset.replaceChildren(
  ...CLAUDE_PROVIDERS.map((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    return option;
  }),
);
