import type { ChatConnectionTestResult, SaveChatConfigInput } from '../../shared/contracts';
import {
  assertChatApiAccess,
  findChatProvider,
  providerApiAddress,
} from '../../shared/claude/chat-providers';
import { sameConnectionCredentialScope } from '../../shared/router/automatic-connection';
import {
  allowedProtocolsForProvider,
  assertChatProviderAccess,
} from '../network/provider-access-policy';
import { detectAutomaticConnection } from '../network/automatic-connection';
import type { ChatConfigStore } from './config-store';

export const resolveAutomaticChatConnection = async (
  input: SaveChatConfigInput,
  store: ChatConfigStore,
  fetchImplementation: typeof fetch,
): Promise<{ input: SaveChatConfigInput; test: ChatConnectionTestResult }> => {
  if (
    input.autoDetect !== true ||
    typeof input.baseUrl !== 'string' ||
    !['keep', 'replace', 'clear'].includes(input.credentialAction) ||
    (input.credential !== undefined && typeof input.credential !== 'string')
  ) {
    throw new Error('接入配置格式无效。');
  }
  const provider = findChatProvider(input.preset ?? 'custom');
  if (!provider) throw new Error('请选择可用于独立对话的 API 服务。');
  const address = provider.editableBaseUrl ? input.baseUrl : providerApiAddress(provider);
  const saved = store.getView();
  const sameIdentity = sameConnectionCredentialScope(address, saved.baseUrl);
  const credential = store.resolveCredential({ ...input, authMode: 'bearer' }, address);
  const preferredProtocol =
    assertChatProviderAccess({
      address,
      credential,
      preset: provider.id,
      protocol: input.protocol ?? provider.protocol,
    }) ??
    provider.protocol ??
    'anthropic';
  assertChatApiAccess(address, credential);
  const result = await detectAutomaticConnection(
    {
      address,
      credential,
      modelHints: [
        ...(sameIdentity ? [saved.model] : []),
        ...(provider.editableBaseUrl ? [] : [provider.model, provider.modelFast ?? '']),
      ],
      allowedProtocols: allowedProtocolsForProvider(provider.id),
      modelsAddress: provider.modelsUrl,
      openAiApiKey: true,
      preferredAuth: provider.authMode === 'apiKey' ? 'apiKey' : 'bearer',
      preferredProtocol,
    },
    fetchImplementation,
  );
  return {
    input: {
      authMode: result.authMode,
      baseUrl: result.endpoint,
      credential,
      credentialAction: credential ? 'replace' : 'clear',
      model: result.model,
      preset: provider.id,
      protocol: result.protocol,
    },
    test: { detail: '连接成功。', latencyMs: result.latencyMs, ok: true },
  };
};
