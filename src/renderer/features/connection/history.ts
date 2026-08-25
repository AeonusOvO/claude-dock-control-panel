import { bindConnectionHistoryEvents } from './history-bindings';
import { createConnectionHistoryDialogActions } from './history-dialog';
import { createConnectionHistoryMutationActions } from './history-mutations';
import { createConnectionHistoryRenderActions } from './history-render';
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
  load: () => Promise<void>;
  openDialog: () => void;
  render: () => void;
  setEntries: (entries: ClaudeConnectionHistoryEntry[]) => void;
  setSelectedProvider: (providerId: ClaudeProviderId | undefined) => void;
  hideContextMenu: () => void;
}

export const createConnectionHistory = (deps: ConnectionHistoryDependencies): ConnectionHistory => {
  const state: ConnectionHistoryState = {
    allEntries: [],
    entries: [],
    mutationInProgress: false,
    selectedSource: undefined,
    targetId: '',
  };

  const setEntries = (entries: ClaudeConnectionHistoryEntry[]): void => {
    state.allEntries = entries;
    state.entries = filterConnectionHistoryBySource(entries, state.selectedSource);
  };

  const renderActions = createConnectionHistoryRenderActions(state);
  const mutationActions = createConnectionHistoryMutationActions(
    deps,
    state,
    setEntries,
    renderActions.renderConnectionHistory,
    renderActions.setConnectionHistoryBusy,
  );
  const menuActions = bindConnectionHistoryEvents(deps, state, mutationActions);
  const dialogActions = createConnectionHistoryDialogActions(state, menuActions);

  return {
    closeDialog: dialogActions.close,
    historyContextMenu: menuActions.historyContextMenu,
    state,
    load: mutationActions.loadConnectionHistory,
    openDialog: dialogActions.open,
    render: renderActions.renderConnectionHistory,
    setEntries,
    setSelectedProvider: (providerId) => {
      state.selectedSource = connectionModelSourceForProvider(providerId);
      state.entries = filterConnectionHistoryBySource(state.allEntries, state.selectedSource);
      renderActions.renderConnectionHistory();
    },
    hideContextMenu: menuActions.hideHistoryContextMenu,
  };
};
