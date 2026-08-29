import type { ClaudeLaunchMode, TerminalStatus } from '../../../shared/contracts';
import { createTerminalControlActions } from './actions-controls';
import { createTerminalDiagnosticActions } from './actions-diagnostic';
import { bindTerminalIpcListeners } from './actions-ipc';
import { createTerminalLaunchActions, type ClaudeLaunchProgressListener } from './actions-launch';
import type { TerminalElements } from './elements';
import type { TerminalIo } from './terminal-io';
import type { TerminalLayout } from './terminal-layout';
import type { TerminalViews } from './terminal-views';
import type { TerminalState } from './state';

export type { TerminalActionsDependencies } from './actions-dependencies';
import type { TerminalActionsDependencies } from './actions-dependencies';

export interface TerminalActions {
  dispose: () => void;
  launchClaudeSession: (
    sessionId: string,
    mode: ClaudeLaunchMode,
    announce?: boolean,
    onProgress?: ClaudeLaunchProgressListener,
  ) => Promise<boolean>;
  launchClaudeTerminal: (mode: ClaudeLaunchMode) => Promise<void>;
  renderControlStatus: (status?: TerminalStatus) => void;
  showTerminalDiagnostic: (status: TerminalStatus) => void;
  startTerminal: (status: TerminalStatus) => Promise<void>;
}

export const createTerminalActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalActionsDependencies,
  io: TerminalIo,
  views: TerminalViews,
  layout: TerminalLayout,
): TerminalActions => {
  const diagnosticActions = createTerminalDiagnosticActions(state, elements, dependencies, views);
  const launchActions = createTerminalLaunchActions(state, layout, dependencies);
  const controlActions = createTerminalControlActions(
    state,
    elements,
    dependencies,
    io,
    views,
    layout,
  );
  bindTerminalIpcListeners(state, io, views);

  let observedTerminalWidth = -1;
  let observedTerminalHeight = -1;
  const resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) {
      return;
    }
    const width = Math.round(entry.contentRect.width);
    const height = Math.round(entry.contentRect.height);
    if (width === observedTerminalWidth && height === observedTerminalHeight) {
      return;
    }
    observedTerminalWidth = width;
    observedTerminalHeight = height;
    views.debounceTerminalFit();
  });
  resizeObserver.observe(elements.terminalStage);

  const dispose = (): void => {
    layout.cancelActiveResizes();
    state.terminalFitGeneration += 1;
    if (state.terminalFitFrame !== undefined) {
      window.cancelAnimationFrame(state.terminalFitFrame);
    }
    resizeObserver.disconnect();
    for (const [sessionId, view] of [...state.terminalViews]) {
      views.disposeTerminalView(sessionId, view);
    }
    state.terminalMasks.clear();
  };

  return {
    dispose,
    launchClaudeSession: launchActions.launchClaudeSession,
    launchClaudeTerminal: launchActions.launchClaudeTerminal,
    renderControlStatus: controlActions.renderControlStatus,
    showTerminalDiagnostic: diagnosticActions.showTerminalDiagnostic,
    startTerminal: controlActions.startTerminal,
  };
};
