import type { ClaudeConnectionTestResult, SaveClaudeConfigInput } from '../../shared/contracts';
import { findClaudeProvider, providerForPreset } from '../../shared/claude/providers';
import { providerApiAddress } from '../../shared/claude/chat-providers';
import { sameConnectionCredentialScope } from '../../shared/router/automatic-connection';
import { normalizeConnectionBaseUrl } from '../../shared/router/connection-endpoint';
import {
  allowedProtocolsForProvider,
  assertClaudeProviderAccess,
} from '../network/provider-access-policy';
import { detectAutomaticConnection } from '../network/automatic-connection';
import type { ClaudeConfigStore } from './config-store';

export interface AutomaticClaudeConnection {
  input: SaveClaudeConfigInput;
  test: ClaudeConnectionTestResult;
}

export const resolveAutomaticClaudeConnection = async (
  input: SaveClaudeConfigInput,
  store: ClaudeConfigStore,
  scope: string,
  fetchImplementation: typeof fetch,
): Promise<AutomaticClaudeConnection> => {
  const provider = findClaudeProvider(input.preset);
  if (!provider || ['anthropic', 'chatgpt-subscription', 'curl'].includes(provider.id)) {
    throw new Error('此接入方式请使用专用登录或高级设置。');
  }
  const address = provider.editableBaseUrl ? input.baseUrl : providerApiAddress(provider);
  const saved = store.getView(scope);
  const sameIdentity =
    saved.preset === input.preset &&
    sameConnectionCredentialScope(
      address,
      (saved.sourceBaseUrl ?? saved.baseUrl) || 'https://api.anthropic.com',
    );
  const entered = input.credentialAction !== 'clear' ? input.credential?.trim() : undefined;
  const snapshot =
    sameIdentity && !entered && input.credentialAction === 'keep'
      ? store.createLaunchSnapshot(scope)
      : undefined;
  const credential =
    entered ||
    snapshot?.sourceCredential ||
    snapshot?.credential ||
    (provider.id === 'ollama' ? 'ollama' : undefined);
  if (input.credentialAction === 'replace' && !entered) throw new Error('请填写密钥。');
  const preferredProtocol =
    assertClaudeProviderAccess({
      address,
      credential,
      preset: provider.id,
      protocol: input.protocol ?? provider.protocol,
    }) ??
    provider.protocol ??
    'anthropic';
  const result = await detectAutomaticConnection(
    {
      address,
      credential,
      claudeCompatible: true,
      modelHints: [
        ...(sameIdentity ? [saved.sourceModel ?? saved.model] : []),
        ...(provider.editableBaseUrl ? [] : [provider.model, provider.modelFast ?? '']),
      ],
      modelsAddress: provider.modelsUrl,
      allowedProtocols: allowedProtocolsForProvider(provider.id),
      preferredAuth: provider.authMode === 'apiKey' ? 'apiKey' : 'bearer',
      preferredProtocol,
    },
    fetchImplementation,
  );
  const authMode = result.authMode === 'bearer' ? 'authToken' : result.authMode;
  const protocol = result.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const model =
    [
      sameIdentity ? (saved.sourceModel ?? saved.model) : '',
      provider.model,
      provider.modelFast ?? '',
    ].find((hint) => hint.replace(/\[(?:1m|2m)\]$/i, '') === result.model) ?? result.model;
  return {
    input: {
      ...input,
      autoDetect: undefined,
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode,
      baseUrl:
        protocol === 'anthropic' ? normalizeConnectionBaseUrl(result.endpoint) : result.endpoint,
      credential,
      credentialAction: credential ? 'replace' : 'clear',
      model,
      modelFast: model,
      protocol,
      provider: providerForPreset(provider.id),
      routerProviderId: sameIdentity ? saved.routerProviderId : undefined,
    },
    test: {
      authMode,
      latencyMs: result.latencyMs,
      message: '连接成功。',
      observedProtocol: protocol,
      ok: true,
      stages: [
        { detail: result.endpoint, id: 'endpoint', label: '接口地址', status: 'passed' },
        { detail: authMode, id: 'authentication', label: '身份认证', status: 'passed' },
        { detail: result.model, id: 'model', label: '模型响应', status: 'passed' },
      ],
      testedAt: result.testedAt,
      tone: 'success',
    },
  };
};
