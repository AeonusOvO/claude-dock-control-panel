import type { TerminalElements } from './elements';
import type { TerminalIoDependencies } from './terminal-io-dependencies';
import type { TerminalState } from './state';

export interface TerminalIoMenuActions {
  hideTerminalContextMenu: () => void;
  showTerminalContextMenu: (event: MouseEvent) => void;
}

export const createTerminalIoMenuActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalIoDependencies,
): TerminalIoMenuActions => {
  const hideTerminalContextMenu = (): void => {
    elements.terminalContextMenu.hidden = true;
  };

  const showTerminalContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    dependencies.hideConversationContextMenu();
    const terminal = state.terminalViews.get(
      dependencies.getWorkspaceState().activeSessionId,
    )?.terminal;
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
