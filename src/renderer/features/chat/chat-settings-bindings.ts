import type { SaveChatConfigInput } from '../../../shared/contracts';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';
import {
  applyChatProvider,
  initializeChatProviders,
  renderChatSettingsMode,
  selectedChatPreset,
} from './settings-mode';

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
    initializeChatProviders(elements);
    renderChatSettingsMode(elements);
    let pending = false;
    let dialogGeneration = 0;
    const setPending = (value: boolean): void => {
      pending = value;
      elements.chatConfigForm.setAttribute('aria-busy', String(value));
      for (const control of elements.chatConfigForm.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >('input, select, button')) {
        control.disabled = value;
      }
      if (!value) renderChatSettingsMode(elements);
    };
    const handleModeChange = (): void => {
      if (elements.chatConfigForm.dataset.settingsMode === 'advanced') {
        elements.chatProvider.value = selectedChatPreset(elements);
      }
      elements.chatConfigForm.dataset.settingsMode =
        elements.chatConfigForm.dataset.settingsMode === 'advanced' ? 'simple' : 'advanced';
      renderChatSettingsMode(elements);
      elements.chatConnectionTest.dataset.tone = 'idle';
      elements.chatConnectionTest.textContent = '尚未测试当前配置。';
    };
    const handleProviderChange = (): void => {
      applyChatProvider(elements);
      elements.chatConnectionTest.dataset.tone = 'idle';
      elements.chatConnectionTest.textContent = '尚未测试当前配置。';
    };
    elements.chatSettingsModeButton.addEventListener('click', handleModeChange);
    elements.chatProvider.addEventListener('change', handleProviderChange);
    disposers.push(() =>
      elements.chatSettingsModeButton.removeEventListener('click', handleModeChange),
    );
    disposers.push(() => elements.chatProvider.removeEventListener('change', handleProviderChange));

    const handleConfigSubmit = (event: SubmitEvent): void => {
      event.preventDefault();
      if (pending) return;
      const input = chatConfigInput();
      const generation = dialogGeneration;
      void dependencies.runGuarded(elements.saveChatConfigButton, '正在连接…', async () => {
        setPending(true);
        try {
          const config = await window.controlPanel.saveChatConfig(input);
          if (generation !== dialogGeneration) return;
          view.renderChatConfig(config);
          elements.chatConfigStatus.textContent = input.autoDetect ? '已连接并保存。' : '已保存。';
          dependencies.showToast('独立对话接入已保存');
          elements.chatSettingsDialog.close('saved');
        } catch (error) {
          if (generation !== dialogGeneration) return;
          const message = error instanceof Error ? error.message : '无法保存独立对话接入。';
          elements.chatConfigStatus.textContent = message;
          dependencies.showToast(message, 'error');
        } finally {
          setPending(false);
        }
      });
    };
    elements.chatConfigForm.addEventListener('submit', handleConfigSubmit);
    disposers.push(() => elements.chatConfigForm.removeEventListener('submit', handleConfigSubmit));

    const handleOpenSettings = (): void => {
      if (elements.chatSettingsDialog.open || pending) {
        return;
      }
      dialogGeneration += 1;
      elements.chatConfigForm.dataset.settingsMode = 'simple';
      // Re-read from the main process so the dialog never shows a stale draft from a previous open.
      const generation = dialogGeneration;
      setPending(true);
      void loadChatConfig(true).finally(() => {
        setPending(false);
        if (generation === dialogGeneration) elements.chatProvider.focus();
      });
      elements.chatSettingsDialog.showModal();
      elements.chatProvider.focus();
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
      dialogGeneration += 1;
      elements.chatCredential.value = '';
      elements.chatClearCredential.checked = false;
    };
    elements.chatSettingsDialog.addEventListener('close', handleSettingsClose);
    disposers.push(() =>
      elements.chatSettingsDialog.removeEventListener('close', handleSettingsClose),
    );

    const handleTestConnection = (): void => {
      if (pending) return;
      const input = chatConfigInput();
      const generation = dialogGeneration;
      elements.chatConnectionTest.dataset.tone = 'pending';
      elements.chatConnectionTest.textContent = '正在连接…';
      void dependencies.runGuarded(elements.testChatConnectionButton, '正在测试…', async () => {
        setPending(true);
        try {
          const result = await window.controlPanel.testChatConnection(input);
          if (generation !== dialogGeneration) return;
          elements.chatConnectionTest.dataset.tone = result.ok ? 'success' : 'error';
          elements.chatConnectionTest.textContent = input.autoDetect
            ? result.ok
              ? '连接成功。'
              : result.detail
            : `${result.detail} · ${result.latencyMs} ms${
                result.usage
                  ? ` · ${dependencies.formatTokenCount(result.usage.totalTokens)} tokens`
                  : ''
              }`;
          dependencies.showToast(
            result.ok ? '独立对话连接测试通过' : result.detail,
            result.ok ? 'success' : 'error',
          );
        } catch (error) {
          if (generation !== dialogGeneration) return;
          const message = error instanceof Error ? error.message : '连接测试失败。';
          elements.chatConnectionTest.dataset.tone = 'error';
          elements.chatConnectionTest.textContent = message;
          dependencies.showToast(message, 'error');
        } finally {
          setPending(false);
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
        ? '无需密钥。'
        : state.chatConfig?.credentialConfigured
          ? '已保存，留空继续使用。'
          : '';
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
