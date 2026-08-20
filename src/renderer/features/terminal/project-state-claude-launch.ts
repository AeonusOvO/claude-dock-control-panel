import { claudeStateOwnershipIsCurrent } from '../../../shared/claude/state-ownership';
import type { ClaudeProjectState, TerminalStatus } from '../../../shared/contracts';
import {
  type ClaudeLaunchAttemptToken,
  type ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import {
  launchContinueButton,
  launchNewButton,
  launchResumeButton,
  runAgentLabel,
  runClaudeButton,
} from './project-state-dom';

export interface TerminalClaudeLaunchActions {
  beginClaudeLaunchAttempt: (
    status: TerminalStatus,
    state?: ClaudeProjectState,
  ) => ClaudeLaunchAttemptToken;
  claudeLaunchBlocked: (state: ClaudeProjectState) => boolean;
  claudeStateCanApply: (state: ClaudeProjectState) => boolean;
  failClaudeLaunchAttempt: (token: ClaudeLaunchAttemptToken) => boolean;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  renderClaudeLaunchControls: (sessionId: string, launchBlocked?: boolean) => void;
  renderClaudeLaunchResult: (
    token: ClaudeLaunchAttemptToken,
    state: ClaudeProjectState,
    disposition: ClaudeLaunchResultDisposition,
  ) => boolean;
}

export const createTerminalClaudeLaunchActions = (
  deps: TerminalProjectStateDeps,
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void,
): TerminalClaudeLaunchActions => {
  const {
    getWorkspaceState,
    activeDevelopmentRuntime,
    claudeStates,
    claudeLaunchAttempts,
    conversationFeature,
  } = deps;

  const claudeLaunchBlocked = (state: ClaudeProjectState): boolean =>
    state.installation.security !== 'ready' || Boolean(state.routeHealth?.blocking);

  const renderClaudeLaunchControls = (sessionId: string, launchBlocked = false): void => {
    if (
      sessionId !== getWorkspaceState().activeSessionId ||
      activeDevelopmentRuntime() !== 'claude'
    ) {
      return;
    }
    const busy =
      conversationFeature.startingSessionId() === sessionId ||
      claudeLaunchAttempts.isBusy(sessionId);
    runAgentLabel.textContent = busy ? '正在启动安全会话…' : '新建安全会话';
    // Route health is a remediable preflight state, not a reason to turn the primary action into a
    // translucent dead end. The launch path can restart app-owned gateways and returns a precise
    // configuration error when user action is actually required.
    runClaudeButton.disabled = busy;
    runClaudeButton.dataset.launchBlocked = String(launchBlocked);
    runClaudeButton.setAttribute('aria-busy', String(busy));
    launchNewButton.textContent = busy ? '正在启动安全会话…' : '新建安全会话';
    for (const button of [launchNewButton, launchContinueButton, launchResumeButton]) {
      button.disabled = busy;
      button.dataset.launchBlocked = String(launchBlocked);
      button.setAttribute('aria-busy', String(busy));
    }
  };

  const refreshClaudeLaunchControls = (sessionId: string): void => {
    const state = claudeStates.get(sessionId);
    if (state) {
      renderClaudeState(state, true, false);
    } else {
      renderClaudeLaunchControls(sessionId);
    }
  };

  const beginClaudeLaunchAttempt = (
    status: TerminalStatus,
    state = claudeStates.get(status.id),
  ): ClaudeLaunchAttemptToken => {
    const token = claudeLaunchAttempts.begin(status.id, {
      active: state?.active,
      conversationId: state?.metrics?.sessionId,
      terminalPhase: status.phase,
      terminalPid: status.pid,
      terminalPtyGeneration: status.ptyGeneration,
    });
    renderClaudeLaunchControls(status.id, state ? claudeLaunchBlocked(state) : false);
    return token;
  };

  const failClaudeLaunchAttempt = (token: ClaudeLaunchAttemptToken): boolean => {
    if (!claudeLaunchAttempts.fail(token)) {
      return false;
    }
    refreshClaudeLaunchControls(token.sessionId);
    return true;
  };

  const claudeStateCanApply = (state: ClaudeProjectState): boolean => {
    const status = getWorkspaceState().sessions.find((session) => session.id === state.sessionId);
    if (!status) {
      return false;
    }
    return claudeStateOwnershipIsCurrent(
      state,
      claudeStates.get(state.sessionId)?.stateRevision,
      status.ptyGeneration,
    );
  };

  const renderClaudeLaunchResult = (
    token: ClaudeLaunchAttemptToken,
    state: ClaudeProjectState,
    disposition: ClaudeLaunchResultDisposition,
  ): boolean => {
    if (
      state.sessionId !== token.sessionId ||
      !claudeLaunchAttempts.acceptResult(token, disposition)
    ) {
      return false;
    }
    renderClaudeState(state);
    return true;
  };

  return {
    beginClaudeLaunchAttempt,
    claudeLaunchBlocked,
    claudeStateCanApply,
    failClaudeLaunchAttempt,
    refreshClaudeLaunchControls,
    renderClaudeLaunchControls,
    renderClaudeLaunchResult,
  };
};
