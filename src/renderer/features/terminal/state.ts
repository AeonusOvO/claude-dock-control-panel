import type { TerminalStatus } from '../../../shared/contracts';
import { OwnedSessionOperationRegistry } from '../../platform/session-generation';
import type { TerminalView } from '../../platform/terminal-view';

export type { TerminalPermissionModeProbe, TerminalView } from '../../platform/terminal-view';

/*
 * The bundled conpty.dll carries the Windows Terminal ConPTY rearchitecture, whose xterm.js
 * behaviours (soft-wrap reflow across resizes) are gated on Windows build 21376. Reporting this
 * floor keeps the renderer's terminal options correct even on Windows installs older than the DLL
 * the app actually launches.
 */
export const BUNDLED_CONPTY_BUILD = 21376;

export interface TerminalMaskState {
  depth: number;
  focusBeforeMask: HTMLElement | null;
  label: HTMLElement;
  overlay: HTMLDivElement;
  view: TerminalView;
}

export interface TerminalContextMenuTarget {
  menuRevision: number;
  ptyGeneration: TerminalStatus['ptyGeneration'];
  sessionId: string;
  view: TerminalView;
}

export type TerminalControlOperation = 'restart' | 'start' | 'stop';

export interface TerminalState {
  pendingComposerFocusSessionId: string;
  shownTerminalDiagnostics: Set<string>;
  terminalDiagnosticCloseTimer: number | undefined;
  terminalDiagnosticStatus: TerminalStatus | undefined;
  terminalContextMenuRevision: number;
  terminalContextMenuTarget: TerminalContextMenuTarget | undefined;
  terminalControlOperations: OwnedSessionOperationRegistry<TerminalControlOperation>;
  terminalFitDirty: boolean;
  terminalFitFrame: number | undefined;
  terminalFitGeneration: number;
  terminalMasks: Map<string, TerminalMaskState>;
  terminalViews: Map<string, TerminalView>;
}

export const createTerminalState = (): TerminalState => ({
  pendingComposerFocusSessionId: '',
  shownTerminalDiagnostics: new Set<string>(),
  terminalDiagnosticCloseTimer: undefined,
  terminalDiagnosticStatus: undefined,
  terminalContextMenuRevision: 0,
  terminalContextMenuTarget: undefined,
  terminalControlOperations: new OwnedSessionOperationRegistry<TerminalControlOperation>(),
  terminalFitDirty: false,
  terminalFitFrame: undefined,
  terminalFitGeneration: 0,
  terminalMasks: new Map<string, TerminalMaskState>(),
  terminalViews: new Map<string, TerminalView>(),
});
