import type { TerminalIo } from './terminal-io';
import type { TerminalViews } from './terminal-views';
import type { TerminalState } from './state';

export const bindTerminalIpcListeners = (
  state: TerminalState,
  io: TerminalIo,
  views: TerminalViews,
): void => {
  window.controlPanel.onTerminalData((sessionId, ptyGeneration, data) => {
    views.queueTerminalOutput(sessionId, ptyGeneration, data);
  });
  window.controlPanel.onClaudePermissionModeProbe((sessionId, ptyGeneration, probeId) => {
    const view = state.terminalViews.get(sessionId);
    if (!view || !io.ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
      window.controlPanel.reportClaudePermissionModeProbe(sessionId, ptyGeneration, probeId);
      return;
    }
    if (view.outputPump.appliedRevision >= view.outputPump.acceptedRevision) {
      window.controlPanel.reportClaudePermissionModeProbe(
        sessionId,
        ptyGeneration,
        probeId,
        views.readTerminalPermissionMode(view),
      );
      return;
    }
    view.permissionModeProbes.push({
      probeId,
      ptyGeneration,
      requiredRevision: view.outputPump.acceptedRevision,
    });
  });
  // Main echoes its normalized request. A monotonically increasing revision rejects stale echoes.
  window.controlPanel.onTerminalSize((sessionId, ptyGeneration, resizeRevision, cols, rows) => {
    const view = state.terminalViews.get(sessionId);
    if (
      !view ||
      !io.ownsTerminalGeneration(sessionId, ptyGeneration, view) ||
      resizeRevision < view.resizeRevision ||
      resizeRevision < view.appliedResizeRevision
    ) {
      return;
    }
    view.appliedResizeRevision = resizeRevision;
    if (view.terminal.cols === cols && view.terminal.rows === rows) return;
    try {
      view.lastFitCols = cols;
      view.lastFitRows = rows;
      view.terminal.resize(cols, rows);
    } catch {
      // A resize can race with the terminal being disposed.
    }
  });
};
