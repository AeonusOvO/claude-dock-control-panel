import type {
  CodexActiveOperationKind,
  CodexProjectState,
  DevelopmentRuntime,
} from '../../../shared/contracts';
import {
  OwnedOperationRegistry,
  OwnedSessionOperationRegistry,
  type OwnedSessionOperationToken,
} from '../../platform/session-generation';

export type CodexOwnedOperation = CodexActiveOperationKind;
export type RuntimeSwitchOperation = DevelopmentRuntime;

export interface CodexOperationPresentation {
  readonly operation: CodexOwnedOperation;
}

export type CodexOperationToken = OwnedSessionOperationToken<CodexOwnedOperation>;
export type RuntimeSwitchOperationToken = OwnedSessionOperationToken<RuntimeSwitchOperation>;

export interface CodexLaunchMutableState {
  codexAutoLaunchSessionId: string;
  codexOperations: OwnedOperationRegistry<CodexOwnedOperation>;
  runtimeSwitchOperations: OwnedSessionOperationRegistry<RuntimeSwitchOperation>;
}

const latestCodexState = (
  states: ReadonlyMap<string, CodexProjectState>,
  preferred?: CodexProjectState,
): CodexProjectState | undefined => {
  let latest = preferred;
  for (const state of states.values()) {
    if (!latest || state.revision > latest.revision) {
      latest = state;
    }
  }
  return latest;
};

export const codexOperationPresentation = (
  mutableState: CodexLaunchMutableState,
  states: ReadonlyMap<string, CodexProjectState>,
  preferred?: CodexProjectState,
): CodexOperationPresentation | undefined => {
  const authoritative = latestCodexState(states, preferred);
  if (authoritative?.activeOperation) {
    return { operation: authoritative.activeOperation.kind };
  }
  return mutableState.codexOperations.current();
};

export const codexOperationAdmissionBlocked = (
  mutableState: CodexLaunchMutableState,
  states: ReadonlyMap<string, CodexProjectState>,
): boolean => {
  const state = latestCodexState(states);
  return (
    Boolean(codexOperationPresentation(mutableState, states, state)) ||
    state?.login.phase === 'starting' ||
    state?.login.phase === 'waiting'
  );
};

export const beginCodexOperation = (
  mutableState: CodexLaunchMutableState,
  _states: ReadonlyMap<string, CodexProjectState>,
  sessionId: string,
  operation: CodexOwnedOperation,
): CodexOperationToken => mutableState.codexOperations.begin(sessionId, operation);

export const finishCodexOperation = (
  mutableState: CodexLaunchMutableState,
  token: CodexOperationToken,
): boolean => mutableState.codexOperations.finish(token);

export const createCodexLaunchMutableState = (): CodexLaunchMutableState => ({
  codexAutoLaunchSessionId: '',
  codexOperations: new OwnedOperationRegistry<CodexOwnedOperation>(),
  runtimeSwitchOperations: new OwnedSessionOperationRegistry<RuntimeSwitchOperation>(),
});
