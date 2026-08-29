import { bindConnectionHistoryEvents } from './history-bindings';
import { createConnectionHistoryDialogActions } from './history-dialog';
import { createConnectionHistoryMutationActions } from './history-mutations';
import { createConnectionHistoryRenderActions } from './history-render';
import { createConnectionHistoryRecoveryActions } from './history-recovery';
import { createCurrentConnectionViewActions } from './current-connection-view';
import type { ClaudeConnectionHistoryEntry } from '../../../shared/contracts';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import {
  connectionModelSourceForProvider,
  filterConnectionHistoryBySource,
} from './history-source';

export type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';

export interface ConnectionHistory {
  readonly historyContextMenu: HTMLElement;
  readonly state: ConnectionHistoryState;
  closeDialog: () => void;
  dispose: () => void;
  load: () => Promise<void>;
  openDialog: () => void;
  render: () => void;
  renderCurrentConnection: () => void;
  invalidateManagedChatGptAccount: () => void;
  resetForProjectChange: () => void;
  setEntries: (entries: ClaudeConnectionHistoryEntry[]) => void;
  setSelectedProvider: (providerId: ClaudeProviderId | undefined) => void;
  hideContextMenu: () => void;
}

export const createConnectionHistory = (deps: ConnectionHistoryDependencies): ConnectionHistory => {
  const state: ConnectionHistoryState = {
    allEntries: [],
    entries: [],
    mutationInProgress: false,
    selectedEntryId: '',
    selectedSource: undefined,
    targetId: '',
  };

  let renderCurrentConnection = (): void => undefined;
  const setEntries = (entries: ClaudeConnectionHistoryEntry[]): void => {
    state.allEntries = entries;
    state.entries = filterConnectionHistoryBySource(entries, state.selectedSource);
    if (state.selectedEntryId && !entries.some((entry) => entry.id === state.selectedEntryId)) {
      state.selectedEntryId = '';
    }
    renderCurrentConnection();
  };

  const renderActions = createConnectionHistoryRenderActions(state);
  const currentConnectionActions = createCurrentConnectionViewActions(deps, state);
  renderCurrentConnection = currentConnectionActions.render;
  const mutationActions = createConnectionHistoryMutationActions(
    deps,
    state,
    setEntries,
    renderActions.renderConnectionHistory,
    renderActions.setConnectionHistoryBusy,
    currentConnectionActions.render,
  );
  const recoveryActions = createConnectionHistoryRecoveryActions(
    deps,
    state,
    mutationActions,
    currentConnectionActions.render,
  );
  let requestRestore = (_entryId: string): void => undefined;
  const menuActions = bindConnectionHistoryEvents(deps, state, mutationActions, (entryId) => {
    requestRestore(entryId);
  });
  const dialogActions = createConnectionHistoryDialogActions(
    state,
    menuActions,
    renderActions.renderConnectionHistory,
    recoveryActions.start,
  );
  requestRestore = dialogActions.requestRestore;

  const resetForProjectChange = (): void => {
    mutationActions.invalidate();
    dialogActions.resetForProjectChange();
    recoveryActions.reset();
    state.selectedEntryId = '';
    setEntries([]);
    renderActions.renderConnectionHistory();
  };

  return {
    closeDialog: dialogActions.close,
    dispose: currentConnectionActions.dispose,
    historyContextMenu: menuActions.historyContextMenu,
    state,
    load: mutationActions.loadConnectionHistory,
    openDialog: dialogActions.open,
    render: () => {
      renderActions.renderConnectionHistory();
      currentConnectionActions.render();
    },
    renderCurrentConnection: currentConnectionActions.render,
    invalidateManagedChatGptAccount: currentConnectionActions.invalidateManagedChatGptAccount,
    resetForProjectChange,
    setEntries,
    setSelectedProvider: (providerId) => {
      state.selectedSource = connectionModelSourceForProvider(providerId);
      state.entries = filterConnectionHistoryBySource(state.allEntries, state.selectedSource);
      renderActions.renderConnectionHistory();
    },
    hideContextMenu: menuActions.hideHistoryContextMenu,
  };
};
