import type {
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntimeState,
  OperationResult,
  TerminalStatus,
} from '../../../shared/contracts';
import {
  type ClaudeLaunchAttemptToken,
  type ClaudeLaunchPresentationPhase,
  type ClaudeLaunchResultDisposition,
} from '../../platform/claude-launch-attempt';
import { createTerminalClaudeLaunchActions } from './project-state-claude-launch';
import { createTerminalClaudeLoadActions } from './project-state-claude-load';
import { createTerminalClaudeStateActions } from './project-state-claude';
import { createTerminalCodexStateActions } from './project-state-codex';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import {
  allowBypassPermissions,
  launchContinueButton,
  launchNewButton,
  launchResumeButton,
  runClaudeButton,
  runtimePicker,
  terminalProject,
} from './project-state-dom';
import { createTerminalRuntimeStateActions } from './project-state-runtime';
import { createTerminalSessionActions } from './project-state-session';

export type { TerminalProjectStateDeps } from './project-state-dependencies';
export { phaseCopy } from './project-state-session';

export interface TerminalProjectState {
  loadNextDevelopmentRuntime: () => Promise<void>;
  renderDevelopmentRuntimeState: (
    state: DevelopmentRuntimeState,
    invalidatePendingLoad?: boolean,
  ) => void;
  renderCodexLoadingState: (sessionId: string, errorMessage?: string) => void;
  renderCodexState: (state: CodexProjectState, invalidatePendingLoad?: boolean) => void;
  loadCodexState: (
    sessionId: string,
    errorMessage?: string,
  ) => Promise<CodexProjectState | undefined>;
  loadDevelopmentRuntime: (sessionId: string) => Promise<void>;
  renderClaudeLaunchControls: (sessionId: string, launchBlocked?: boolean) => void;
  refreshClaudeLaunchControls: (sessionId: string) => void;
  beginClaudeLaunchAttempt: (
    status: TerminalStatus,
    state?: ClaudeProjectState,
  ) => ClaudeLaunchAttemptToken;
  failClaudeLaunchAttempt: (token: ClaudeLaunchAttemptToken) => boolean;
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
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void;
  loadClaudeState: (sessionId: string) => Promise<void>;
  renderActiveStatus: (status: TerminalStatus) => void;
  renderNoActiveSession: () => void;
  applyTerminalStatus: (status: TerminalStatus) => void;
  handleOperation: (result: OperationResult, successMessage?: string) => boolean;
  readonly runtimePicker: HTMLFieldSetElement;
  readonly runClaudeButton: HTMLButtonElement;
  readonly launchNewButton: HTMLButtonElement;
  readonly launchContinueButton: HTMLButtonElement;
  readonly launchResumeButton: HTMLButtonElement;
  readonly allowBypassPermissions: HTMLInputElement;
  readonly terminalProject: HTMLElement;
}

export const createTerminalProjectState = (
  deps: TerminalProjectStateDeps,
): TerminalProjectState => {
  const codexActions = createTerminalCodexStateActions(deps);
  const claudeLaunchActions = createTerminalClaudeLaunchActions(
    deps,
    (state, observeLaunch, invalidatePendingLoad) =>
      claudeStateActions.renderClaudeState(state, observeLaunch, invalidatePendingLoad),
  );
  const claudeStateActions = createTerminalClaudeStateActions(
    deps,
    claudeLaunchActions.claudeStateCanApply,
    claudeLaunchActions.renderClaudeLaunchControls,
    claudeLaunchActions.claudeLaunchBlocked,
  );
  const claudeLoadActions = createTerminalClaudeLoadActions(
    deps,
    claudeLaunchActions.claudeStateCanApply,
    claudeStateActions.renderClaudeState,
  );
  const runtimeActions = createTerminalRuntimeStateActions(
    deps,
    codexActions.renderCodexLoadingState,
    codexActions.renderCodexState,
    codexActions.loadCodexState,
    claudeStateActions.renderClaudeState,
    claudeLaunchActions.renderClaudeLaunchControls,
    claudeLoadActions.loadClaudeState,
  );
  const sessionActions = createTerminalSessionActions(deps);

  return {
    loadNextDevelopmentRuntime: runtimeActions.loadNextDevelopmentRuntime,
    renderDevelopmentRuntimeState: runtimeActions.renderDevelopmentRuntimeState,
    renderCodexLoadingState: codexActions.renderCodexLoadingState,
    renderCodexState: codexActions.renderCodexState,
    loadCodexState: codexActions.loadCodexState,
    loadDevelopmentRuntime: runtimeActions.loadDevelopmentRuntime,
    renderClaudeLaunchControls: claudeLaunchActions.renderClaudeLaunchControls,
    refreshClaudeLaunchControls: claudeLaunchActions.refreshClaudeLaunchControls,
    beginClaudeLaunchAttempt: claudeLaunchActions.beginClaudeLaunchAttempt,
    failClaudeLaunchAttempt: claudeLaunchActions.failClaudeLaunchAttempt,
    setClaudeLaunchPaused: claudeLaunchActions.setClaudeLaunchPaused,
    setClaudeLaunchPresentationPhase: claudeLaunchActions.setClaudeLaunchPresentationPhase,
    renderClaudeLaunchResult: claudeLaunchActions.renderClaudeLaunchResult,
    renderClaudeState: claudeStateActions.renderClaudeState,
    loadClaudeState: claudeLoadActions.loadClaudeState,
    renderActiveStatus: sessionActions.renderActiveStatus,
    renderNoActiveSession: sessionActions.renderNoActiveSession,
    applyTerminalStatus: sessionActions.applyTerminalStatus,
    handleOperation: sessionActions.handleOperation,
    runtimePicker,
    runClaudeButton,
    launchNewButton,
    launchContinueButton,
    launchResumeButton,
    allowBypassPermissions,
    terminalProject,
  };
};
