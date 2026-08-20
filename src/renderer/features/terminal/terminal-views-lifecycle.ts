import type { TerminalStatus } from '../../../shared/contracts';
import type { TerminalState, TerminalView } from './state';

export interface TerminalViewLifecycleActions {
  disposeTerminalView: (sessionId: string, view: TerminalView) => void;
  ensureTerminalView: (status: TerminalStatus, active: boolean) => TerminalView;
}

export const createTerminalViewLifecycleActions = (
  state: TerminalState,
  createTerminalView: (status: TerminalStatus, active: boolean) => TerminalView,
  rejectPermissionModeProbes: (sessionId: string, view: TerminalView) => void,
): TerminalViewLifecycleActions => {
  const disposeTerminalView = (sessionId: string, view: TerminalView): void => {
    if (state.terminalViews.get(sessionId) === view) {
      state.terminalViews.delete(sessionId);
    }
    view.outputPump.dispose();
    rejectPermissionModeProbes(sessionId, view);
    const mask = state.terminalMasks.get(sessionId);
    if (mask?.view === view) {
      mask.overlay.remove();
      state.terminalMasks.delete(sessionId);
    }
    view.terminal.dispose();
    view.container.remove();
  };

  const ensureTerminalView = (status: TerminalStatus, active: boolean): TerminalView => {
    const existing = state.terminalViews.get(status.id);
    if (existing?.ptyGeneration === status.ptyGeneration) {
      return existing;
    }
    if (existing) {
      disposeTerminalView(status.id, existing);
    }
    return createTerminalView(status, active);
  };

  return { disposeTerminalView, ensureTerminalView };
};
