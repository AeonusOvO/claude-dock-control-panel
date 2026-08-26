import { projectNameFromPath, resultFailureMessage } from '../../platform/format';
import type {
  CodexLaunchMode,
  CodexLoginMethod,
  CodexProjectState,
} from '../../../shared/contracts';
import { waitForCodexAdmissionChange } from '../../platform/runtime-state-events';
import type { CodexLaunchDeps } from './codex-launch-dependencies';
import {
  beginCodexOperation,
  codexOperationAdmissionBlocked,
  finishCodexOperation,
  type CodexLaunchMutableState,
  type CodexOperationToken,
} from './codex-operation-state';

const codexOperationOwnsResult = (
  mutableState: CodexLaunchMutableState,
  operation: CodexOperationToken,
  resultState: CodexProjectState,
  states: ReadonlyMap<string, CodexProjectState>,
): boolean => {
  const current = states.get(operation.sessionId);
  return (
    mutableState.codexOperations.isCurrent(operation) &&
    resultState.sessionId === operation.sessionId &&
    (!current || resultState.revision >= current.revision)
  );
};

const shouldAutoLaunchCodex = (
  deps: Pick<CodexLaunchDeps, 'developmentRuntimeStates' | 'getWorkspaceState'>,
  mutableState: CodexLaunchMutableState,
  state: CodexProjectState,
): boolean =>
  mutableState.codexAutoLaunchSessionId === state.sessionId &&
  Boolean(state.account) &&
  deps.getWorkspaceState().sessions.some(({ id }) => id === state.sessionId) &&
  deps.developmentRuntimeStates.get(state.sessionId)?.runtime === 'codex';

const renderActiveCodexState = (
  deps: Pick<CodexLaunchDeps, 'activeStatus' | 'codexStates' | 'terminalState'>,
): CodexProjectState | undefined => {
  const sessionId = deps.activeStatus()?.id;
  const state = sessionId ? deps.codexStates.get(sessionId) : undefined;
  if (state) {
    deps.terminalState.renderCodexState(state, false);
  } else if (sessionId) {
    deps.terminalState.renderCodexLoadingState(
      sessionId,
      'Codex 状态尚未加载，请重新打开项目或稍后重试。',
    );
  }
  return state;
};

export interface CodexLaunchActions {
  launchCodex: (mode: CodexLaunchMode, sessionId?: string, announce?: boolean) => Promise<boolean>;
  installOrUpdateCodex: (sessionId?: string) => Promise<CodexProjectState | undefined>;
  startCodexLogin: (
    method: CodexLoginMethod,
    launchAfterLogin: boolean,
    sessionId?: string,
  ) => Promise<void>;
  prepareAndLaunchCodex: (sessionId?: string, announce?: boolean) => Promise<boolean>;
}

type CodexPreparationActions = Pick<
  CodexLaunchActions,
  'installOrUpdateCodex' | 'launchCodex' | 'startCodexLogin'
>;

const prepareAndLaunchCodexSession = async (
  deps: CodexLaunchDeps,
  mutableState: CodexLaunchMutableState,
  actions: CodexPreparationActions,
  sessionId: string | undefined,
  announce: boolean,
): Promise<boolean> => {
  const status = deps.getWorkspaceState().sessions.find(({ id }) => id === sessionId);
  if (!status || deps.codexLaunchAttempts.isActive(status.id)) return false;
  const stillOwnsSession = (): boolean =>
    deps.getWorkspaceState().sessions.some(({ id }) => id === status.id);
  const waitForSharedOperation = async (): Promise<boolean> => {
    while (codexOperationAdmissionBlocked(mutableState, deps.codexStates)) {
      if (!stillOwnsSession()) return false;
      await waitForCodexAdmissionChange(
        () => stillOwnsSession() && codexOperationAdmissionBlocked(mutableState, deps.codexStates),
      );
    }
    return stillOwnsSession();
  };

  // Installation and account login serialize as shared resources. Every requested conversation
  // retains an independent async continuation and resumes without blocking the renderer thread.
  for (;;) {
    if (!(await waitForSharedOperation())) return false;
    let state = await deps.terminalState.loadCodexState(status.id, '无法读取 Codex 环境。');
    if (!state || !stillOwnsSession()) return false;
    if (!state.installation.installed) {
      state = await actions.installOrUpdateCodex(status.id);
      if (state?.installation.installed) continue;
      if (codexOperationAdmissionBlocked(mutableState, deps.codexStates)) continue;
      return false;
    }
    if (state.requiresOpenaiAuth && !state.account) {
      if (state.login.phase === 'error') return false;
      await actions.startCodexLogin('browser', false, status.id);
      if (!stillOwnsSession()) return false;
      if (codexOperationAdmissionBlocked(mutableState, deps.codexStates)) continue;
      state = await deps.terminalState.loadCodexState(status.id, '无法读取 Codex 登录状态。');
      if (!state?.account) return false;
      continue;
    }
    return actions.launchCodex('new', status.id, announce);
  }
};

export const createCodexLaunchActions = (
  deps: CodexLaunchDeps,
  mutableState: CodexLaunchMutableState,
): CodexLaunchActions => {
  const {
    activeStatus,
    codexStates,
    codexLaunchAttempts,
    terminalState,
    showToast,
    terminalFeature,
  } = deps;

  const launchCodex = async (
    mode: CodexLaunchMode,
    sessionId = activeStatus()?.id,
    announce = true,
  ): Promise<boolean> => {
    const status = deps.getWorkspaceState().sessions.find(({ id }) => id === sessionId);
    if (
      !status ||
      codexLaunchAttempts.isActive(status.id) ||
      codexOperationAdmissionBlocked(mutableState, codexStates)
    ) {
      return false;
    }
    const attempt = codexLaunchAttempts.begin(status.id);
    const existingState = codexStates.get(status.id);
    if (existingState) {
      terminalState.renderCodexState(existingState, false);
    }
    try {
      if (!codexLaunchAttempts.isCurrent(attempt)) {
        return false;
      }
      terminalFeature.getTerminalView(status.id)?.terminal.clear();
      if (!codexLaunchAttempts.isCurrent(attempt)) {
        return false;
      }
      const result = await window.controlPanel.launchCodex(status.id, mode);
      if (!codexLaunchAttempts.isCurrent(attempt) || result.state.sessionId !== attempt.sessionId) {
        return false;
      }
      terminalState.renderCodexState(result.state);
      if (!result.ok) {
        if (announce) showToast(resultFailureMessage(result, '无法启动 Codex。'), 'error');
        return false;
      }
      if (announce) {
        showToast(
          mode === 'new'
            ? `已在 ${projectNameFromPath(status.cwd)} 启动 Codex`
            : mode === 'continue'
              ? '正在续接当前项目最近的 Codex 会话'
              : '已打开 Codex 历史会话选择器',
        );
      }
      if (deps.getWorkspaceState().activeSessionId !== status.id) return true;
      if (mode === 'resume') {
        terminalFeature.getTerminalView(status.id)?.terminal.focus();
      } else {
        terminalFeature.requestComposerFocus(status.id);
      }
      return true;
    } catch {
      if (codexLaunchAttempts.isCurrent(attempt)) {
        if (announce) showToast('无法启动 Codex。', 'error');
      }
      return false;
    } finally {
      if (codexLaunchAttempts.finish(attempt)) {
        const latest = codexStates.get(status.id);
        if (latest) {
          terminalState.renderCodexState(latest, false);
        }
      }
    }
  };

  const installOrUpdateCodex = async (
    sessionId = activeStatus()?.id,
  ): Promise<CodexProjectState | undefined> => {
    const status = deps.getWorkspaceState().sessions.find(({ id }) => id === sessionId);
    if (!status || codexOperationAdmissionBlocked(mutableState, codexStates)) {
      return undefined;
    }
    const existing = codexStates.get(status.id);
    const operationKind = existing?.installation.updateAvailable ? 'update' : 'install';
    const operation = beginCodexOperation(mutableState, codexStates, status.id, operationKind);
    if (existing) {
      terminalState.renderCodexState(existing, false);
    }
    try {
      const result = await window.controlPanel.installOrUpdateCodex(status.id, operationKind);
      if (!codexOperationOwnsResult(mutableState, operation, result.state, codexStates)) {
        return undefined;
      }
      terminalState.renderCodexState(result.state);
      if (!result.ok) {
        showToast(resultFailureMessage(result, 'Codex 安装失败。'), 'error');
        return undefined;
      }
      showToast(`Codex CLI ${result.state.installation.version ?? ''} 已就绪。`);
      return result.state;
    } catch {
      if (mutableState.codexOperations.isCurrent(operation)) {
        showToast('Codex 安装失败，请检查网络后重试。', 'error');
      }
      return undefined;
    } finally {
      if (finishCodexOperation(mutableState, operation)) {
        renderActiveCodexState(deps);
      }
    }
  };

  const startCodexLogin = async (
    method: CodexLoginMethod,
    launchAfterLogin: boolean,
    sessionId = activeStatus()?.id,
  ): Promise<void> => {
    const status = deps.getWorkspaceState().sessions.find(({ id }) => id === sessionId);
    if (!status || codexOperationAdmissionBlocked(mutableState, codexStates)) {
      return;
    }
    const operation = beginCodexOperation(
      mutableState,
      codexStates,
      status.id,
      method === 'device-code' ? 'login-device' : 'login-browser',
    );
    if (launchAfterLogin) {
      mutableState.codexAutoLaunchSessionId = status.id;
    }
    const existing = codexStates.get(status.id);
    if (existing) {
      terminalState.renderCodexState(existing, false);
    }
    try {
      const result = await window.controlPanel.startCodexLogin(status.id, method);
      if (!codexOperationOwnsResult(mutableState, operation, result.state, codexStates)) {
        return;
      }
      terminalState.renderCodexState(result.state);
      if (!result.ok) {
        mutableState.codexAutoLaunchSessionId = '';
        showToast(resultFailureMessage(result, '无法启动 ChatGPT 登录。'), 'error');
        return;
      }
      showToast(
        method === 'device-code'
          ? '浏览器已打开，请输入工作台中显示的设备验证码。'
          : '浏览器已打开；登录完成后会自动回到当前项目。',
      );
    } catch {
      if (mutableState.codexOperations.isCurrent(operation)) {
        mutableState.codexAutoLaunchSessionId = '';
        showToast('无法启动 ChatGPT 登录。', 'error');
      }
    } finally {
      if (finishCodexOperation(mutableState, operation)) {
        const sourceState = codexStates.get(status.id);
        renderActiveCodexState(deps);
        if (
          sourceState?.account &&
          mutableState.codexAutoLaunchSessionId === sourceState.sessionId
        ) {
          const launch = shouldAutoLaunchCodex(deps, mutableState, sourceState);
          mutableState.codexAutoLaunchSessionId = '';
          if (launch) {
            void launchCodex('new', sourceState.sessionId);
          }
        }
      }
    }
  };

  const prepareAndLaunchCodex = (
    sessionId = activeStatus()?.id,
    announce = true,
  ): Promise<boolean> =>
    prepareAndLaunchCodexSession(
      deps,
      mutableState,
      { installOrUpdateCodex, launchCodex, startCodexLogin },
      sessionId,
      announce,
    );

  return {
    launchCodex,
    installOrUpdateCodex,
    startCodexLogin,
    prepareAndLaunchCodex,
  };
};
