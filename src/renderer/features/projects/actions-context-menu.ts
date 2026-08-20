import type { ConversationContextTarget, ProjectsState } from './state';
import type { ProjectsElements } from './elements';
import type { ProjectsActionsDependencies } from './actions-dependencies';

export interface ProjectsContextMenuActions {
  hideConversationContextMenu: () => void;
  showConversationContextMenu: (
    event: MouseEvent,
    target: Exclude<ConversationContextTarget, undefined>,
  ) => void;
}

export const createProjectsContextMenuActions = (
  elements: ProjectsElements,
  state: ProjectsState,
  dependencies: ProjectsActionsDependencies,
): ProjectsContextMenuActions => {
  const hideConversationContextMenu = (): void => {
    elements.conversationContextMenu.hidden = true;
    state.conversationContextTarget = undefined;
  };

  const showConversationContextMenu = (
    event: MouseEvent,
    target: Exclude<ConversationContextTarget, undefined>,
  ): void => {
    event.preventDefault();
    dependencies.hideTerminalContextMenu();
    state.conversationContextTarget = target;
    const deleteButton = elements.conversationContextMenu.querySelector<HTMLButtonElement>(
      '[data-conversation-context-action="delete"]',
    );
    if (deleteButton) {
      deleteButton.hidden = target.kind !== 'history';
    }
    elements.conversationContextMenu.hidden = false;
    const menuRect = elements.conversationContextMenu.getBoundingClientRect();
    elements.conversationContextMenu.style.left = `${Math.max(
      8,
      Math.min(event.clientX, window.innerWidth - menuRect.width - 8),
    )}px`;
    elements.conversationContextMenu.style.top = `${Math.max(
      8,
      Math.min(event.clientY, window.innerHeight - menuRect.height - 8),
    )}px`;
    elements.conversationContextMenu.querySelector<HTMLButtonElement>('button')?.focus();
  };

  return {
    hideConversationContextMenu,
    showConversationContextMenu,
  };
};
