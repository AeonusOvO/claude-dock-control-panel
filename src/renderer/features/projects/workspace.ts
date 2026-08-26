import type {
  CodexProjectState,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  ClaudeProjectState,
  RuntimeActivitySnapshot,
  TerminalStatus,
  WorkspaceState,
} from '../../../shared/contracts';
import type { ClaudeLaunchAttemptRegistry } from '../../platform/claude-launch-attempt';
import { notifyWorkspaceStateChange } from '../../platform/runtime-state-events';
import type { SessionGenerationRegistry } from '../../platform/session-generation';
import type { TerminalView } from '../../platform/terminal-view';
import type { ProjectsState } from './state';
import type { ProjectsTitleView } from './view';

export interface WorkspaceRendererDependencies {
  activeDevelopmentRuntime: () => DevelopmentRuntime;
  activeStatus: () => TerminalStatus | undefined;
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry;
  claudeSpeedOperations: SessionGenerationRegistry;
  claudeStateLoadGenerations: SessionGenerationRegistry;
  claudeStates: Map<string, ClaudeProjectState>;
  clearProviderSelection: () => void;
  codexLaunchAttempts: SessionGenerationRegistry;
  codexStateLoadGenerations: SessionGenerationRegistry;
  codexStates: Map<string, CodexProjectState>;
  developmentRuntimeStates: Map<string, DevelopmentRuntimeState>;
  disposeTerminalView: (sessionId: string, view: TerminalView) => void;
  effortRecoveryNotifications: Map<string, number>;
  ensureTerminalView: (status: TerminalStatus, active: boolean) => TerminalView;
  flushPendingComposerFocus: () => void;
  forgetSession: (sessionId: string) => void;
  getCodexAutoLaunchSessionId: () => string;
  getLastClaudeSessionId: () => string;
  getPendingComposerFocusSessionId: () => string;
  getSelectedRailTab: () => string | undefined;
  getTerminalView: (sessionId: string) => TerminalView | undefined;
  getTerminalViews: () => Map<string, TerminalView>;
  getWorkspaceState: () => WorkspaceState;
  loadConnectionAdvice: () => Promise<void>;
  loadConnectionHistory: () => Promise<void>;
  loadDevelopmentRuntime: (sessionId: string) => Promise<void>;
  loadRouterManagement: () => Promise<void>;
  pruneTerminalControlOperations: (validSessionIds: ReadonlySet<string>) => void;
  reconcileBinding: (state: WorkspaceState) => void;
  renderActiveStatus: (status: TerminalStatus) => void;
  renderConnectionHistory: () => void;
  renderCodexState: (state: CodexProjectState, invalidatePendingLoad?: boolean) => void;
  renderDevelopmentRuntimeState: (
    state: DevelopmentRuntimeState,
    replacePendingLoad?: boolean,
  ) => void;
  renderNoActiveSession: () => void;
  renderRuntimeActivity: (snapshot?: RuntimeActivitySnapshot) => void;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  resetForProjectChange: () => void;
  resetProviderForm: () => void;
  retryTerminalFitUntilMeasured: () => void;
  runtimeActivityStates: Map<string, RuntimeActivitySnapshot>;
  runtimeStateLoadGenerations: SessionGenerationRegistry;
  setCodexAutoLaunchSessionId: (sessionId: string) => void;
  setConfigFormSessionId: (sessionId: string) => void;
  setConnectionEnvironmentReady: (ready: boolean) => void;
  setConnectionHistoryEntries: (entries: never[]) => void;
  setLastClaudeSessionId: (sessionId: string) => void;
  setPendingComposerFocusSessionId: (sessionId: string) => void;
  setProviderGroupExpansionPending: (pending: boolean) => void;
  setWorkspaceState: (state: WorkspaceState) => void;
}

export interface WorkspaceRenderer {
  reconcileWorkspaceAfterActivation: () => Promise<void>;
  renderWorkspace: (state: WorkspaceState) => void;
}

export const createWorkspaceRenderer = (
  state: ProjectsState,
  dependencies: WorkspaceRendererDependencies,
  renderProjectList: () => void,
  titleView: ProjectsTitleView,
): WorkspaceRenderer => {
  const renderWorkspace = (workspace: WorkspaceState): void => {
    const previousActiveSessionId = dependencies.getWorkspaceState().activeSessionId;
    const nextActiveStatus = workspace.sessions.find(
      (status) => status.id === workspace.activeSessionId,
    );
    const activeViewAlreadyExists =
      nextActiveStatus !== undefined &&
      dependencies.getTerminalView(nextActiveStatus.id)?.ptyGeneration ===
        nextActiveStatus.ptyGeneration;
    titleView.syncConversationTitles(workspace);
    const validSessionIds = new Set(workspace.sessions.map((status) => status.id));
    const releasedClaudeLaunches = new Set<string>();
    const releasedCodexLaunches = new Set<string>();
    for (const status of workspace.sessions) {
      const release = dependencies.claudeLaunchAttempts.observeTerminal(status);
      if (release) {
        releasedClaudeLaunches.add(release.token.sessionId);
      }
      if (
        (status.phase === 'error' || status.phase === 'stopped') &&
        dependencies.codexLaunchAttempts.invalidate(status.id)
      ) {
        releasedCodexLaunches.add(status.id);
      }
    }
    for (const release of dependencies.claudeLaunchAttempts.prune(validSessionIds)) {
      releasedClaudeLaunches.add(release.token.sessionId);
    }
    for (const token of dependencies.codexLaunchAttempts.prune(validSessionIds)) {
      releasedCodexLaunches.add(token.sessionId);
    }
    dependencies.claudeSpeedOperations.prune(validSessionIds);
    dependencies.claudeStateLoadGenerations.prune(validSessionIds);
    dependencies.codexStateLoadGenerations.prune(validSessionIds);
    dependencies.pruneTerminalControlOperations(validSessionIds);
    dependencies.runtimeStateLoadGenerations.prune(validSessionIds);
    if (
      dependencies.getCodexAutoLaunchSessionId() &&
      !validSessionIds.has(dependencies.getCodexAutoLaunchSessionId())
    ) {
      dependencies.setCodexAutoLaunchSessionId('');
    }
    dependencies.setWorkspaceState(workspace);
    notifyWorkspaceStateChange();
    const pendingComposerFocusSessionId = dependencies.getPendingComposerFocusSessionId();
    const pendingComposerFocusStatus = workspace.sessions.find(
      ({ id }) => id === pendingComposerFocusSessionId,
    );
    if (
      pendingComposerFocusSessionId &&
      (pendingComposerFocusSessionId !== workspace.activeSessionId ||
        !pendingComposerFocusStatus ||
        pendingComposerFocusStatus.phase === 'error' ||
        pendingComposerFocusStatus.phase === 'stopped')
    ) {
      dependencies.setPendingComposerFocusSessionId('');
    }

    for (const status of workspace.sessions) {
      const active = status.id === workspace.activeSessionId;
      const view = dependencies.ensureTerminalView(status, active);
      view.container.classList.toggle('project-terminal--active', active);
    }

    for (const [sessionId, view] of dependencies.getTerminalViews()) {
      if (!validSessionIds.has(sessionId)) {
        dependencies.disposeTerminalView(sessionId, view);
      }
    }
    for (const sessionId of dependencies.claudeStates.keys()) {
      if (!validSessionIds.has(sessionId)) {
        dependencies.claudeStates.delete(sessionId);
        dependencies.forgetSession(sessionId);
        dependencies.effortRecoveryNotifications.delete(sessionId);
      }
    }
    for (const sessionId of dependencies.codexStates.keys()) {
      if (!validSessionIds.has(sessionId)) {
        dependencies.codexStates.delete(sessionId);
      }
    }
    for (const sessionId of dependencies.developmentRuntimeStates.keys()) {
      if (!validSessionIds.has(sessionId)) {
        dependencies.developmentRuntimeStates.delete(sessionId);
      }
    }

    renderProjectList();
    const status = dependencies.activeStatus();
    if (status) {
      dependencies.renderActiveStatus(status);
      if (
        (releasedClaudeLaunches.has(status.id) ||
          dependencies.claudeLaunchAttempts.isBusy(status.id)) &&
        dependencies.activeDevelopmentRuntime() === 'claude'
      ) {
        dependencies.refreshClaudeLaunchControls(status.id);
      }
      if (
        releasedCodexLaunches.has(status.id) &&
        dependencies.activeDevelopmentRuntime() === 'codex'
      ) {
        const latest = dependencies.codexStates.get(status.id);
        if (latest) {
          dependencies.renderCodexState(latest, false);
        }
      }
    } else {
      dependencies.renderNoActiveSession();
    }
    dependencies.flushPendingComposerFocus();
    if (workspace.activeSessionId !== dependencies.getLastClaudeSessionId()) {
      dependencies.setLastClaudeSessionId(workspace.activeSessionId);
      dependencies.setProviderGroupExpansionPending(
        dependencies.getSelectedRailTab() === 'connection',
      );
      dependencies.resetForProjectChange();
      dependencies.resetProviderForm();
      const knownRuntimeState = dependencies.developmentRuntimeStates.get(
        workspace.activeSessionId,
      );
      if (knownRuntimeState) {
        dependencies.renderDevelopmentRuntimeState(knownRuntimeState, false);
      } else if (workspace.activeSessionId) {
        void dependencies.loadDevelopmentRuntime(workspace.activeSessionId);
      }
      if (workspace.activeSessionId) {
        void dependencies.loadRouterManagement();
        void dependencies.loadConnectionAdvice();
        void dependencies.loadConnectionHistory();
      } else {
        dependencies.setConnectionHistoryEntries([]);
        dependencies.renderConnectionHistory();
      }
    }
    if (
      workspace.activeSessionId &&
      (workspace.activeSessionId !== previousActiveSessionId || !activeViewAlreadyExists)
    ) {
      dependencies.retryTerminalFitUntilMeasured();
    }
    dependencies.reconcileBinding(workspace);
    dependencies.renderRuntimeActivity(
      dependencies.runtimeActivityStates.get(workspace.activeSessionId),
    );
  };

  const reconcileWorkspaceAfterActivation = async (): Promise<void> => {
    if (state.workspaceActivationSyncInProgress) {
      return;
    }
    state.workspaceActivationSyncInProgress = true;
    try {
      renderWorkspace(await window.controlPanel.getWorkspace());
    } catch {
      // Keep the last rendered snapshot; the normal workspace event stream may still recover.
    } finally {
      state.workspaceActivationSyncInProgress = false;
    }
  };

  return {
    reconcileWorkspaceAfterActivation,
    renderWorkspace,
  };
};
