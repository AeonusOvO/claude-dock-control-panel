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
  hideTerminalContextMenu: () => void,
): TerminalViewLifecycleActions => {
  const disposeTerminalViewInternal = (
    sessionId: string,
    view: TerminalView,
    preserveMask: boolean,
  ): void => {
    if (state.terminalContextMenuTarget?.view === view) {
      hideTerminalContextMenu();
    }
    if (state.terminalViews.get(sessionId) === view) {
      state.terminalViews.delete(sessionId);
    }
    view.outputPump.dispose();
    rejectPermissionModeProbes(sessionId, view);
    const mask = state.terminalMasks.get(sessionId);
    if (!preserveMask && mask?.view === view) {
      mask.overlay.remove();
      state.terminalMasks.delete(sessionId);
    }
    view.disposeInteractionListeners();
    view.terminal.dispose();
    view.container.remove();
  };

  const disposeTerminalView = (sessionId: string, view: TerminalView): void => {
    disposeTerminalViewInternal(sessionId, view, false);
  };

  const ensureTerminalView = (status: TerminalStatus, active: boolean): TerminalView => {
    const existing = state.terminalViews.get(status.id);
    if (existing?.ptyGeneration === status.ptyGeneration) {
      const overlay = state.terminalMasks.get(status.id)?.overlay;
      overlay?.classList.toggle('terminal-mask--active', active);
      overlay?.classList.toggle('terminal-mask--inactive', !active);
      return existing;
    }
    const mask = state.terminalMasks.get(status.id);
    if (existing) {
      disposeTerminalViewInternal(status.id, existing, Boolean(mask));
    }
    const created = createTerminalView(status, active);
    if (mask) {
      mask.view = created;
      created.container.inert = true;
      mask.overlay.classList.toggle('terminal-mask--active', active);
      mask.overlay.classList.toggle('terminal-mask--inactive', !active);
    }
    return created;
  };

  return { disposeTerminalView, ensureTerminalView };
};
