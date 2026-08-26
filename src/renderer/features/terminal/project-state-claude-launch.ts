import { claudeStateOwnershipIsCurrent } from '../../../shared/claude/state-ownership';
import type { ClaudeProjectState, TerminalStatus } from '../../../shared/contracts';
import {
  type ClaudeLaunchAttemptToken,
  type ClaudeLaunchPresentationPhase,
  type ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import { renderRuntimePickerControls } from './project-state-runtime';
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
  setClaudeLaunchPaused: (token: ClaudeLaunchAttemptToken) => boolean;
  setClaudeLaunchPresentationPhase: (
    token: ClaudeLaunchAttemptToken,
    phase: ClaudeLaunchPresentationPhase,
  ) => boolean;
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
    terminalFeature,
  } = deps;

  const claudeLaunchBlocked = (state: ClaudeProjectState): boolean =>
    state.installation.security !== 'ready' || Boolean(state.routeHealth?.blocking);

  const renderClaudeLaunchControls = (sessionId: string, launchBlocked = false): void => {
    renderRuntimePickerControls(deps);
    if (
      sessionId !== getWorkspaceState().activeSessionId ||
      activeDevelopmentRuntime() !== 'claude'
    ) {
      return;
    }
    const launchPhase = claudeLaunchAttempts.presentationPhase(sessionId);
    const conversationStarting = conversationFeature.startingSessionId() === sessionId;
    const busy = conversationStarting || Boolean(launchPhase);
    const busyLabel = conversationStarting
      ? '正在启动…'
      : launchPhase === 'preflight'
        ? '正在进行网络预检…'
        : launchPhase === 'paused'
          ? '等待网络确认…'
          : launchPhase === 'checking-model-network'
            ? '正在切换模型并检查网络…'
            : launchPhase === 'switching-model'
              ? '正在切换对话模型…'
              : launchPhase === 'restoring-conversation'
                ? '正在恢复历史对话…'
                : '正在启动…';
    runAgentLabel.textContent = busy ? busyLabel : '对话已就绪';
    // Route health is a remediable preflight state, not a reason to turn the primary action into a
    // translucent dead end. The launch path can restart app-owned gateways and returns a precise
    // configuration error when user action is actually required.
    runClaudeButton.disabled = busy;
    runClaudeButton.dataset.launchBlocked = String(launchBlocked);
    runClaudeButton.setAttribute('aria-busy', String(busy));
    for (const [button, idleLabel] of [
      [launchNewButton, '启动当前对话'],
      [launchContinueButton, '继续最近会话'],
      [launchResumeButton, '选择历史会话'],
    ] as const) {
      button.textContent = busy ? busyLabel : idleLabel;
      button.disabled = busy;
      button.dataset.launchBlocked = String(launchBlocked);
      button.setAttribute('aria-busy', String(busy));
    }
    const status = getWorkspaceState().sessions.find(({ id }) => id === sessionId);
    if (status?.id === getWorkspaceState().activeSessionId) {
      terminalFeature.setComposerEnabled(!busy && status.phase === 'running');
      const terminal = terminalFeature.getTerminalView(sessionId)?.terminal;
      if (terminal) {
        terminal.options.disableStdin = busy;
      }
    }
  };

  const refreshClaudeLaunchControls = (sessionId: string): void => {
    const state = claudeStates.get(sessionId);
    if (state && claudeStateCanApply(state)) {
      renderClaudeState(state, true, false);
    } else {
      renderClaudeLaunchControls(sessionId, state ? claudeLaunchBlocked(state) : false);
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

  const setClaudeLaunchPaused = (token: ClaudeLaunchAttemptToken): boolean => {
    if (!claudeLaunchAttempts.setPresentationPhase(token, 'paused')) {
      return false;
    }
    refreshClaudeLaunchControls(token.sessionId);
    return true;
  };

  const setClaudeLaunchPresentationPhase = (
    token: ClaudeLaunchAttemptToken,
    phase: ClaudeLaunchPresentationPhase,
  ): boolean => {
    if (!claudeLaunchAttempts.setPresentationPhase(token, phase)) return false;
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
    setClaudeLaunchPaused,
    setClaudeLaunchPresentationPhase,
    renderClaudeLaunchResult,
  };
};
