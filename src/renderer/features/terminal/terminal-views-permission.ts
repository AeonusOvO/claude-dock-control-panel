import { parseClaudePermissionMode } from '../../../shared/claude/permission-mode';
import type { ClaudePermissionMode, PtyGeneration } from '../../../shared/contracts';
import type { TerminalIo } from './terminal-io';
import type { TerminalState, TerminalView } from './state';

export interface TerminalViewPermissionActions {
  answerReadyPermissionModeProbes: (sessionId: string, view: TerminalView) => void;
  queueTerminalOutput: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => void;
  readTerminalPermissionMode: (view: TerminalView) => ClaudePermissionMode | undefined;
  rejectPermissionModeProbes: (sessionId: string, view: TerminalView) => void;
  reportTerminalPermissionMode: (sessionId: string, view: TerminalView) => void;
}

export const createTerminalViewPermissionActions = (
  state: TerminalState,
  io: TerminalIo,
): TerminalViewPermissionActions => {
  /**
   * xterm has already applied cursor moves and retained unchanged cells, so its current screen
   * contains the complete mode badge even when the PTY emitted only a repaint delta. Read every row
   * in the active screen: custom prompt layouts can place the badge more than eight rows from the
   * bottom, and the screen is small enough that a full scan is negligible.
   */
  const readTerminalPermissionMode = (view: TerminalView): ClaudePermissionMode | undefined => {
    const buffer = view.terminal.buffer.active;
    const lines: string[] = [];
    const end = Math.min(buffer.length, buffer.baseY + view.terminal.rows);
    for (let row = buffer.baseY; row < end; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    }
    return parseClaudePermissionMode(lines.join('\n'));
  };

  const reportTerminalPermissionMode = (sessionId: string, view: TerminalView): void => {
    if (!io.ownsTerminalGeneration(sessionId, view.ptyGeneration, view)) {
      return;
    }
    const mode = readTerminalPermissionMode(view);
    if (!mode || mode === view.observedPermissionMode) {
      return;
    }
    view.observedPermissionMode = mode;
    window.controlPanel.observeClaudePermissionMode(sessionId, view.ptyGeneration, mode);
  };

  const answerReadyPermissionModeProbes = (sessionId: string, view: TerminalView): void => {
    if (!io.ownsTerminalGeneration(sessionId, view.ptyGeneration, view)) {
      return;
    }
    const ready = view.permissionModeProbes.filter(
      (probe) =>
        probe.ptyGeneration === view.ptyGeneration &&
        probe.requiredRevision <= view.outputPump.appliedRevision,
    );
    if (ready.length === 0) {
      return;
    }
    view.permissionModeProbes = view.permissionModeProbes.filter(
      (probe) =>
        probe.ptyGeneration !== view.ptyGeneration ||
        probe.requiredRevision > view.outputPump.appliedRevision,
    );
    const mode = readTerminalPermissionMode(view);
    for (const { probeId, ptyGeneration } of ready) {
      window.controlPanel.reportClaudePermissionModeProbe(sessionId, ptyGeneration, probeId, mode);
    }
  };

  const rejectPermissionModeProbes = (sessionId: string, view: TerminalView): void => {
    for (const { probeId, ptyGeneration } of view.permissionModeProbes) {
      window.controlPanel.reportClaudePermissionModeProbe(sessionId, ptyGeneration, probeId);
    }
    view.permissionModeProbes.length = 0;
  };

  /**
   * Output is admitted into the exact generation's lossless pump. The pump coalesces work per frame,
   * bounds each xterm parse quantum, and never starts another write until xterm acknowledges this one.
   */
  const queueTerminalOutput = (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    data: string,
  ): void => {
    const view = state.terminalViews.get(sessionId);
    if (!view || !io.ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
      return;
    }
    view.outputPump.enqueue(data);
  };

  return {
    answerReadyPermissionModeProbes,
    queueTerminalOutput,
    readTerminalPermissionMode,
    rejectPermissionModeProbes,
    reportTerminalPermissionMode,
  };
};
