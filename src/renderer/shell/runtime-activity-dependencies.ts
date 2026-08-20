import type { RuntimeActivitySnapshot, TerminalStatus } from '../../shared/contracts';
import type { ConversationSnapshot } from '../../shared/conversation/native';

export interface RuntimeActivityShellDeps {
  getActiveSessionId: () => string;
  runtimeActivityStates: Map<string, RuntimeActivitySnapshot>;
  getActiveConversationSnapshot: () => ConversationSnapshot | undefined;
  activeStatus: () => TerminalStatus | undefined;
  renderActiveStatus: (status: TerminalStatus) => void;
  renderNoActiveSession: () => void;
  footerStatus: HTMLElement;
  titleStatus: HTMLElement;
  nativePhaseLabel: (phase: ConversationSnapshot['phase']) => string;
  openExternal: (url: string) => Promise<void>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
