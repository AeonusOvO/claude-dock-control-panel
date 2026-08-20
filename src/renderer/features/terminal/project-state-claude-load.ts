import type { ClaudeProjectState } from '../../../shared/contracts';
import type { TerminalProjectStateDeps } from './project-state-dependencies';

export interface TerminalClaudeLoadActions {
  loadClaudeState: (sessionId: string) => Promise<void>;
}

export const createTerminalClaudeLoadActions = (
  deps: TerminalProjectStateDeps,
  claudeStateCanApply: (state: ClaudeProjectState) => boolean,
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void,
): TerminalClaudeLoadActions => {
  const { claudeStateLoadGenerations, claudeLaunchAttempts, showToast } = deps;

  const loadClaudeState = async (sessionId: string): Promise<void> => {
    const request = claudeStateLoadGenerations.begin(sessionId);
    const attemptAtRequest = claudeLaunchAttempts.current(sessionId);
    let state: ClaudeProjectState;
    try {
      state = await window.controlPanel.getClaudeProjectState(sessionId);
    } catch {
      if (claudeStateLoadGenerations.finish(request)) {
        showToast('无法读取 Claude 工作台状态。', 'error');
      }
      return;
    }
    if (
      !claudeStateLoadGenerations.finish(request) ||
      state.sessionId !== sessionId ||
      !claudeStateCanApply(state)
    ) {
      return;
    }
    const currentAttempt = claudeLaunchAttempts.current(sessionId);
    if (
      currentAttempt &&
      attemptAtRequest &&
      currentAttempt.generation !== attemptAtRequest.generation
    ) {
      return;
    }
    if (currentAttempt && !attemptAtRequest) {
      claudeLaunchAttempts.hydrateClaude(currentAttempt, {
        active: state.active,
        conversationId: state.metrics?.sessionId,
        sessionId: state.sessionId,
      });
      renderClaudeState(state, false, false);
      return;
    }
    renderClaudeState(state, true, false);
  };

  return {
    loadClaudeState,
  };
};
