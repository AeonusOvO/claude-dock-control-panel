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
  const fitTerminalsToViewport = (): TerminalFitResult => {
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
      // Every tab occupies this same viewport and uses the same font. Measure its visible xterm
      // once, then synchronize all generations, including background launches/history restores.
      let changed = false;
      for (const [targetSessionId, target] of state.terminalViews) {
        if (!io.ownsTerminalGeneration(targetSessionId, target.ptyGeneration, target)) continue;
        if (
          target.lastFitCols === proposed.cols &&
          target.lastFitRows === proposed.rows &&
          target.terminal.cols === proposed.cols &&
          target.terminal.rows === proposed.rows
        )
          continue;
        target.terminal.resize(proposed.cols, proposed.rows);
        target.lastFitCols = proposed.cols;
        target.lastFitRows = proposed.rows;
        window.controlPanel.resizeTerminal(
          targetSessionId,
          target.ptyGeneration,
          ++target.resizeRevision,
          proposed.cols,
          proposed.rows,
        );
        changed = true;
      }
      return changed ? 'changed' : 'stable';
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

      const result = fitTerminalsToViewport();
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
    fitTerminalsToViewport();
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
