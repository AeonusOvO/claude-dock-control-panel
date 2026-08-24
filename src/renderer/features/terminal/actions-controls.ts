import type { OperationResult, TerminalStatus } from '../../../shared/contracts';
import type { TerminalActionsDependencies } from './actions-dependencies';
import type { TerminalElements } from './elements';
import type { TerminalIo } from './terminal-io';
import type { TerminalLayout } from './terminal-layout';
import type { TerminalViews } from './terminal-views';
import type { TerminalControlOperation, TerminalState } from './state';

export interface TerminalControlActions {
  renderControlStatus: (status?: TerminalStatus) => void;
  startTerminal: (status: TerminalStatus) => Promise<void>;
}

export const createTerminalControlActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalActionsDependencies,
  io: TerminalIo,
  views: TerminalViews,
  layout: TerminalLayout,
): TerminalControlActions => {
  const renderControlStatus = (status = dependencies.activeStatus()): void => {
    const operation = status ? state.terminalControlOperations.current(status.id) : undefined;
    const busy = Boolean(operation);
    const starting =
      operation?.operation === 'start' || (!operation && status?.phase === 'starting');
    const unavailable = !status || status.phase === 'starting';

    elements.restartButton.disabled = unavailable || busy;
    elements.restartButton.setAttribute('aria-busy', String(operation?.operation === 'restart'));
    elements.restartLabel.textContent = operation?.operation === 'restart' ? '正在重启…' : '重启';

    elements.toggleButton.disabled = unavailable || busy;
    elements.toggleButton.setAttribute(
      'aria-busy',
      String(starting || operation?.operation === 'stop'),
    );
    elements.toggleLabel.textContent = starting
      ? '正在启动…'
      : operation?.operation === 'stop'
        ? '正在停止…'
        : status?.phase === 'running'
          ? '停止'
          : '启动';
  };

  const runControlOperation = async (
    status: TerminalStatus,
    operationKind: TerminalControlOperation,
    operation: () => Promise<OperationResult>,
    successMessage: string,
    focusAfterSuccess: boolean,
  ): Promise<void> => {
    if (state.terminalControlOperations.isActive(status.id)) {
      return;
    }
    const token = state.terminalControlOperations.begin(status.id, operationKind);
    renderControlStatus(status);
    try {
      const result = await operation();
      if (!state.terminalControlOperations.isCurrent(token)) {
        return;
      }
      if (dependencies.handleOperation(result, successMessage) && focusAfterSuccess) {
        views.retryTerminalFitUntilMeasured();
        layout.requestComposerFocus(status.id);
      }
    } catch {
      if (state.terminalControlOperations.isCurrent(token)) {
        dependencies.showToast('终端操作无法完成。', 'error');
      }
    } finally {
      if (state.terminalControlOperations.finish(token)) {
        renderControlStatus();
      }
    }
  };

  const startTerminal = (status: TerminalStatus): Promise<void> =>
    runControlOperation(
      status,
      'start',
      () => window.controlPanel.startTerminal(status.id, status.ptyGeneration),
      '终端已启动',
      true,
    );

  elements.restartButton.addEventListener('click', () => {
    const status = dependencies.activeStatus();
    if (!status) {
      return;
    }
    void runControlOperation(
      status,
      'restart',
      () => window.controlPanel.restartTerminal(status.id, status.ptyGeneration),
      '终端已重启',
      true,
    );
  });
  elements.toggleButton.addEventListener('click', () => {
    const status = dependencies.activeStatus();
    if (!status) {
      return;
    }
    if (status.phase === 'running') {
      void runControlOperation(
        status,
        'stop',
        () => window.controlPanel.stopTerminal(status.id, status.ptyGeneration),
        '终端已停止',
        false,
      );
      return;
    }
    void startTerminal(status);
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
      const target = state.terminalContextMenuTarget;
      if (
        !target ||
        !io.ownsTerminalGeneration(target.sessionId, target.ptyGeneration, target.view)
      ) {
        io.hideTerminalContextMenu();
        return;
      }
      switch (button.dataset.terminalContextAction) {
        case 'copy':
          void io.copyTerminalSelectionGeneration(
            target.sessionId,
            target.ptyGeneration,
            target.view,
          );
          break;
        case 'paste':
          void io.pasteIntoTerminalContextMenuTarget(target);
          break;
        case 'select-all':
          target.view.terminal.selectAll();
          target.view.terminal.focus();
          break;
        case 'clear':
          target.view.terminal.clear();
          target.view.terminal.focus();
          break;
      }
      io.hideTerminalContextMenu();
    });
  }

  return { renderControlStatus, startTerminal };
};
