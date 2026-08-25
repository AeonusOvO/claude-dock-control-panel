import { historyDisplayName } from './history-labels';
import type { ClaudeConnectionHistoryResult } from '../../../shared/contracts';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';

export interface ConnectionHistoryMutationActions {
  applyConnectionHistory: (entryId: string) => Promise<ClaudeConnectionHistoryResult | undefined>;
  cancelConnectionHistoryApply: () => Promise<boolean>;
  deleteConnectionHistory: (entryId: string) => Promise<void>;
  invalidate: () => void;
  loadConnectionHistory: () => Promise<void>;
  renameConnectionHistory: (entryId: string) => Promise<void>;
}

type HistoryMutationKind = 'apply' | 'delete' | 'rename';

interface HistoryRequestToken {
  readonly generation: number;
  readonly sessionId: string;
}

interface HistoryMutationToken extends HistoryRequestToken {
  readonly kind: HistoryMutationKind;
}

export const createConnectionHistoryMutationActions = (
  deps: ConnectionHistoryDependencies,
  state: ConnectionHistoryState,
  setEntries: (entries: ConnectionHistoryState['allEntries']) => void,
  renderConnectionHistory: () => void,
  setConnectionHistoryBusy: (busy: boolean) => void,
  renderCurrentConnection: (state?: ClaudeConnectionHistoryResult['state']) => void,
): ConnectionHistoryMutationActions => {
  const {
    activeStatus,
    populateClaudeConfigForm,
    renderClaudeState,
    requestConnectionHistoryName,
    resultFailureMessage,
    showToast,
  } = deps;

  let nextGeneration = 0;
  let loadOwner: HistoryRequestToken | undefined;
  let mutationOwner: HistoryMutationToken | undefined;

  const isActiveSession = (token: HistoryRequestToken): boolean =>
    activeStatus()?.id === token.sessionId;

  const isCurrentLoad = (token: HistoryRequestToken): boolean =>
    loadOwner?.generation === token.generation && isActiveSession(token);

  const isCurrentMutation = (token: HistoryMutationToken): boolean =>
    mutationOwner?.generation === token.generation && isActiveSession(token);

  const beginMutation = (sessionId: string, kind: HistoryMutationKind): HistoryMutationToken => {
    // A mutation is newer than any outstanding read for the same visible history surface.
    loadOwner = undefined;
    const token = { generation: ++nextGeneration, kind, sessionId };
    mutationOwner = token;
    state.mutationInProgress = true;
    setConnectionHistoryBusy(true);
    return token;
  };

  const finishMutation = (token: HistoryMutationToken): void => {
    if (!isCurrentMutation(token)) return;
    mutationOwner = undefined;
    state.mutationInProgress = false;
    setConnectionHistoryBusy(false);
  };

  const invalidate = (): void => {
    // Advancing the generation also protects against a deleted project later reusing a session id.
    nextGeneration += 1;
    loadOwner = undefined;
    mutationOwner = undefined;
    state.mutationInProgress = false;
    setConnectionHistoryBusy(false);
  };

  const renameConnectionHistory = async (entryId: string): Promise<void> => {
    const status = activeStatus();
    const entry = state.allEntries.find((candidate) => candidate.id === entryId);
    if (!status || !entry || state.mutationInProgress) {
      return;
    }
    const token = beginMutation(status.id, 'rename');
    try {
      const nextName = await requestConnectionHistoryName(historyDisplayName(entry));
      if (!isCurrentMutation(token) || !nextName) return;
      const result = await window.controlPanel.renameClaudeConnectionHistory(
        token.sessionId,
        entryId,
        nextName,
      );
      if (!isCurrentMutation(token)) return;
      setEntries(result.entries);
      renderConnectionHistory();
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法重命名这条接入记录。'), 'error');
        return;
      }
      showToast('连接名称已更新。');
    } catch {
      if (isCurrentMutation(token)) {
        showToast('无法重命名这条接入记录。', 'error');
      }
    } finally {
      finishMutation(token);
    }
  };

  const loadConnectionHistory = async (): Promise<void> => {
    const status = activeStatus();
    if (!status) {
      loadOwner = undefined;
      setEntries([]);
      renderConnectionHistory();
      return;
    }
    if (state.mutationInProgress) return;
    const token = { generation: ++nextGeneration, sessionId: status.id };
    loadOwner = token;
    try {
      const entries = await window.controlPanel.getClaudeConnectionHistory(token.sessionId);
      if (!isCurrentLoad(token)) return;
      setEntries(entries);
    } catch {
      if (!isCurrentLoad(token)) return;
      setEntries([]);
    } finally {
      if (loadOwner?.generation === token.generation) loadOwner = undefined;
    }
    if (!isActiveSession(token)) return;
    renderConnectionHistory();
  };

  const applyConnectionHistory = async (
    entryId: string,
  ): Promise<ClaudeConnectionHistoryResult | undefined> => {
    const status = activeStatus();
    if (!status || state.mutationInProgress) {
      return undefined;
    }
    const token = beginMutation(status.id, 'apply');
    try {
      const result = await window.controlPanel.applyClaudeConnectionHistory(
        token.sessionId,
        entryId,
      );
      if (!isCurrentMutation(token)) return undefined;
      setEntries(result.entries);
      renderConnectionHistory();
      if (result.state) {
        renderClaudeState(result.state);
        populateClaudeConfigForm(result.state);
        renderCurrentConnection(result.state);
      }
      return result;
    } catch {
      return undefined;
    } finally {
      finishMutation(token);
    }
  };

  const cancelConnectionHistoryApply = async (): Promise<boolean> => {
    const owner = mutationOwner;
    if (!owner || owner.kind !== 'apply' || !isCurrentMutation(owner)) return false;
    try {
      const cancelled = await window.controlPanel.cancelClaudeConnectionHistoryApply(
        owner.sessionId,
      );
      // The apply response and cancellation acknowledgement travel over separate IPC calls. The
      // apply may therefore finish (and release its renderer busy owner) just before the exact
      // cancellation acknowledgement arrives. Main already binds this request to `owner`'s exact
      // AbortSignal, so a positive acknowledgement remains authoritative after local cleanup.
      return cancelled;
    } catch {
      return false;
    }
  };

  const deleteConnectionHistory = async (entryId: string): Promise<void> => {
    const status = activeStatus();
    if (!status || state.mutationInProgress) {
      return;
    }
    const token = beginMutation(status.id, 'delete');
    try {
      const result = await window.controlPanel.deleteClaudeConnectionHistory(
        token.sessionId,
        entryId,
      );
      if (!isCurrentMutation(token)) return;
      setEntries(result.entries);
      renderConnectionHistory();
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法删除这条接入记录。'), 'error');
        return;
      }
      showToast('已删除这条接入记录');
    } catch {
      if (isCurrentMutation(token)) {
        showToast('无法删除这条接入记录。', 'error');
      }
    } finally {
      finishMutation(token);
    }
  };

  return {
    applyConnectionHistory,
    cancelConnectionHistoryApply,
    deleteConnectionHistory,
    invalidate,
    loadConnectionHistory,
    renameConnectionHistory,
  };
};
