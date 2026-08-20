import type { TerminalIo } from './terminal-io';
import type { TerminalState } from './state';
import type { TerminalFitResult, TerminalViewsDependencies } from './terminal-views-dependencies';

export interface TerminalViewFitActions {
  debounceTerminalFit: () => void;
  retryTerminalFitUntilMeasured: () => void;
}

export const createTerminalViewFitActions = (
  state: TerminalState,
  dependencies: TerminalViewsDependencies,
  io: TerminalIo,
): TerminalViewFitActions => {
  const fitActiveTerminal = (): TerminalFitResult => {
    const sessionId = dependencies.getWorkspaceState().activeSessionId;
    const view = state.terminalViews.get(sessionId);
    if (!view) {
      return 'unavailable';
    }
    const ptyGeneration = view.ptyGeneration;
    const bounds = view.container.getBoundingClientRect();
    if (
      !io.ownsTerminalGeneration(sessionId, ptyGeneration, view) ||
      !view.container.isConnected ||
      !view.container.classList.contains('project-terminal--active') ||
      bounds.width < 1 ||
      bounds.height < 1
    ) {
      return 'unavailable';
    }

    try {
      const proposed = view.fitAddon.proposeDimensions();
      if (!proposed || proposed.cols < 2 || proposed.rows < 1) return 'unavailable';
      if (!io.ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
        return 'unavailable';
      }
      if (view.lastFitCols === proposed.cols && view.lastFitRows === proposed.rows) return 'stable';
      view.lastFitCols = proposed.cols;
      view.lastFitRows = proposed.rows;
      view.terminal.resize(proposed.cols, proposed.rows);
      const resizeRevision = ++view.resizeRevision;
      window.controlPanel.resizeTerminal(
        sessionId,
        ptyGeneration,
        resizeRevision,
        proposed.cols,
        proposed.rows,
      );
      return 'changed';
    } catch {
      // A resize can race with initial layout; the bounded frame scheduler will retry.
      return 'unavailable';
    }
  };

  /*
   * xterm must measure character cells after its active container is visible. A single fixed timeout
   * is unreliable on a cold start, after a GPU reset, or when the window comes back from the tray.
   * Re-fitting over a few paint frames lets CSS layout and xterm's own observers settle without
   * leaving an unbounded timer running.
   */
  const retryTerminalFitUntilMeasured = (): void => {
    const expectedSessionId = dependencies.getWorkspaceState().activeSessionId;
    const generation = ++state.terminalFitGeneration;
    let attemptsRemaining = 4;

    const fitOnNextFrame = (): void => {
      if (
        generation !== state.terminalFitGeneration ||
        dependencies.getWorkspaceState().activeSessionId !== expectedSessionId ||
        !expectedSessionId
      ) {
        return;
      }

      const result = fitActiveTerminal();
      if (result === 'stable') return;
      attemptsRemaining -= 1;
      if (attemptsRemaining > 0) {
        window.requestAnimationFrame(fitOnNextFrame);
      }
    };

    window.requestAnimationFrame(fitOnNextFrame);
  };

  const flushTerminalFitFrame = (): void => {
    state.terminalFitFrame = undefined;
    if (!state.terminalFitDirty) return;
    state.terminalFitDirty = false;
    fitActiveTerminal();
    if (state.terminalFitDirty && state.terminalFitFrame === undefined) {
      state.terminalFitFrame = window.requestAnimationFrame(flushTerminalFitFrame);
    }
  };

  const debounceTerminalFit = (): void => {
    state.terminalFitDirty = true;
    if (state.terminalFitFrame === undefined) {
      state.terminalFitFrame = window.requestAnimationFrame(flushTerminalFitFrame);
    }
  };

  return { debounceTerminalFit, retryTerminalFitUntilMeasured };
};
