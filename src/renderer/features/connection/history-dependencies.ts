import type {
  ClaudeConnectionHistoryEntry,
  ClaudeProjectState,
  TerminalStatus,
} from '../../../shared/contracts';

export interface ConnectionHistoryState {
  entries: ClaudeConnectionHistoryEntry[];
  mutationInProgress: boolean;
  targetId: string;
}

export interface ConnectionHistoryDependencies {
  activeStatus: () => TerminalStatus | undefined;
  hideTerminalContextMenu: () => void;
  hideConversationContextMenu: () => void;
  populateClaudeConfigForm: (state: ClaudeProjectState) => void;
  renderClaudeState: (state: ClaudeProjectState) => void;
  requestConnectionHistoryName: (currentName: string) => Promise<string | null>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
