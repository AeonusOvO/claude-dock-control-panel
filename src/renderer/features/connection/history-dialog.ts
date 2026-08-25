import { requiredElement } from '../../platform/dom';
import type { ConnectionHistoryMenuActions } from './history-bindings';
import type { ConnectionHistoryState } from './history-dependencies';
import { CONNECTION_HISTORY_SOURCES } from './history-render';
import type { ConnectionModelSource } from './history-source';

const connectionHistoryDialog = requiredElement<HTMLDialogElement>('#connection-history-dialog');
const openConnectionHistoryButton = requiredElement<HTMLButtonElement>('#open-connection-history');
const closeConnectionHistoryButton = requiredElement<HTMLButtonElement>(
  '#close-connection-history',
);
const finishConnectionHistoryButton = requiredElement<HTMLButtonElement>(
  '#finish-connection-history',
);
const connectionHistoryTrack = requiredElement<HTMLElement>('#connection-history-dialog-track');
const connectionHistoryTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#connection-history-tabs [role="tab"]'),
);
const connectionHistoryPanels = Array.from(
  document.querySelectorAll<HTMLElement>('#connection-history-dialog [role="tabpanel"]'),
);

const sourceFromElement = (element: HTMLElement): ConnectionModelSource | undefined => {
  const source = element.dataset.historyCategory as ConnectionModelSource | undefined;
  return source && CONNECTION_HISTORY_SOURCES.includes(source) ? source : undefined;
};

export interface ConnectionHistoryDialogActions {
  close: () => void;
  getActiveSource: () => ConnectionModelSource;
  open: () => void;
  selectSource: (source: ConnectionModelSource, focus?: boolean) => void;
}

export const createConnectionHistoryDialogActions = (
  state: ConnectionHistoryState,
  menuActions: ConnectionHistoryMenuActions,
): ConnectionHistoryDialogActions => {
  let activeSource: ConnectionModelSource = 'claude-subscription';

  const selectSource = (source: ConnectionModelSource, focus = false): void => {
    const previousIndex = CONNECTION_HISTORY_SOURCES.indexOf(activeSource);
    const nextIndex = CONNECTION_HISTORY_SOURCES.indexOf(source);
    if (nextIndex < 0) return;
    activeSource = source;
    connectionHistoryTrack.dataset.direction = nextIndex < previousIndex ? 'backward' : 'forward';
    connectionHistoryTrack.style.transform = `translate3d(-${nextIndex * 100}%, 0, 0)`;

    for (const tab of connectionHistoryTabs) {
      const selected = sourceFromElement(tab) === source;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) {
        tab.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
        if (focus) tab.focus({ preventScroll: true });
      }
    }
    for (const panel of connectionHistoryPanels) {
      const selected = sourceFromElement(panel) === source;
      panel.setAttribute('aria-hidden', String(!selected));
      panel.toggleAttribute('inert', !selected);
    }
  };

  const close = (): void => {
    if (connectionHistoryDialog.open) connectionHistoryDialog.close('complete');
  };

  const restoreContextMenuToPage = (): void => {
    menuActions.hideHistoryContextMenu();
    document.body.append(menuActions.historyContextMenu);
    if (openConnectionHistoryButton.isConnected && !openConnectionHistoryButton.disabled) {
      openConnectionHistoryButton.focus({ preventScroll: true });
    }
  };

  const open = (): void => {
    if (connectionHistoryDialog.open) return;
    menuActions.hideHistoryContextMenu();
    connectionHistoryDialog.append(menuActions.historyContextMenu);
    const initialSource = state.selectedSource ?? activeSource;
    selectSource(initialSource);
    connectionHistoryDialog.showModal();
    selectSource(initialSource, true);
  };

  for (const tab of connectionHistoryTabs) {
    tab.addEventListener('click', () => {
      const source = sourceFromElement(tab);
      if (source) selectSource(source);
    });
    tab.addEventListener('keydown', (event) => {
      const currentSource = sourceFromElement(tab);
      if (!currentSource) return;
      const currentIndex = CONNECTION_HISTORY_SOURCES.indexOf(currentSource);
      let nextIndex: number | undefined;
      if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % CONNECTION_HISTORY_SOURCES.length;
      }
      if (event.key === 'ArrowLeft') {
        nextIndex =
          (currentIndex - 1 + CONNECTION_HISTORY_SOURCES.length) %
          CONNECTION_HISTORY_SOURCES.length;
      }
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = CONNECTION_HISTORY_SOURCES.length - 1;
      if (nextIndex === undefined) return;
      const nextSource = CONNECTION_HISTORY_SOURCES[nextIndex];
      if (!nextSource) return;
      event.preventDefault();
      selectSource(nextSource, true);
    });
  }
  openConnectionHistoryButton.addEventListener('click', open);
  closeConnectionHistoryButton.addEventListener('click', close);
  finishConnectionHistoryButton.addEventListener('click', close);
  connectionHistoryDialog.addEventListener('click', (event) => {
    if (event.target === connectionHistoryDialog) close();
  });
  connectionHistoryDialog.addEventListener('cancel', menuActions.hideHistoryContextMenu);
  connectionHistoryDialog.addEventListener('close', restoreContextMenuToPage);

  return {
    close,
    getActiveSource: () => activeSource,
    open,
    selectSource,
  };
};
