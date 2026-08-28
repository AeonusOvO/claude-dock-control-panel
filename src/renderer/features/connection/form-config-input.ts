import type {
  ClaudePreset,
  ClaudeProjectState,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
import { findClaudeProvider, providerForPreset } from '../../../shared/claude/providers';
import { sameConnectionCredentialScope } from '../../../shared/router/automatic-connection';
import {
  completeConnectionEndpoint,
  normalizeConnectionBaseUrl,
  normalizeConnectionAddress,
  type ConfigurableEndpointProtocol,
} from '../../../shared/router/connection-endpoint';
import {
  claudeApiKeyHelperPolicy,
  claudeAuthMode,
  claudeBaseUrl,
  claudeCredential,
  claudeModel,
  claudeModelFast,
  claudePreset,
  claudeProtocol,
} from './form-elements';
import type { ConnectionFormState } from './form-state';

export const savedClaudeConfigInput = (
  config: ClaudeProjectState['config'],
): SaveClaudeConfigInput => ({
  apiKeyHelperPolicy: config.apiKeyHelperPolicy,
  authMode: config.sourceAuthMode ?? config.authMode,
  baseUrl: config.sourceBaseUrl ?? config.baseUrl,
  credentialAction: 'keep',
  model: config.sourceModel ?? config.model,
  modelFast: config.sourceModelFast ?? config.modelFast,
  preset: config.preset,
  protocol: config.protocol === 'openai' ? 'openai' : 'anthropic',
  provider: config.provider,
  routerProviderId: config.routerProviderId,
});

/**
 * What the connection field should hold once it is tidied up. The OpenAI path targets the local
 * Router, which stores a complete request URL, so the endpoint is completed there. The Anthropic
 * path stays the base URL Claude Code expects: the CLI appends `/v1/messages` itself, and rewriting
 * the field would silently drop path segments some relays require.
 */
export const resolveConnectionAddress = (
  value: string,
  protocol: ConfigurableEndpointProtocol,
): string =>
  protocol === 'openai'
    ? completeConnectionEndpoint(value, 'openai')
    : normalizeConnectionBaseUrl(value);

export interface ConnectionFormConfigInputActions {
  currentConfigInput: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => SaveClaudeConfigInput;
  completeVisibleConnectionEndpoint: (reportError: boolean) => void;
}

export const createConnectionFormConfigInputActions = (
  formState: ConnectionFormState,
): ConnectionFormConfigInputActions => {
  const currentConfigInput = (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ): SaveClaudeConfigInput => {
    let preset = claudePreset.value as ClaudePreset;
    const provider = findClaudeProvider(preset);
    if (
      formState.advancedSettings &&
      provider &&
      !provider.editableBaseUrl &&
      provider.baseUrl &&
      !sameConnectionCredentialScope(claudeBaseUrl.value, provider.baseUrl)
    ) {
      preset = 'custom';
    }
    const autoDetect =
      !formState.advancedSettings &&
      !['anthropic', 'chatgpt-subscription', 'curl'].includes(preset);
    const protocol = claudeProtocol.value as ConfigurableEndpointProtocol;
    const baseUrl =
      preset === 'custom' && claudeBaseUrl.value.trim()
        ? autoDetect
          ? normalizeConnectionAddress(claudeBaseUrl.value)
          : resolveConnectionAddress(claudeBaseUrl.value, protocol)
        : claudeBaseUrl.value;
    if (preset === 'custom') {
      claudeBaseUrl.value = baseUrl;
    }
    return {
      ...(autoDetect ? { autoDetect: true } : {}),
      apiKeyHelperPolicy:
        claudeApiKeyHelperPolicy.value as SaveClaudeConfigInput['apiKeyHelperPolicy'],
      authMode: claudeAuthMode.value as SaveClaudeConfigInput['authMode'],
      baseUrl,
      credential: claudeCredential.value,
      credentialAction,
      model: claudeModel.value,
      modelFast: claudeModelFast.value,
      preset,
      protocol,
      provider: providerForPreset(preset),
      routerProviderId: protocol === 'openai' ? formState.selectedRouterProviderId : undefined,
    };
  };

  const completeVisibleConnectionEndpoint = (reportError: boolean): void => {
    if (claudePreset.value !== 'custom' || !claudeBaseUrl.value.trim()) {
      claudeBaseUrl.setCustomValidity('');
      return;
    }
    try {
      claudeBaseUrl.value = formState.advancedSettings
        ? resolveConnectionAddress(
            claudeBaseUrl.value,
            claudeProtocol.value as ConfigurableEndpointProtocol,
          )
        : normalizeConnectionAddress(claudeBaseUrl.value);
      claudeBaseUrl.setCustomValidity('');
    } catch (error) {
      claudeBaseUrl.setCustomValidity(
        error instanceof Error ? error.message : '无法识别这个接口地址。',
      );
      if (reportError) {
        claudeBaseUrl.reportValidity();
      }
    }
  };

  return {
    currentConfigInput,
    completeVisibleConnectionEndpoint,
  };
};
