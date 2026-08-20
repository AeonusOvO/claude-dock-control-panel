import { requiredElement } from '../../platform/dom';
import { connectionHistoryList } from './history-render';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';
import type { ConnectionHistoryMutationActions } from './history-mutations';

const historyContextMenu = requiredElement<HTMLElement>('#history-context-menu');

export interface ConnectionHistoryMenuActions {
  historyContextMenu: HTMLElement;
  hideHistoryContextMenu: () => void;
}

export const bindConnectionHistoryEvents = (
  deps: ConnectionHistoryDependencies,
  state: ConnectionHistoryState,
  mutationActions: ConnectionHistoryMutationActions,
): ConnectionHistoryMenuActions => {
  const { hideTerminalContextMenu, hideConversationContextMenu } = deps;

  const hideHistoryContextMenu = (): void => {
    historyContextMenu.hidden = true;
    state.targetId = '';
  };

  /*
   * One delegated listener for the whole list: entries are re-rendered on every save and delete, so
   * per-row listeners would have to be re-attached each time.
   */
  connectionHistoryList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-history-id]');
    const entryId = item?.dataset.historyId;
    if (!entryId) {
      return;
    }
    if (target.closest('.connection-history__delete')) {
      void mutationActions.deleteConnectionHistory(entryId);
      return;
    }
    if (target.closest('.connection-history__restore')) {
      void mutationActions.applyConnectionHistory(entryId);
    }
  });
  connectionHistoryList.addEventListener('contextmenu', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-history-id]');
    const entryId = item?.dataset.historyId;
    if (!entryId) {
      return;
    }
    event.preventDefault();
    hideTerminalContextMenu();
    hideConversationContextMenu();
    state.targetId = entryId;
    historyContextMenu.hidden = false;
    const menuRect = historyContextMenu.getBoundingClientRect();
    historyContextMenu.style.left = `${Math.max(
      8,
      Math.min(event.clientX, window.innerWidth - menuRect.width - 8),
    )}px`;
    historyContextMenu.style.top = `${Math.max(
      8,
      Math.min(event.clientY, window.innerHeight - menuRect.height - 8),
    )}px`;
    historyContextMenu.querySelector<HTMLButtonElement>('button')?.focus();
  });
  for (const button of historyContextMenu.querySelectorAll<HTMLButtonElement>(
    '[data-history-context-action]',
  )) {
    button.addEventListener('click', () => {
      const entryId = state.targetId;
      const action = button.dataset.historyContextAction;
      hideHistoryContextMenu();
      if (!entryId) {
        return;
      }
      if (action === 'rename') {
        void mutationActions.renameConnectionHistory(entryId);
      } else if (action === 'apply') {
        void mutationActions.applyConnectionHistory(entryId);
      } else if (action === 'delete') {
        void mutationActions.deleteConnectionHistory(entryId);
      }
    });
  }

  return { historyContextMenu, hideHistoryContextMenu };
};
