import type {
  CodexLaunchMode,
  CodexLoginMethod,
  CodexProjectState,
  DevelopmentRuntime,
} from '../../../shared/contracts';
import { createCodexLaunchAccountActions } from './codex-launch-account';
import { createCodexLaunchActions } from './codex-launch-actions';
import { bindCodexLaunchControls } from './codex-launch-bindings';
import { createCodexLaunchMutableState } from './codex-launch-dependencies';

export type { CodexLaunchDeps } from './codex-launch-dependencies';
import type { CodexLaunchDeps } from './codex-launch-dependencies';

export interface CodexLaunch {
  launchCodex: (mode: CodexLaunchMode) => Promise<void>;
  installOrUpdateCodex: () => Promise<CodexProjectState | undefined>;
  startCodexLogin: (method: CodexLoginMethod, launchAfterLogin: boolean) => Promise<void>;
  prepareAndLaunchCodex: () => Promise<void>;
  switchDevelopmentRuntime: (runtime: DevelopmentRuntime) => Promise<void>;
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
    isCodexOperationInProgress: () => mutableState.codexOperationInProgress,
    getCodexAutoLaunchSessionId: () => mutableState.codexAutoLaunchSessionId,
    setCodexAutoLaunchSessionId: (sessionId) => {
      mutableState.codexAutoLaunchSessionId = sessionId;
    },
  };
};
