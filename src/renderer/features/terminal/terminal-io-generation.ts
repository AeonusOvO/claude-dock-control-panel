import type { PtyGeneration, TerminalStatus } from '../../../shared/contracts';
import type { TerminalIoDependencies } from './terminal-io-dependencies';
import type { TerminalContextMenuTarget, TerminalState, TerminalView } from './state';

export interface TerminalIoGenerationActions {
  copyTerminalSelectionGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => Promise<void>;
  ownsTerminalGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => boolean;
  pasteIntoActiveTerminal: () => Promise<void>;
  pasteIntoTerminalContextMenuTarget: (target: TerminalContextMenuTarget) => Promise<void>;
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

  const pasteIntoOwnedTerminalGeneration = async (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
    ownsPaste: () => boolean,
  ): Promise<void> => {
    if (!ownsPaste() || !writableTerminalGeneration(sessionId, ptyGeneration, view)) {
      return;
    }
    const text = await window.controlPanel.readClipboardText();
    if (!ownsPaste() || !writableTerminalGeneration(sessionId, ptyGeneration, view)) {
      return;
    }
    if (text) {
      view.terminal.paste(text);
    }
    if (ownsPaste() && writableTerminalGeneration(sessionId, ptyGeneration, view)) {
      view.terminal.focus();
    }
  };

  const pasteIntoTerminalGeneration = (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ): Promise<void> => pasteIntoOwnedTerminalGeneration(sessionId, ptyGeneration, view, () => true);

  const pasteIntoTerminalContextMenuTarget = (target: TerminalContextMenuTarget): Promise<void> =>
    pasteIntoOwnedTerminalGeneration(
      target.sessionId,
      target.ptyGeneration,
      target.view,
      () => state.terminalContextMenuRevision === target.menuRevision,
    );

  const pasteIntoActiveTerminal = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    const view = status ? terminalViewForStatus(status) : undefined;
    if (!status || status.phase !== 'running' || !view) {
      return;
    }
    await pasteIntoTerminalGeneration(status.id, status.ptyGeneration, view);
  };

  const copyTerminalSelectionGeneration = async (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ): Promise<void> => {
    if (!ownsTerminalGeneration(sessionId, ptyGeneration, view) || !view.terminal.hasSelection()) {
      return;
    }
    const selection = view.terminal.getSelection();
    await window.controlPanel.writeClipboardText(selection);
    if (ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
      view.terminal.focus();
    }
  };

  return {
    copyTerminalSelectionGeneration,
    ownsTerminalGeneration,
    pasteIntoActiveTerminal,
    pasteIntoTerminalContextMenuTarget,
    pasteIntoTerminalGeneration,
    terminalStatusForSession,
    terminalViewForStatus,
    writeToTerminalGeneration,
    writableTerminalGeneration,
  };
};
