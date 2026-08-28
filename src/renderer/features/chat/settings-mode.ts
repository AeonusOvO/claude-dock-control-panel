import {
  CHAT_PROVIDERS,
  findChatProvider,
  providerApiAddress,
} from '../../../shared/claude/chat-providers';
import type { ChatElements } from './elements';
import { sameConnectionCredentialScope } from '../../../shared/router/automatic-connection';

export const selectedChatPreset = (elements: ChatElements): string => {
  const provider = findChatProvider(elements.chatProvider.value);
  return provider &&
    !provider.editableBaseUrl &&
    !sameConnectionCredentialScope(elements.chatBaseUrl.value, providerApiAddress(provider))
    ? 'custom'
    : elements.chatProvider.value;
};

export const initializeChatProviders = (elements: ChatElements): void => {
  if (elements.chatProvider.options.length) return;
  elements.chatProvider.replaceChildren(
    ...[...CHAT_PROVIDERS]
      .sort((left, right) => (left.id === 'custom' ? -1 : right.id === 'custom' ? 1 : 0))
      .map((provider) => {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.id === 'custom' ? '自定义接口' : provider.label;
        return option;
      }),
  );
};

export const renderChatSettingsMode = (elements: ChatElements): void => {
  const advanced = elements.chatConfigForm.dataset.settingsMode === 'advanced';
  const provider = findChatProvider(elements.chatProvider.value);
  elements.chatSettingsModeButton.textContent = advanced ? '极简设置' : '高级设置';
  elements.chatSettingsModeButton.setAttribute('aria-expanded', String(advanced));
  elements.chatBaseUrlField.hidden = !advanced && Boolean(provider && !provider.editableBaseUrl);
  elements.chatBaseUrl.required = !elements.chatBaseUrlField.hidden;
  elements.chatModel.required = advanced;
  elements.saveChatConfigButton.textContent = advanced ? '保存独立接入' : '连接并保存';
  const withoutCredential = advanced && elements.chatAuthMode.value === 'none';
  const pending = elements.chatConfigForm.getAttribute('aria-busy') === 'true';
  elements.chatCredential.disabled = pending || withoutCredential;
  elements.chatClearCredential.disabled = pending || withoutCredential;
};

export const applyChatProvider = (elements: ChatElements): void => {
  const provider = findChatProvider(elements.chatProvider.value);
  if (!provider) return;
  elements.chatBaseUrl.value = provider.id === 'custom' ? '' : providerApiAddress(provider);
  elements.chatModel.value =
    provider.id === 'custom' ? '' : provider.model.replace(/\[(?:1m|2m)\]$/i, '');
  elements.chatProtocol.value = provider.protocol ?? 'anthropic';
  elements.chatAuthMode.value = provider.authMode === 'apiKey' ? 'apiKey' : 'bearer';
  elements.chatCredential.value = '';
  elements.chatClearCredential.checked = false;
  elements.chatCredentialStatus.textContent = '';
  renderChatSettingsMode(elements);
};
