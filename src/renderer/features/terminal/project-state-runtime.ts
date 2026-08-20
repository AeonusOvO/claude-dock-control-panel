import type {
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntimeState,
} from '../../../shared/contracts';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import {
  claudeWorkbench,
  runAgentLabel,
  runClaudeButton,
  runtimeClaude,
  runtimeCodex,
  runtimePicker,
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

export const createTerminalRuntimeStateActions = (
  deps: TerminalProjectStateDeps,
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

  const renderDevelopmentRuntimeState = (
    state: DevelopmentRuntimeState,
    invalidatePendingLoad = true,
  ): void => {
    if (!getWorkspaceState().sessions.some((session) => session.id === state.sessionId)) {
      return;
    }
    if (invalidatePendingLoad) {
      runtimeStateLoadGenerations.invalidate(state.sessionId);
    }
    developmentRuntimeStates.set(state.sessionId, state);
    if (state.sessionId !== getWorkspaceState().activeSessionId) {
      return;
    }
    const codexSelected = state.runtime === 'codex';
    document.body.dataset.agentRuntime = state.runtime;
    runtimeClaude.checked = !codexSelected;
    runtimeCodex.checked = codexSelected;
    runtimePicker.disabled = false;
    workbenchTabs.hidden = codexSelected;
    workbenchTitle.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    workbenchTriggerLabel.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    workbenchTrigger.title = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    claudeWorkbench.setAttribute(
      'aria-label',
      codexSelected ? 'Codex 可视化工作台' : 'Claude 可视化工作台',
    );
    if (codexSelected) {
      const codexState = codexStates.get(state.sessionId);
      if (codexState) {
        renderCodexState(codexState, false);
      } else {
        runAgentLabel.textContent = '正在检查 Codex';
        runClaudeButton.disabled = true;
        void loadCodexState(state.sessionId);
      }
    } else {
      const claudeState = claudeStates.get(state.sessionId);
      if (claudeState) {
        renderClaudeState(claudeState, true, false);
      } else {
        renderClaudeLaunchControls(state.sessionId);
        void loadClaudeState(state.sessionId);
      }
    }
    void preflightFeature.runActiveNetworkPreflight(false);
  };

  const loadDevelopmentRuntime = async (sessionId: string): Promise<void> => {
    const request = runtimeStateLoadGenerations.begin(sessionId);
    let state: DevelopmentRuntimeState;
    try {
      state = await window.controlPanel.getDevelopmentRuntime(sessionId);
    } catch {
      if (runtimeStateLoadGenerations.finish(request)) {
        showToast('无法读取当前项目的开发引擎。', 'error');
      }
      return;
    }
    if (!runtimeStateLoadGenerations.finish(request) || state.sessionId !== sessionId) {
      return;
    }
    renderDevelopmentRuntimeState(state, false);
  };

  return {
    loadDevelopmentRuntime,
    renderDevelopmentRuntimeState,
  };
};
