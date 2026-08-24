import { projectNameFromPath, resultFailureMessage } from '../../platform/format';
import type {
  CodexLaunchMode,
  CodexLoginMethod,
  CodexProjectState,
} from '../../../shared/contracts';
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
  deps: Pick<CodexLaunchDeps, 'activeDevelopmentRuntime' | 'getWorkspaceState'>,
  mutableState: CodexLaunchMutableState,
  state: CodexProjectState,
): boolean =>
  mutableState.codexAutoLaunchSessionId === state.sessionId &&
  Boolean(state.account) &&
  state.sessionId === deps.getWorkspaceState().activeSessionId &&
  deps.activeDevelopmentRuntime() === 'codex';

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
  launchCodex: (mode: CodexLaunchMode) => Promise<void>;
  installOrUpdateCodex: () => Promise<CodexProjectState | undefined>;
  startCodexLogin: (method: CodexLoginMethod, launchAfterLogin: boolean) => Promise<void>;
  prepareAndLaunchCodex: () => Promise<void>;
}

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

  const launchCodex = async (mode: CodexLaunchMode): Promise<void> => {
    const status = activeStatus();
    if (
      !status ||
      codexLaunchAttempts.isActive(status.id) ||
      codexOperationAdmissionBlocked(mutableState, codexStates)
    ) {
      return;
    }
    const attempt = codexLaunchAttempts.begin(status.id);
    const existingState = codexStates.get(status.id);
    if (existingState) {
      terminalState.renderCodexState(existingState, false);
    }
    try {
      if (!codexLaunchAttempts.isCurrent(attempt)) {
        return;
      }
      terminalFeature.getTerminalView(status.id)?.terminal.clear();
      if (!codexLaunchAttempts.isCurrent(attempt)) {
        return;
      }
      const result = await window.controlPanel.launchCodex(status.id, mode);
      if (!codexLaunchAttempts.isCurrent(attempt) || result.state.sessionId !== attempt.sessionId) {
        return;
      }
      terminalState.renderCodexState(result.state);
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法启动 Codex。'), 'error');
        return;
      }
      showToast(
        mode === 'new'
          ? `已在 ${projectNameFromPath(status.cwd)} 启动 Codex`
          : mode === 'continue'
            ? '正在续接当前项目最近的 Codex 会话'
            : '已打开 Codex 历史会话选择器',
      );
      if (mode === 'resume') {
        terminalFeature.getTerminalView(status.id)?.terminal.focus();
      } else {
        terminalFeature.requestComposerFocus(status.id);
      }
    } catch {
      if (codexLaunchAttempts.isCurrent(attempt)) {
        showToast('无法启动 Codex。', 'error');
      }
    } finally {
      if (codexLaunchAttempts.finish(attempt)) {
        const latest = codexStates.get(status.id);
        if (latest) {
          terminalState.renderCodexState(latest, false);
        }
      }
    }
  };

  const installOrUpdateCodex = async (): Promise<CodexProjectState | undefined> => {
    const status = activeStatus();
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
  ): Promise<void> => {
    const status = activeStatus();
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
            void launchCodex('new');
          }
        }
      }
    }
  };

  const prepareAndLaunchCodex = async (): Promise<void> => {
    const status = activeStatus();
    if (
      !status ||
      codexOperationAdmissionBlocked(mutableState, codexStates) ||
      codexLaunchAttempts.isActive(status.id)
    ) {
      return;
    }
    const stillOwnsActiveSession = (): boolean => activeStatus()?.id === status.id;
    let state = codexStates.get(status.id);
    if (!state) {
      state = await terminalState.loadCodexState(status.id, '无法读取 Codex 环境。');
      if (!state || !stillOwnsActiveSession()) {
        return;
      }
    }
    if (!state.installation.installed) {
      state = await installOrUpdateCodex();
      if (!state || !stillOwnsActiveSession()) {
        return;
      }
    }
    if (state.requiresOpenaiAuth && !state.account) {
      await startCodexLogin('browser', true);
      return;
    }
    await launchCodex('new');
  };

  return {
    launchCodex,
    installOrUpdateCodex,
    startCodexLogin,
    prepareAndLaunchCodex,
  };
};
