import type {
  ClaudeConnectionHistoryEntry,
  ClaudeProjectState,
  TerminalStatus,
} from '../../../shared/contracts';
import type { ConnectionModelSource } from './history-source';

export interface ConnectionHistoryState {
  allEntries: ClaudeConnectionHistoryEntry[];
  entries: ClaudeConnectionHistoryEntry[];
  mutationInProgress: boolean;
  selectedSource: ConnectionModelSource | undefined;
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
