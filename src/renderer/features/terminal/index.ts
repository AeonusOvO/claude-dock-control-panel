import type {
  ClaudeLaunchMode,
  ClaudeRelaunchInput,
  TerminalStatus,
} from '../../../shared/contracts';
import { createRegistryToken, type Registry } from '../../platform/registry';
import { createTerminalActions, type TerminalActionsDependencies } from './actions';
import { createTerminalElements } from './elements';
import { createTerminalIo, type TerminalIoDependencies } from './terminal-io';
import { createTerminalLayout, type TerminalLayoutDependencies } from './terminal-layout';
import { createTerminalViews, type TerminalViewsDependencies } from './terminal-views';
import { createTerminalState, type TerminalView } from './state';

export type TerminalFeatureDependencies = Omit<TerminalIoDependencies, 'focusComposer'> &
  TerminalViewsDependencies &
  TerminalLayoutDependencies &
  TerminalActionsDependencies;

export interface TerminalFeature {
  beginTerminalMask: (sessionId: string, label: string) => () => void;
  cancelActiveResizes: () => void;
  dispose: () => void;
  disposeTerminalView: (sessionId: string, view: TerminalView) => void;
  ensureTerminalView: (status: TerminalStatus, active: boolean) => TerminalView;
  flushPendingComposerFocus: () => void;
  focusActiveTerminal: () => void;
  focusComposer: () => boolean;
  getComposerInput: () => HTMLTextAreaElement;
  getPendingComposerFocusSessionId: () => string;
  getTerminalView: (sessionId: string) => TerminalView | undefined;
  getTerminalViews: () => Map<string, TerminalView>;
  hideTerminalContextMenu: () => void;
  launchClaudeTerminal: (mode: ClaudeLaunchMode) => Promise<void>;
  panelResizer: HTMLElement;
  playSendAnimation: (
    text: string,
    source?: HTMLTextAreaElement,
    variant?: 'terminal' | 'chat',
  ) => void;
  relaunchClaudeSession: (
    summary: string,
    input: Omit<ClaudeRelaunchInput, 'compactFirst'>,
  ) => Promise<void>;
  requestComposerFocus: (sessionId?: string) => void;
  resizeComposer: () => void;
  retryTerminalFitUntilMeasured: () => void;
  setComposerEnabled: (enabled: boolean) => void;
  setPendingComposerFocusSessionId: (sessionId: string) => void;
  showTerminalDiagnostic: (status: TerminalStatus) => void;
  terminalContextMenu: HTMLElement;
}

export const TERMINAL_FEATURE = createRegistryToken<TerminalFeature>('renderer.feature.terminal');

const createTerminalFeature = (dependencies: TerminalFeatureDependencies): TerminalFeature => {
  const elements = createTerminalElements();
  const state = createTerminalState();

  const io = createTerminalIo(state, elements, {
    ...dependencies,
    focusComposer: () => layout.focusComposer(),
  });

  const views = createTerminalViews(state, elements, dependencies, io);

  const layout = createTerminalLayout(state, elements, dependencies, io, views);

  const actions = createTerminalActions(state, elements, dependencies, io, views, layout);

  return {
    beginTerminalMask: io.beginTerminalMask,
    cancelActiveResizes: layout.cancelActiveResizes,
    dispose: actions.dispose,
    disposeTerminalView: views.disposeTerminalView,
    ensureTerminalView: views.ensureTerminalView,
    flushPendingComposerFocus: layout.flushPendingComposerFocus,
    focusActiveTerminal: () => {
      state.terminalViews.get(dependencies.getWorkspaceState().activeSessionId)?.terminal.focus();
    },
    focusComposer: layout.focusComposer,
    getComposerInput: layout.getComposerInput,
    getPendingComposerFocusSessionId: () => state.pendingComposerFocusSessionId,
    getTerminalView: (sessionId) => state.terminalViews.get(sessionId),
    getTerminalViews: () => state.terminalViews,
    hideTerminalContextMenu: io.hideTerminalContextMenu,
    launchClaudeTerminal: actions.launchClaudeTerminal,
    panelResizer: elements.panelResizer,
    playSendAnimation: layout.playSendAnimation,
    relaunchClaudeSession: io.relaunchClaudeSession,
    requestComposerFocus: layout.requestComposerFocus,
    resizeComposer: layout.resizeComposer,
    retryTerminalFitUntilMeasured: views.retryTerminalFitUntilMeasured,
    setComposerEnabled: layout.setComposerEnabled,
    setPendingComposerFocusSessionId: (sessionId) => {
      state.pendingComposerFocusSessionId = sessionId;
    },
    showTerminalDiagnostic: actions.showTerminalDiagnostic,
    terminalContextMenu: elements.terminalContextMenu,
  };
};

export const registerTerminalFeature = (
  registry: Registry,
  dependencies: TerminalFeatureDependencies,
): void => {
  registry.register(TERMINAL_FEATURE, () => createTerminalFeature(dependencies));
};
