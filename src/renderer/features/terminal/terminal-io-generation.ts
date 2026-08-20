import type { PtyGeneration, TerminalStatus } from '../../../shared/contracts';
import type { TerminalIoDependencies } from './terminal-io-dependencies';
import type { TerminalState, TerminalView } from './state';

export interface TerminalIoGenerationActions {
  copyActiveTerminalSelection: () => Promise<void>;
  ownsTerminalGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => boolean;
  pasteIntoActiveTerminal: () => Promise<void>;
  pasteIntoTerminalGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => Promise<void>;
  terminalStatusForSession: (sessionId: string) => TerminalStatus | undefined;
  terminalViewForStatus: (status: TerminalStatus) => TerminalView | undefined;
  writeToTerminalGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
    data: string,
  ) => boolean;
  writableTerminalGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => boolean;
}

export const createTerminalIoGenerationActions = (
  state: TerminalState,
  dependencies: TerminalIoDependencies,
): TerminalIoGenerationActions => {
  const terminalStatusForSession = (sessionId: string): TerminalStatus | undefined =>
    dependencies.getWorkspaceState().sessions.find((status) => status.id === sessionId);

  /**
   * An xterm instance is an ownership token for one exact PTY generation. Checking both map identity
   * and workspace status prevents an old event closure from targeting a replacement view or PTY.
   */
  const ownsTerminalGeneration = (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ): boolean => {
    const status = terminalStatusForSession(sessionId);
    return (
      state.terminalViews.get(sessionId) === view &&
      view.ptyGeneration === ptyGeneration &&
      status?.ptyGeneration === ptyGeneration
    );
  };

  const writableTerminalGeneration = (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ): boolean =>
    ownsTerminalGeneration(sessionId, ptyGeneration, view) &&
    terminalStatusForSession(sessionId)?.phase === 'running';

  const terminalViewForStatus = (status: TerminalStatus): TerminalView | undefined => {
    const view = state.terminalViews.get(status.id);
    return view && ownsTerminalGeneration(status.id, status.ptyGeneration, view) ? view : undefined;
  };

  const writeToTerminalGeneration = (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
    data: string,
  ): boolean => {
    if (!writableTerminalGeneration(sessionId, ptyGeneration, view)) {
      return false;
    }
    window.controlPanel.writeTerminal(sessionId, ptyGeneration, data);
    return true;
  };

  const pasteIntoTerminalGeneration = async (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ): Promise<void> => {
    if (!writableTerminalGeneration(sessionId, ptyGeneration, view)) {
      return;
    }
    const text = await window.controlPanel.readClipboardText();
    if (!writableTerminalGeneration(sessionId, ptyGeneration, view)) {
      return;
    }
    if (text) {
      writeToTerminalGeneration(sessionId, ptyGeneration, view, text.replace(/\r?\n/g, '\r'));
    }
    if (writableTerminalGeneration(sessionId, ptyGeneration, view)) {
      view.terminal.focus();
    }
  };

  const pasteIntoActiveTerminal = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    const view = status ? terminalViewForStatus(status) : undefined;
    if (!status || status.phase !== 'running' || !view) {
      return;
    }
    await pasteIntoTerminalGeneration(status.id, status.ptyGeneration, view);
  };

  const copyActiveTerminalSelection = async (): Promise<void> => {
    const terminal = state.terminalViews.get(
      dependencies.getWorkspaceState().activeSessionId,
    )?.terminal;
    if (terminal?.hasSelection()) {
      await window.controlPanel.writeClipboardText(terminal.getSelection());
    }
    terminal?.focus();
  };

  return {
    copyActiveTerminalSelection,
    ownsTerminalGeneration,
    pasteIntoActiveTerminal,
    pasteIntoTerminalGeneration,
    terminalStatusForSession,
    terminalViewForStatus,
    writeToTerminalGeneration,
    writableTerminalGeneration,
  };
};
