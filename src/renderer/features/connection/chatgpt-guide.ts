import { buildChatGptSubscriptionGuideElements } from './chatgpt-guide-elements';
import { createChatGptGuideRenderActions } from './chatgpt-guide-render';
import { createChatGptGuideSetupActions } from './chatgpt-guide-setup';

export type { ChatGptSubscriptionGuideDeps } from './chatgpt-guide-dependencies';
import type { ChatGptSubscriptionGuideDeps } from './chatgpt-guide-dependencies';

export const createChatGptSubscriptionGuide = (
  deps: ChatGptSubscriptionGuideDeps,
): (() => HTMLElement) => {
  const buildChatGptSubscriptionGuide = (): HTMLElement => {
    const elements = buildChatGptSubscriptionGuideElements();
    const renderActions = createChatGptGuideRenderActions(elements, deps, (button) =>
      setupActions.runLogout(button),
    );
    const setupActions = createChatGptGuideSetupActions(elements, deps, renderActions);
    const {
      guide,
      title,
      source,
      statusCard,
      progressCard,
      modelField,
      secondaryActions,
      boundary,
    } = elements;
    guide.append(title, source, statusCard, progressCard, modelField, secondaryActions, boundary);
    return guide;
  };

  return buildChatGptSubscriptionGuide;
};
