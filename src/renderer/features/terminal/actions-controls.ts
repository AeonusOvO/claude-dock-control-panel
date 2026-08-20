import type { TerminalActionsDependencies } from './actions-dependencies';
import type { TerminalElements } from './elements';
import type { TerminalIo } from './terminal-io';
import type { TerminalLayout } from './terminal-layout';
import type { TerminalViews } from './terminal-views';
import type { TerminalState } from './state';

export const bindTerminalControlActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalActionsDependencies,
  io: TerminalIo,
  views: TerminalViews,
  layout: TerminalLayout,
): void => {
  elements.restartButton.addEventListener('click', async () => {
    const status = dependencies.activeStatus();
    if (!status) {
      return;
    }
    const result = await window.controlPanel.restartTerminal(status.id, status.ptyGeneration);
    if (dependencies.handleOperation(result, result.ok ? '终端已重启' : undefined)) {
      views.retryTerminalFitUntilMeasured();
      layout.requestComposerFocus(status.id);
    }
  });
  elements.toggleButton.addEventListener('click', async () => {
    const status = dependencies.activeStatus();
    if (!status) {
      return;
    }

    if (status.phase === 'running') {
      dependencies.handleOperation(
        await window.controlPanel.stopTerminal(status.id, status.ptyGeneration),
        '终端已停止',
      );
    } else {
      const result = await window.controlPanel.startTerminal(status.id, status.ptyGeneration);
      if (dependencies.handleOperation(result, '终端已启动')) {
        views.retryTerminalFitUntilMeasured();
        layout.requestComposerFocus(status.id);
      }
    }
  });
  elements.clearTerminalButton.addEventListener('click', () => {
    const view = state.terminalViews.get(dependencies.getWorkspaceState().activeSessionId);
    view?.terminal.clear();
    view?.terminal.focus();
  });
  for (const button of elements.terminalContextMenu.querySelectorAll<HTMLButtonElement>(
    '[data-terminal-context-action]',
  )) {
    button.addEventListener('click', () => {
      const terminal = state.terminalViews.get(
        dependencies.getWorkspaceState().activeSessionId,
      )?.terminal;
      switch (button.dataset.terminalContextAction) {
        case 'copy':
          void io.copyActiveTerminalSelection();
          break;
        case 'paste':
          void io.pasteIntoActiveTerminal();
          break;
        case 'select-all':
          terminal?.selectAll();
          terminal?.focus();
          break;
        case 'clear':
          terminal?.clear();
          terminal?.focus();
          break;
      }
      io.hideTerminalContextMenu();
    });
  }
};
