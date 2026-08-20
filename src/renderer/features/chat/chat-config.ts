import type { SaveChatConfigInput } from '../../../shared/contracts';
import type { ChatActionsDependencies } from './dependencies';
import type { ChatElements } from './elements';
import type { ChatState } from './state';
import type { ChatView } from './view';

export interface ChatConfigActions {
  chatConfigInput: () => SaveChatConfigInput;
  focusChatInputAfterNavigation: () => void;
  loadChatConfig: (force?: boolean) => Promise<void>;
  resizeChatComposer: () => void;
}

export const createChatConfigActions = (
  elements: ChatElements,
  state: ChatState,
  dependencies: ChatActionsDependencies,
  view: ChatView,
): ChatConfigActions => {
  /**
   * Grows the chat textarea with its content up to `--composer-max`, mirroring `resizeComposer` for
   * the terminal. Chat used to rely on a native `resize: vertical` handle, which meant the send button
   * and the input drifted out of alignment the moment the draft wrapped.
   */
  const resizeChatComposer = (): void => {
    elements.chatInput.style.height = 'auto';
    const maxHeight = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--composer-max'),
    );
    const height = Number.isFinite(maxHeight)
      ? Math.min(elements.chatInput.scrollHeight, maxHeight)
      : elements.chatInput.scrollHeight;
    elements.chatInput.style.height = `${height}px`;
  };

  const chatConfigInput = (): SaveChatConfigInput => {
    const credential = elements.chatCredential.value.trim();
    return {
      authMode: elements.chatAuthMode.value as SaveChatConfigInput['authMode'],
      baseUrl: elements.chatBaseUrl.value,
      credential: credential || undefined,
      credentialAction: elements.chatClearCredential.checked
        ? 'clear'
        : credential
          ? 'replace'
          : 'keep',
      model: elements.chatModel.value,
      protocol: elements.chatProtocol.value as SaveChatConfigInput['protocol'],
    };
  };

  const loadChatConfig = (force = false): Promise<void> => {
    if (state.chatConfigLoadPromise && !force) {
      return state.chatConfigLoadPromise;
    }
    state.chatConfigLoadPromise = window.controlPanel
      .getChatConfig()
      .then((config) => {
        view.renderChatConfig(config);
        elements.chatConfigStatus.textContent = config.model
          ? '独立接入已就绪。'
          : '请填写模型并保存。';
      })
      .catch(() => {
        elements.chatConfigStatus.textContent = '无法读取独立对话配置。';
        dependencies.showToast('无法读取独立对话配置。', 'error');
      })
      .finally(() => {
        state.chatConfigLoadPromise = undefined;
      });
    return state.chatConfigLoadPromise;
  };

  const focusChatInputAfterNavigation = (): void => {
    window.requestAnimationFrame(() => {
      const detailsOpen = dependencies.isArtifactDetailsOpen();
      if (
        !dependencies.isChatView() ||
        dependencies.chatShell.hidden ||
        elements.chatInput.disabled ||
        dependencies.chatComposer.inert ||
        elements.chatSettingsDialog.open ||
        detailsOpen
      ) {
        return;
      }
      elements.chatInput.focus({ preventScroll: true });
    });
  };

  return {
    chatConfigInput,
    focusChatInputAfterNavigation,
    loadChatConfig,
    resizeChatComposer,
  };
};
