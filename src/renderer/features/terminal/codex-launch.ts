import type {
  CodexLaunchMode,
  CodexLoginMethod,
  CodexProjectState,
  DevelopmentRuntime,
} from '../../../shared/contracts';
import { createCodexLaunchAccountActions } from './codex-launch-account';
import { createCodexLaunchActions } from './codex-launch-actions';
import { bindCodexLaunchControls } from './codex-launch-bindings';
import type { CodexLaunchDeps } from './codex-launch-dependencies';
import {
  codexOperationAdmissionBlocked,
  codexOperationPresentation,
  createCodexLaunchMutableState,
  type CodexOperationPresentation,
  type RuntimeSwitchOperationToken,
} from './codex-operation-state';

export type { CodexLaunchDeps } from './codex-launch-dependencies';

export interface CodexLaunch {
  launchCodex: (mode: CodexLaunchMode, sessionId?: string, announce?: boolean) => Promise<boolean>;
  installOrUpdateCodex: (sessionId?: string) => Promise<CodexProjectState | undefined>;
  startCodexLogin: (
    method: CodexLoginMethod,
    launchAfterLogin: boolean,
    sessionId?: string,
  ) => Promise<void>;
  prepareAndLaunchCodex: (sessionId?: string, announce?: boolean) => Promise<boolean>;
  switchDevelopmentRuntime: (runtime: DevelopmentRuntime) => Promise<void>;
  getCodexOperation: (state?: CodexProjectState) => CodexOperationPresentation | undefined;
  getRuntimeSwitchOperation: (sessionId: string) => RuntimeSwitchOperationToken | undefined;
  isCodexOperationInProgress: () => boolean;
  getCodexAutoLaunchSessionId: () => string;
  setCodexAutoLaunchSessionId: (sessionId: string) => void;
}

export const createCodexLaunch = (deps: CodexLaunchDeps): CodexLaunch => {
  const mutableState = createCodexLaunchMutableState();
  const actions = createCodexLaunchActions(deps, mutableState);
  const accountActions = createCodexLaunchAccountActions(deps, mutableState);
  bindCodexLaunchControls(deps, actions, accountActions);

  return {
    launchCodex: actions.launchCodex,
    installOrUpdateCodex: actions.installOrUpdateCodex,
    startCodexLogin: actions.startCodexLogin,
    prepareAndLaunchCodex: actions.prepareAndLaunchCodex,
    switchDevelopmentRuntime: accountActions.switchDevelopmentRuntime,
    getCodexOperation: (state) => codexOperationPresentation(mutableState, deps.codexStates, state),
    getRuntimeSwitchOperation: (sessionId) =>
      mutableState.runtimeSwitchOperations.current(sessionId),
    isCodexOperationInProgress: () =>
      codexOperationAdmissionBlocked(mutableState, deps.codexStates),
    getCodexAutoLaunchSessionId: () => mutableState.codexAutoLaunchSessionId,
    setCodexAutoLaunchSessionId: (sessionId) => {
      mutableState.codexAutoLaunchSessionId = sessionId;
    },
  };
};
