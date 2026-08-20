import type { ChatElements } from './elements';

export interface ChatContinuationActions {
  appendChatContinuationButton: (replyElement: HTMLElement) => HTMLButtonElement | undefined;
}

export const createChatContinuationActions = (
  elements: ChatElements,
  resizeChatComposer: () => void,
  submitChatMessage: () => Promise<void>,
): ChatContinuationActions => {
  const appendChatContinuationButton = (
    replyElement: HTMLElement,
  ): HTMLButtonElement | undefined => {
    const article = replyElement.closest('article');
    if (!article) {
      return undefined;
    }
    const button = document.createElement('button');
    button.className = 'chat-message__continue';
    button.disabled = true;
    button.textContent = '继续生成';
    button.type = 'button';
    button.addEventListener('click', () => {
      button.remove();
      elements.chatInput.value = '请从上一条回答中断处继续，不要重复已经给出的内容。';
      resizeChatComposer();
      void submitChatMessage();
    });
    article.append(button);
    return button;
  };

  return {
    appendChatContinuationButton,
  };
};
