import type {
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntimeState,
} from '../../../shared/contracts';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import {
  claudeWorkbench,
  runtimeClaude,
  runtimeCodex,
  runtimePicker,
  runtimePickerLabel,
  runtimeSummaryValue,
  workbenchTabs,
  workbenchTitle,
  workbenchTrigger,
  workbenchTriggerLabel,
} from './project-state-dom';

export interface TerminalRuntimeStateActions {
  loadDevelopmentRuntime: (sessionId: string) => Promise<void>;
  renderDevelopmentRuntimeState: (
    state: DevelopmentRuntimeState,
    invalidatePendingLoad?: boolean,
  ) => void;
}

const RUNTIME_SWITCH_POLL_INTERVAL_MS = 250;
const runtimeProjectKey = (cwd: string): string => cwd.toLocaleLowerCase('en-US');

interface RuntimeSwitchPoll {
  attempt: number;
  handle: number;
}

export const renderRuntimePickerControls = (
  deps: Pick<TerminalProjectStateDeps, 'developmentRuntimeStates' | 'getRuntimeSwitchOperation'>,
  sessionId?: string,
): void => {
  const state = sessionId ? deps.developmentRuntimeStates.get(sessionId) : undefined;
  const localOperation = sessionId ? deps.getRuntimeSwitchOperation(sessionId) : undefined;
  const pendingRuntime = localOperation?.operation ?? state?.switchOperation?.runtime;
  const stableRuntime = state?.runtime ?? 'claude';
  const displayedRuntime = pendingRuntime ?? stableRuntime;
  const switching = Boolean(pendingRuntime);
  runtimeClaude.checked = displayedRuntime === 'claude';
  runtimeCodex.checked = displayedRuntime === 'codex';
  runtimePicker.disabled = !sessionId || switching;
  runtimePicker.setAttribute('aria-busy', String(switching));
  runtimePickerLabel.textContent = switching ? '正在切换并检查网络…' : '当前项目开发引擎';
  runtimeSummaryValue.textContent = switching
    ? `正在切换到 ${displayedRuntime === 'codex' ? 'Codex' : 'Claude Code'}…`
    : displayedRuntime === 'codex'
      ? 'Codex'
      : 'Claude Code';
};

export const createTerminalRuntimeStateActions = (
  deps: TerminalProjectStateDeps,
  renderCodexLoadingState: (sessionId: string, errorMessage?: string) => void,
  renderCodexState: (state: CodexProjectState, invalidatePendingLoad?: boolean) => void,
  loadCodexState: (
    sessionId: string,
    errorMessage?: string,
  ) => Promise<CodexProjectState | undefined>,
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void,
  renderClaudeLaunchControls: (sessionId: string, launchBlocked?: boolean) => void,
  loadClaudeState: (sessionId: string) => Promise<void>,
): TerminalRuntimeStateActions => {
  const {
    getWorkspaceState,
    claudeStates,
    codexStates,
    developmentRuntimeStates,
    runtimeStateLoadGenerations,
    showToast,
    preflightFeature,
  } = deps;

  const runtimeSwitchPolls = new Map<string, RuntimeSwitchPoll>();
  let disposed = false;

  const clearRuntimeSwitchPoll = (cwd: string): void => {
    const key = runtimeProjectKey(cwd);
    const poll = runtimeSwitchPolls.get(key);
    if (!poll) return;
    window.clearTimeout(poll.handle);
    runtimeSwitchPolls.delete(key);
  };

  const scheduleRuntimeSwitchPoll = (state: DevelopmentRuntimeState): void => {
    const operation = state.switchOperation;
    if (!operation || disposed) {
      clearRuntimeSwitchPoll(state.cwd);
      return;
    }
    const key = runtimeProjectKey(state.cwd);
    const current = runtimeSwitchPolls.get(key);
    if (current?.attempt === operation.attempt) {
      return;
    }
    clearRuntimeSwitchPoll(state.cwd);
    const handle = window.setTimeout(() => {
      const owned = runtimeSwitchPolls.get(key);
      if (disposed || owned?.attempt !== operation.attempt) {
        return;
      }
      runtimeSwitchPolls.delete(key);
      const session = getWorkspaceState().sessions.find(
        (candidate) => runtimeProjectKey(candidate.cwd) === key,
      );
      if (session) {
        void loadDevelopmentRuntime(session.id, true);
      }
    }, RUNTIME_SWITCH_POLL_INTERVAL_MS);
    runtimeSwitchPolls.set(key, { attempt: operation.attempt, handle });
  };

  const disposeRuntimeSwitchPolls = (): void => {
    disposed = true;
    for (const poll of runtimeSwitchPolls.values()) {
      window.clearTimeout(poll.handle);
    }
    runtimeSwitchPolls.clear();
  };
  window.addEventListener('beforeunload', disposeRuntimeSwitchPolls, { once: true });

  const renderDevelopmentRuntimeState = (
    state: DevelopmentRuntimeState,
    invalidatePendingLoad = true,
    runNetworkPreflight = true,
  ): void => {
    const workspace = getWorkspaceState();
    const key = runtimeProjectKey(state.cwd);
    const sourceSession = workspace.sessions.find(
      (session) => session.id === state.sessionId && runtimeProjectKey(session.cwd) === key,
    );
    if (!sourceSession) {
      return;
    }
    const projectSessions = workspace.sessions.filter(
      (session) => runtimeProjectKey(session.cwd) === key,
    );
    for (const session of projectSessions) {
      if (invalidatePendingLoad) {
        runtimeStateLoadGenerations.invalidate(session.id);
      }
      developmentRuntimeStates.set(session.id, { ...state, sessionId: session.id });
    }
    scheduleRuntimeSwitchPoll(state);

    const activeSession = projectSessions.find(
      (session) => session.id === workspace.activeSessionId,
    );
    if (!activeSession) {
      return;
    }
    const activeState = { ...state, sessionId: activeSession.id };
    const codexSelected = activeState.runtime === 'codex';
    document.body.dataset.agentRuntime = activeState.runtime;
    renderRuntimePickerControls(deps, activeState.sessionId);
    workbenchTabs.hidden = codexSelected;
    workbenchTitle.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    workbenchTriggerLabel.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    workbenchTrigger.title = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    claudeWorkbench.setAttribute(
      'aria-label',
      codexSelected ? 'Codex 可视化工作台' : 'Claude 可视化工作台',
    );
    if (codexSelected) {
      const codexState = codexStates.get(activeState.sessionId);
      if (codexState) {
        renderCodexState(codexState, false);
      } else {
        renderCodexLoadingState(activeState.sessionId);
        void loadCodexState(activeState.sessionId);
      }
    } else {
      const claudeState = claudeStates.get(activeState.sessionId);
      if (claudeState) {
        renderClaudeState(claudeState, true, false);
      } else {
        renderClaudeLaunchControls(activeState.sessionId);
        void loadClaudeState(activeState.sessionId);
      }
    }
    if (runNetworkPreflight) {
      void preflightFeature.runActiveNetworkPreflight(false);
    }
  };

  async function loadDevelopmentRuntime(sessionId: string, polling = false): Promise<void> {
    const request = runtimeStateLoadGenerations.begin(sessionId);
    let state: DevelopmentRuntimeState;
    try {
      state = await window.controlPanel.getDevelopmentRuntime(sessionId);
    } catch {
      if (runtimeStateLoadGenerations.finish(request)) {
        const pending = developmentRuntimeStates.get(sessionId);
        if (pending?.switchOperation) {
          scheduleRuntimeSwitchPoll(pending);
        }
        if (!polling) {
          showToast('无法读取当前项目的开发引擎。', 'error');
        }
      }
      return;
    }
    if (disposed || !runtimeStateLoadGenerations.finish(request) || state.sessionId !== sessionId) {
      return;
    }
    renderDevelopmentRuntimeState(state, false, !polling || !state.switchOperation);
  }

  return {
    loadDevelopmentRuntime,
    renderDevelopmentRuntimeState,
  };
};
