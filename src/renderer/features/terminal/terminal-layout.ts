import type { TerminalElements } from './elements';
import { createTerminalLayoutComposerActions } from './terminal-layout-composer';
import { bindTerminalComposerSubmitActions } from './terminal-layout-composer-submit';
import { createTerminalLayoutResizerActions } from './terminal-layout-resizer';
import type { TerminalIo } from './terminal-io';
import type { TerminalViews } from './terminal-views';
import type { TerminalState } from './state';

export type { TerminalLayoutDependencies } from './terminal-layout-dependencies';
import type { TerminalLayoutDependencies } from './terminal-layout-dependencies';

export interface TerminalLayout {
  appendDroppedPaths: (paths: readonly string[]) => boolean;
  cancelActiveResizes: () => void;
  focusComposer: () => boolean;
  flushPendingComposerFocus: () => void;
  getComposerInput: () => HTMLTextAreaElement;
  playSendAnimation: (
    text: string,
    source?: HTMLTextAreaElement,
    variant?: 'terminal' | 'chat',
  ) => void;
  requestComposerFocus: (sessionId?: string) => void;
  resizeComposer: () => void;
  setComposerEnabled: (enabled: boolean) => void;
}

export const createTerminalLayout = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalLayoutDependencies,
  io: TerminalIo,
  views: TerminalViews,
): TerminalLayout => {
  const composerActions = createTerminalLayoutComposerActions(state, elements, dependencies);
  bindTerminalComposerSubmitActions(elements, dependencies, io, composerActions);
  const resizerActions = createTerminalLayoutResizerActions(elements, dependencies, views);

  return {
    appendDroppedPaths: composerActions.appendDroppedPaths,
    cancelActiveResizes: resizerActions.cancelActiveResizes,
    focusComposer: composerActions.focusComposer,
    flushPendingComposerFocus: composerActions.flushPendingComposerFocus,
    getComposerInput: () => elements.composerInput,
    playSendAnimation: composerActions.playSendAnimation,
    requestComposerFocus: composerActions.requestComposerFocus,
    resizeComposer: composerActions.resizeComposer,
    setComposerEnabled: composerActions.setComposerEnabled,
  };
};
