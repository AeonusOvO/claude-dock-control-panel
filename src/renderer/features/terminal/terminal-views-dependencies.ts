import type { TerminalThemeId } from '../../../shared/ui/terminal-themes';
import type { WorkspaceState } from '../../../shared/contracts';

export interface TerminalViewsDependencies {
  getActiveTheme: () => TerminalThemeId;
  getWindowsBuildNumber: () => number | undefined;
  getWorkspaceState: () => WorkspaceState;
}

export type TerminalFitResult = 'changed' | 'stable' | 'unavailable';
