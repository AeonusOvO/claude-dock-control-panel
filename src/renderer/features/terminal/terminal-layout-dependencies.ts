import type { TerminalStatus, WorkspaceState } from '../../../shared/contracts';

export interface TerminalLayoutDependencies {
  activeStatus: () => TerminalStatus | undefined;
  getClaudeWorkbench: () => HTMLElement;
  getWorkspaceState: () => WorkspaceState;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
