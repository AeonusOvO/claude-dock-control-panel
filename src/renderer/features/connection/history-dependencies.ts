import type {
  ClaudeConnectionHistoryEntry,
  ClaudeProjectState,
  ManagedChatGptGatewayState,
  TerminalStatus,
} from '../../../shared/contracts';
import type { ConnectionModelSource } from './history-source';

export interface ConnectionHistoryState {
  allEntries: ClaudeConnectionHistoryEntry[];
  entries: ClaudeConnectionHistoryEntry[];
  mutationInProgress: boolean;
  selectedEntryId: string;
  selectedSource: ConnectionModelSource | undefined;
  targetId: string;
}

export interface ConnectionHistoryDependencies {
  activeClaudeState: () => ClaudeProjectState | undefined;
  activeStatus: () => TerminalStatus | undefined;
  getManagedChatGptGatewayState: () => Promise<ManagedChatGptGatewayState>;
  hideTerminalContextMenu: () => void;
  hideConversationContextMenu: () => void;
  populateClaudeConfigForm: (state: ClaudeProjectState) => void;
  renderClaudeState: (state: ClaudeProjectState) => void;
  requestConnectionHistoryName: (currentName: string) => Promise<string | null>;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
