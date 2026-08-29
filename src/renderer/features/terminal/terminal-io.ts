import type { ClaudeRelaunchInput, PtyGeneration, TerminalStatus } from '../../../shared/contracts';
import type { TerminalElements } from './elements';
import { createTerminalIoGenerationActions } from './terminal-io-generation';
import { createTerminalIoMaskActions } from './terminal-io-mask';
import { createTerminalIoMenuActions } from './terminal-io-menu';
import { createTerminalIoRelaunchActions } from './terminal-io-relaunch';
import type {
  TerminalContextMenuTarget,
  TerminalProgressHandle,
  TerminalState,
  TerminalView,
} from './state';

export type { TerminalIoDependencies } from './terminal-io-dependencies';
import type { TerminalIoDependencies } from './terminal-io-dependencies';

export interface TerminalIo {
  beginTerminalMask: (sessionId: string, label: string) => TerminalProgressHandle;
  beginWorkspaceTerminalPreview: (label: string) => TerminalProgressHandle;
  copyTerminalSelectionGeneration: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => Promise<void>;
  hideTerminalContextMenu: () => void;
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
  relaunchClaudeSession: (
    summary: string,
    input: Omit<ClaudeRelaunchInput, 'compactFirst'>,
  ) => Promise<void>;
  showTerminalContextMenu: (
    event: MouseEvent,
    sessionId: string,
    ptyGeneration: PtyGeneration,
    view: TerminalView,
  ) => void;
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

export const createTerminalIo = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalIoDependencies,
): TerminalIo => {
  const maskActions = createTerminalIoMaskActions(state, elements, dependencies);
  const relaunchActions = createTerminalIoRelaunchActions(
    dependencies,
    maskActions.beginTerminalMask,
  );
  const generationActions = createTerminalIoGenerationActions(state, dependencies);
  const menuActions = createTerminalIoMenuActions(state, elements, dependencies);

  return {
    beginTerminalMask: maskActions.beginTerminalMask,
    beginWorkspaceTerminalPreview: maskActions.beginWorkspaceTerminalPreview,
    copyTerminalSelectionGeneration: generationActions.copyTerminalSelectionGeneration,
    hideTerminalContextMenu: menuActions.hideTerminalContextMenu,
    ownsTerminalGeneration: generationActions.ownsTerminalGeneration,
    pasteIntoActiveTerminal: generationActions.pasteIntoActiveTerminal,
    pasteIntoTerminalContextMenuTarget: generationActions.pasteIntoTerminalContextMenuTarget,
    pasteIntoTerminalGeneration: generationActions.pasteIntoTerminalGeneration,
    relaunchClaudeSession: relaunchActions.relaunchClaudeSession,
    showTerminalContextMenu: menuActions.showTerminalContextMenu,
    terminalStatusForSession: generationActions.terminalStatusForSession,
    terminalViewForStatus: generationActions.terminalViewForStatus,
    writeToTerminalGeneration: generationActions.writeToTerminalGeneration,
    writableTerminalGeneration: generationActions.writableTerminalGeneration,
  };
};
