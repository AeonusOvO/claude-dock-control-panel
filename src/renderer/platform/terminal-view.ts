import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { ClaudePermissionMode, PtyGeneration } from '../../shared/contracts';
import type { TerminalOutputPump } from './terminal-output-pump';

export interface TerminalPermissionModeProbe {
  probeId: number;
  ptyGeneration: PtyGeneration;
  requiredRevision: number;
}

export interface TerminalView {
  appliedResizeRevision: number;
  container: HTMLDivElement;
  fitAddon: FitAddon;
  lastFitCols?: number;
  lastFitRows?: number;
  observedPermissionMode?: ClaudePermissionMode;
  outputPump: TerminalOutputPump;
  permissionModeProbes: TerminalPermissionModeProbe[];
  ptyGeneration: PtyGeneration;
  resizeRevision: number;
  terminal: Terminal;
}
