import type { SaveChatConfigInput } from '../../../shared/contracts';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatSettingsBindings {
  bindChatSettings: () => () => void;
}

export const createChatSettingsBindings = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  view: ChatView,
  chatConfigInput: () => SaveChatConfigInput,
  loadChatConfig: (force?: boolean) => Promise<void>,
): ChatSettingsBindings => {
  const bindChatSettings = (): (() => void) => {
    const disposers: Array<() => void> = [];

    const handleConfigSubmit = (event: SubmitEvent): void => {
      event.preventDefault();
      void dependencies.runGuarded(elements.saveChatConfigButton, '正在保存…', async () => {
        try {
          const config = await window.controlPanel.saveChatConfig(chatConfigInput());
          view.renderChatConfig(config);
          elements.chatConfigStatus.textContent = '独立接入已保存并可用于新消息。';
          dependencies.showToast('独立对话接入已保存');
          elements.chatSettingsDialog.close('saved');
        } catch (error) {
          const message = error instanceof Error ? error.message : '无法保存独立对话接入。';
          elements.chatConfigStatus.textContent = message;
          dependencies.showToast(message, 'error');
        }
      });
    };
    elements.chatConfigForm.addEventListener('submit', handleConfigSubmit);
    disposers.push(() => elements.chatConfigForm.removeEventListener('submit', handleConfigSubmit));

    const handleOpenSettings = (): void => {
      if (elements.chatSettingsDialog.open) {
        return;
      }
      // Re-read from the main process so the dialog never shows a stale draft from a previous open.
      void loadChatConfig(true);
      elements.chatSettingsDialog.showModal();
      elements.chatModel.focus();
    };
    elements.openChatSettingsButton.addEventListener('click', handleOpenSettings);
    disposers.push(() =>
      elements.openChatSettingsButton.removeEventListener('click', handleOpenSettings),
    );

    const handleCloseSettings = (): void => {
      elements.chatSettingsDialog.close('cancel');
    };
    elements.closeChatSettingsButton.addEventListener('click', handleCloseSettings);
    disposers.push(() =>
      elements.closeChatSettingsButton.removeEventListener('click', handleCloseSettings),
    );

    const handleSettingsClose = (): void => {
      elements.chatCredential.value = '';
      elements.chatClearCredential.checked = false;
    };
    elements.chatSettingsDialog.addEventListener('close', handleSettingsClose);
    disposers.push(() =>
      elements.chatSettingsDialog.removeEventListener('close', handleSettingsClose),
    );

    const handleTestConnection = (): void => {
      elements.chatConnectionTest.dataset.tone = 'pending';
      elements.chatConnectionTest.textContent = '正在发送最小请求，验证接口、认证和模型…';
      void dependencies.runGuarded(elements.testChatConnectionButton, '正在测试…', async () => {
        try {
          const result = await window.controlPanel.testChatConnection(chatConfigInput());
          elements.chatConnectionTest.dataset.tone = result.ok ? 'success' : 'error';
          elements.chatConnectionTest.textContent = `${result.detail} · ${result.latencyMs} ms${
            result.usage
              ? ` · ${dependencies.formatTokenCount(result.usage.totalTokens)} tokens`
              : ''
          }`;
          dependencies.showToast(
            result.ok ? '独立对话连接测试通过' : result.detail,
            result.ok ? 'success' : 'error',
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : '连接测试失败。';
          elements.chatConnectionTest.dataset.tone = 'error';
          elements.chatConnectionTest.textContent = message;
          dependencies.showToast(message, 'error');
        }
      });
    };
    elements.testChatConnectionButton.addEventListener('click', handleTestConnection);
    disposers.push(() =>
      elements.testChatConnectionButton.removeEventListener('click', handleTestConnection),
    );

    const handleConfigInput = (event: Event): void => {
      if (
        event.target === elements.testChatConnectionButton ||
        event.target === elements.saveChatConfigButton
      ) {
        return;
      }
      elements.chatConnectionTest.dataset.tone = 'idle';
      elements.chatConnectionTest.textContent = '配置已变化，请重新测试连接。';
    };
    elements.chatConfigForm.addEventListener('input', handleConfigInput);
    disposers.push(() => elements.chatConfigForm.removeEventListener('input', handleConfigInput));

    const handleAuthModeChange = (): void => {
      const disabled = elements.chatAuthMode.value === 'none';
      elements.chatCredential.disabled = disabled;
      elements.chatClearCredential.disabled = disabled;
      elements.chatCredentialStatus.textContent = disabled
        ? '当前接口不使用认证凭据。'
        : state.chatConfig?.credentialConfigured
          ? '已通过 Windows 安全存储保存凭据；留空可继续使用。'
          : '尚未保存凭据。';
    };
    elements.chatAuthMode.addEventListener('change', handleAuthModeChange);
    disposers.push(() => elements.chatAuthMode.removeEventListener('change', handleAuthModeChange));

    const handleProtocolChange = (): void => {
      elements.chatBaseUrl.placeholder =
        elements.chatProtocol.value === 'openai'
          ? 'https://api.openai.com'
          : 'https://api.anthropic.com';
    };
    elements.chatProtocol.addEventListener('change', handleProtocolChange);
    disposers.push(() => elements.chatProtocol.removeEventListener('change', handleProtocolChange));

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  };

  return {
    bindChatSettings,
  };
};
