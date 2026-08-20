import { bindConnectionHistoryEvents } from './history-bindings';
import { createConnectionHistoryMutationActions } from './history-mutations';
import { createConnectionHistoryRenderActions } from './history-render';
import type { ClaudeConnectionHistoryEntry } from '../../../shared/contracts';

export type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';

export interface ConnectionHistory {
  readonly historyContextMenu: HTMLElement;
  readonly state: ConnectionHistoryState;
  load: () => Promise<void>;
  render: () => void;
  setEntries: (entries: ClaudeConnectionHistoryEntry[]) => void;
  hideContextMenu: () => void;
}

export const createConnectionHistory = (deps: ConnectionHistoryDependencies): ConnectionHistory => {
  const state: ConnectionHistoryState = {
    entries: [],
    mutationInProgress: false,
    targetId: '',
  };

  const renderActions = createConnectionHistoryRenderActions(state);
  const mutationActions = createConnectionHistoryMutationActions(
    deps,
    state,
    renderActions.renderConnectionHistory,
  );
  const menuActions = bindConnectionHistoryEvents(deps, state, mutationActions);

  return {
    historyContextMenu: menuActions.historyContextMenu,
    state,
    load: mutationActions.loadConnectionHistory,
    render: renderActions.renderConnectionHistory,
    setEntries: (entries) => {
      state.entries = entries;
    },
    hideContextMenu: menuActions.hideHistoryContextMenu,
  };
};
