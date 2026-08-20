import { historyDisplayName } from './history-labels';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';

export interface ConnectionHistoryMutationActions {
  applyConnectionHistory: (entryId: string) => Promise<void>;
  deleteConnectionHistory: (entryId: string) => Promise<void>;
  loadConnectionHistory: () => Promise<void>;
  renameConnectionHistory: (entryId: string) => Promise<void>;
}

export const createConnectionHistoryMutationActions = (
  deps: ConnectionHistoryDependencies,
  state: ConnectionHistoryState,
  renderConnectionHistory: () => void,
): ConnectionHistoryMutationActions => {
  const {
    activeStatus,
    populateClaudeConfigForm,
    renderClaudeState,
    requestConnectionHistoryName,
    resultFailureMessage,
    showToast,
  } = deps;

  const renameConnectionHistory = async (entryId: string): Promise<void> => {
    const status = activeStatus();
    const entry = state.entries.find((candidate) => candidate.id === entryId);
    if (!status || !entry || state.mutationInProgress) {
      return;
    }
    const nextName = await requestConnectionHistoryName(historyDisplayName(entry));
    if (!nextName) {
      return;
    }
    state.mutationInProgress = true;
    try {
      const result = await window.controlPanel.renameClaudeConnectionHistory(
        status.id,
        entryId,
        nextName,
      );
      state.entries = result.entries;
      renderConnectionHistory();
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法重命名这条接入记录。'), 'error');
        return;
      }
      showToast('连接名称已更新。');
    } catch {
      showToast('无法重命名这条接入记录。', 'error');
    } finally {
      state.mutationInProgress = false;
    }
  };

  const loadConnectionHistory = async (): Promise<void> => {
    const status = activeStatus();
    if (!status) {
      state.entries = [];
      renderConnectionHistory();
      return;
    }
    try {
      state.entries = await window.controlPanel.getClaudeConnectionHistory(status.id);
    } catch {
      state.entries = [];
    }
    renderConnectionHistory();
  };

  const applyConnectionHistory = async (entryId: string): Promise<void> => {
    const status = activeStatus();
    if (!status || state.mutationInProgress) {
      return;
    }
    state.mutationInProgress = true;
    try {
      const result = await window.controlPanel.applyClaudeConnectionHistory(status.id, entryId);
      state.entries = result.entries;
      renderConnectionHistory();
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法恢复这条接入记录。'), 'error');
        return;
      }
      if (result.state) {
        renderClaudeState(result.state);
        populateClaudeConfigForm(result.state);
      }
      showToast('已恢复这条接入配置');
    } catch {
      showToast('无法恢复这条接入记录。', 'error');
    } finally {
      state.mutationInProgress = false;
    }
  };

  const deleteConnectionHistory = async (entryId: string): Promise<void> => {
    const status = activeStatus();
    if (!status || state.mutationInProgress) {
      return;
    }
    state.mutationInProgress = true;
    try {
      const result = await window.controlPanel.deleteClaudeConnectionHistory(status.id, entryId);
      state.entries = result.entries;
      renderConnectionHistory();
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法删除这条接入记录。'), 'error');
        return;
      }
      showToast('已删除这条接入记录');
    } catch {
      showToast('无法删除这条接入记录。', 'error');
    } finally {
      state.mutationInProgress = false;
    }
  };

  return {
    applyConnectionHistory,
    deleteConnectionHistory,
    loadConnectionHistory,
    renameConnectionHistory,
  };
};
