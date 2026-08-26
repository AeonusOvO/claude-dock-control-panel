import type {
  ClaudeLaunchMode,
  ClaudeLaunchOutcome,
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeRelaunchInput,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';
import type { ClaudeLaunchAttemptToken } from '../../platform/claude-launch-attempt';
import { ClaudeLaunchPreflightDecisionController } from '../../platform/claude-launch-preflight-decision';
import { createRegistryToken, type Registry } from '../../platform/registry';
import { createTerminalActions, type TerminalActionsDependencies } from './actions';
import { createTerminalElements } from './elements';
import { createTerminalIo, type TerminalIoDependencies } from './terminal-io';
import { createTerminalLayout, type TerminalLayoutDependencies } from './terminal-layout';
import { createTerminalViews, type TerminalViewsDependencies } from './terminal-views';
import { createTerminalState, type TerminalView } from './state';

export type TerminalFeatureDependencies = Omit<
  TerminalIoDependencies,
  'focusComposer' | 'resolveClaudeLaunchDecision'
> &
  TerminalViewsDependencies &
  TerminalLayoutDependencies &
  Omit<TerminalActionsDependencies, 'resolveClaudeLaunchDecision'>;

export interface TerminalFeature {
  beginTerminalMask: (sessionId: string, label: string) => () => void;
  beginWorkspaceTerminalPreview: (label: string) => () => void;
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
  launchClaudeSession: (
    sessionId: string,
    mode: ClaudeLaunchMode,
    announce?: boolean,
  ) => Promise<boolean>;
  panelResizer: HTMLElement;
  playSendAnimation: (
    text: string,
    source?: HTMLTextAreaElement,
    variant?: 'terminal' | 'chat',
  ) => void;
  pruneTerminalControlOperations: (validSessionIds: ReadonlySet<string>) => void;
  relaunchClaudeSession: (
    summary: string,
    input: Omit<ClaudeRelaunchInput, 'compactFirst'>,
  ) => Promise<void>;
  reconcileClaudeLaunchDecision: (workspace: WorkspaceState) => void;
  renderControlStatus: (status?: TerminalStatus) => void;
  resolveClaudeLaunchDecision: (
    token: ClaudeLaunchAttemptToken,
    paused: Extract<ClaudeLaunchOutcome, { status: 'paused' }>,
  ) => Promise<Exclude<ClaudeLaunchPreflightDecisionOutcome, { status: 'paused' }>>;
  requestComposerFocus: (sessionId?: string) => void;
  resizeComposer: () => void;
  retryTerminalFitUntilMeasured: () => void;
  setComposerEnabled: (enabled: boolean) => void;
  setPendingComposerFocusSessionId: (sessionId: string) => void;
  showTerminalDiagnostic: (status: TerminalStatus) => void;
  startTerminal: (status: TerminalStatus) => Promise<void>;
  terminalContextMenu: HTMLElement;
}

export const TERMINAL_FEATURE = createRegistryToken<TerminalFeature>('renderer.feature.terminal');

const createTerminalFeature = (dependencies: TerminalFeatureDependencies): TerminalFeature => {
  const elements = createTerminalElements();
  const state = createTerminalState();
  const launchDecisionController = new ClaudeLaunchPreflightDecisionController({
    launchAttempts: dependencies.claudeLaunchAttempts,
    refreshLaunchControls: dependencies.refreshClaudeLaunchControls,
  });
  const decisionAwareDependencies = {
    ...dependencies,
    resolveClaudeLaunchDecision: (
      token: Parameters<typeof launchDecisionController.present>[0],
      paused: Parameters<typeof launchDecisionController.present>[1],
    ) => launchDecisionController.present(token, paused),
  };

  const io = createTerminalIo(state, elements, {
    ...decisionAwareDependencies,
    focusComposer: () => layout.focusComposer(),
  });

  const views = createTerminalViews(state, elements, decisionAwareDependencies, io);

  const layout = createTerminalLayout(state, elements, decisionAwareDependencies, io, views);

  const actions = createTerminalActions(
    state,
    elements,
    decisionAwareDependencies,
    io,
    views,
    layout,
  );

  return {
    beginTerminalMask: io.beginTerminalMask,
    beginWorkspaceTerminalPreview: io.beginWorkspaceTerminalPreview,
    cancelActiveResizes: layout.cancelActiveResizes,
    dispose: () => {
      launchDecisionController.dispose();
      state.workspaceTerminalPreviewState?.overlay.remove();
      state.workspaceTerminalPreviews.clear();
      state.workspaceTerminalPreviewState = undefined;
      document.body.dataset.workspaceTerminalPreview = 'idle';
      actions.dispose();
    },
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
    launchClaudeSession: actions.launchClaudeSession,
    panelResizer: elements.panelResizer,
    playSendAnimation: layout.playSendAnimation,
    pruneTerminalControlOperations: (validSessionIds) => {
      state.terminalControlOperations.prune(validSessionIds);
    },
    relaunchClaudeSession: io.relaunchClaudeSession,
    reconcileClaudeLaunchDecision: (workspace) =>
      launchDecisionController.reconcileWorkspace(workspace),
    renderControlStatus: actions.renderControlStatus,
    resolveClaudeLaunchDecision: (token, paused) => launchDecisionController.present(token, paused),
    requestComposerFocus: layout.requestComposerFocus,
    resizeComposer: layout.resizeComposer,
    retryTerminalFitUntilMeasured: views.retryTerminalFitUntilMeasured,
    setComposerEnabled: layout.setComposerEnabled,
    setPendingComposerFocusSessionId: (sessionId) => {
      state.pendingComposerFocusSessionId = sessionId;
    },
    showTerminalDiagnostic: actions.showTerminalDiagnostic,
    startTerminal: actions.startTerminal,
    terminalContextMenu: elements.terminalContextMenu,
  };
};

export const registerTerminalFeature = (
  registry: Registry,
  dependencies: TerminalFeatureDependencies,
): void => {
  registry.register(TERMINAL_FEATURE, () => createTerminalFeature(dependencies));
};
