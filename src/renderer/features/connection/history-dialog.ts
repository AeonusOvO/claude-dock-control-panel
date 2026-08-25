import { requiredElement } from '../../platform/dom';
import type { ConnectionHistoryMenuActions } from './history-bindings';
import type { ConnectionHistoryState } from './history-dependencies';
import { CONNECTION_HISTORY_SOURCES } from './history-render';
import { connectionModelSourceForHistoryEntry, type ConnectionModelSource } from './history-source';

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
  requestRestore: (entryId: string) => void;
  resetForProjectChange: () => void;
  selectSource: (source: ConnectionModelSource, focus?: boolean) => void;
}

export const createConnectionHistoryDialogActions = (
  state: ConnectionHistoryState,
  menuActions: ConnectionHistoryMenuActions,
  renderConnectionHistory: () => void,
  startRecovery: (entryId: string, restoreFocus?: () => void) => Promise<void>,
): ConnectionHistoryDialogActions => {
  let activeSource: ConnectionModelSource = 'claude-subscription';
  let confirmedClose = false;
  let restoreFocusAfterClose: (() => void) | undefined;

  const focusableHistoryEntry = (entryId: string): HTMLButtonElement | undefined => {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[data-history-id]')).find(
      (candidate) =>
        !connectionHistoryDialog.contains(candidate) && candidate.dataset.historyId === entryId,
    );
    return item?.querySelector<HTMLButtonElement>('.connection-history__restore') ?? undefined;
  };

  const createFocusRestorer = (entryId?: string): (() => void) => {
    const activeElement =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : undefined;
    const activeElementId = activeElement?.id;
    return () => {
      const candidate =
        (entryId ? focusableHistoryEntry(entryId) : undefined) ??
        (activeElement?.isConnected ? activeElement : undefined) ??
        (activeElementId ? document.getElementById(activeElementId) : undefined) ??
        openConnectionHistoryButton;
      if (
        candidate instanceof HTMLElement &&
        !candidate.closest('[hidden], [inert]') &&
        !(candidate instanceof HTMLButtonElement && candidate.disabled)
      ) {
        candidate.focus({ preventScroll: true });
        return;
      }
      if (openConnectionHistoryButton.isConnected && !openConnectionHistoryButton.disabled) {
        openConnectionHistoryButton.focus({ preventScroll: true });
      }
    };
  };

  const selectSource = (
    source: ConnectionModelSource,
    focus = false,
    clearSelection = true,
  ): void => {
    const previousIndex = CONNECTION_HISTORY_SOURCES.indexOf(activeSource);
    const nextIndex = CONNECTION_HISTORY_SOURCES.indexOf(source);
    if (nextIndex < 0) return;
    if (clearSelection && state.selectedEntryId) {
      state.selectedEntryId = '';
      renderConnectionHistory();
    }
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
    if (connectionHistoryDialog.open) connectionHistoryDialog.close('cancel');
  };

  const restoreContextMenuToPage = (): void => {
    const shouldRestoreFocus = !confirmedClose;
    const restoreFocus = restoreFocusAfterClose;
    menuActions.hideHistoryContextMenu();
    document.body.append(menuActions.historyContextMenu);
    if (!confirmedClose && state.selectedEntryId) {
      state.selectedEntryId = '';
      renderConnectionHistory();
    }
    restoreFocusAfterClose = undefined;
    confirmedClose = false;
    if (shouldRestoreFocus) restoreFocus?.();
  };

  const open = (): void => {
    if (connectionHistoryDialog.open) return;
    restoreFocusAfterClose = () => {
      if (openConnectionHistoryButton.isConnected && !openConnectionHistoryButton.disabled) {
        openConnectionHistoryButton.focus({ preventScroll: true });
      }
    };
    state.selectedEntryId = '';
    renderConnectionHistory();
    menuActions.hideHistoryContextMenu();
    connectionHistoryDialog.append(menuActions.historyContextMenu);
    const initialSource = state.selectedSource ?? activeSource;
    selectSource(initialSource, false, false);
    connectionHistoryDialog.showModal();
    selectSource(initialSource, true, false);
  };

  const focusSelectedEntry = (): void => {
    const selected = Array.from(
      connectionHistoryDialog.querySelectorAll<HTMLElement>('[data-history-id]'),
    ).find((candidate) => candidate.dataset.historyId === state.selectedEntryId);
    selected
      ?.querySelector<HTMLButtonElement>('.connection-history__restore')
      ?.focus({ preventScroll: true });
  };

  const requestRestore = (entryId: string): void => {
    const entry = state.allEntries.find((candidate) => candidate.id === entryId);
    if (!entry || state.mutationInProgress) return;
    const source = connectionModelSourceForHistoryEntry(entry);
    if (!connectionHistoryDialog.open) {
      restoreFocusAfterClose = createFocusRestorer(entryId);
    }
    state.selectedEntryId = entryId;
    renderConnectionHistory();
    menuActions.hideHistoryContextMenu();
    if (!connectionHistoryDialog.open) {
      connectionHistoryDialog.append(menuActions.historyContextMenu);
      selectSource(source, false, false);
      connectionHistoryDialog.showModal();
    } else {
      selectSource(source, false, false);
    }
    window.requestAnimationFrame(focusSelectedEntry);
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
  finishConnectionHistoryButton.addEventListener('click', () => {
    if (state.mutationInProgress) return;
    const entryId = state.selectedEntryId;
    if (!entryId) {
      close();
      return;
    }
    const restoreFocus = restoreFocusAfterClose;
    state.selectedEntryId = '';
    renderConnectionHistory();
    confirmedClose = true;
    connectionHistoryDialog.close('confirm');
    void startRecovery(entryId, restoreFocus);
  });
  connectionHistoryDialog.addEventListener('click', (event) => {
    if (event.target === connectionHistoryDialog) close();
  });
  connectionHistoryDialog.addEventListener('cancel', menuActions.hideHistoryContextMenu);
  connectionHistoryDialog.addEventListener('close', restoreContextMenuToPage);

  const resetForProjectChange = (): void => {
    restoreFocusAfterClose = undefined;
    confirmedClose = true;
    if (connectionHistoryDialog.open) connectionHistoryDialog.close('reset');
    confirmedClose = false;
  };

  return {
    close,
    getActiveSource: () => activeSource,
    open,
    requestRestore,
    resetForProjectChange,
    selectSource,
  };
};
