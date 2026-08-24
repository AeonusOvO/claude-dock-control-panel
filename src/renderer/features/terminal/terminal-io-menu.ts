import type { PtyGeneration } from '../../../shared/contracts';
import type { TerminalElements } from './elements';
import type { TerminalIoDependencies } from './terminal-io-dependencies';
import type { TerminalState, TerminalView } from './state';

export interface TerminalIoMenuActions {
  hideTerminalContextMenu: () => void;
  showTerminalContextMenu: (
    event: MouseEvent,
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => void;
}

export const createTerminalIoMenuActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalIoDependencies,
): TerminalIoMenuActions => {
  const hideTerminalContextMenu = (): void => {
    elements.terminalContextMenu.hidden = true;
    state.terminalContextMenuTarget = undefined;
  };

  const showTerminalContextMenu = (
    event: MouseEvent,
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    dependencies.hideConversationContextMenu();
    const status = dependencies
      .getWorkspaceState()
      .sessions.find((candidate) => candidate.id === sessionId);
    if (
      state.terminalViews.get(sessionId) !== view ||
      view.ptyGeneration !== ptyGeneration ||
      status?.ptyGeneration !== ptyGeneration
    ) {
      hideTerminalContextMenu();
      return;
    }
    state.terminalContextMenuRevision += 1;
    state.terminalContextMenuTarget = {
      menuRevision: state.terminalContextMenuRevision,
      ptyGeneration,
      sessionId,
      view,
    };
    const terminal = view.terminal;
    const copy = elements.terminalContextMenu.querySelector<HTMLButtonElement>(
      '[data-terminal-context-action="copy"]',
    );
    if (copy) {
      copy.disabled = !terminal?.hasSelection();
    }
    elements.terminalContextMenu.hidden = false;
    const menuRect = elements.terminalContextMenu.getBoundingClientRect();
    elements.terminalContextMenu.style.left = `${Math.max(
      8,
      Math.min(event.clientX, window.innerWidth - menuRect.width - 8),
    )}px`;
    elements.terminalContextMenu.style.top = `${Math.max(
      56,
      Math.min(event.clientY, window.innerHeight - menuRect.height - 8),
    )}px`;
    elements.terminalContextMenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };

  return { hideTerminalContextMenu, showTerminalContextMenu };
};
