import type {
  ClaudeProjectState,
  CodexProjectState,
  ManagedChatGptContextWindowMode,
  RuntimeActivitySnapshot,
  TerminalStatus,
} from '../../../shared/contracts';
import type { MarkdownDomRenderer } from '../../platform/markdown';

export interface ConversationActionsDependencies {
  terminalShell: HTMLElement;
  footerEffort: HTMLButtonElement;
  footerEffortMenu: HTMLElement;
  footerMode: HTMLButtonElement;
  footerModeMenu: HTMLElement;
  footerModel: HTMLButtonElement;
  footerModelMenu: HTMLElement;
  footerSpeed: HTMLButtonElement;
  footerSpeedMenu: HTMLElement;
  activeStatus: () => TerminalStatus | undefined;
  buildFooterRadioMenuItem: (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled?: boolean,
    triggerButton?: HTMLButtonElement,
  ) => HTMLButtonElement;
  formatAttachmentSize: (sizeBytes: number) => string;
  getClaudeState: (sessionId: string) => ClaudeProjectState | undefined;
  getActiveSessionId: () => string;
  getManagedChatGptContextWindowMode: () => ManagedChatGptContextWindowMode;
  getMarkdownRenderer: () => MarkdownDomRenderer;
  managedContextWindowSelectable: (
    state: ClaudeProjectState | undefined,
    selectedModel?: string,
  ) => boolean;
  openFooterMenu: (menu: HTMLElement, trigger: HTMLButtonElement) => void;
  renderFooterResource: (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
    contextWindowSelectable?: boolean,
  ) => void;
  renderRuntimeActivity: (snapshot?: RuntimeActivitySnapshot) => void;
  requestedClaudeContextWindowTokens: () => number | undefined;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  retryTerminalFitUntilMeasured: () => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
