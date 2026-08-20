import { projectNameFromPath, resultFailureMessage } from '../../platform/format';
import type {
  CodexLaunchMode,
  CodexLoginMethod,
  CodexProjectState,
} from '../../../shared/contracts';
import type { CodexLaunchDeps, CodexLaunchMutableState } from './codex-launch-dependencies';

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
    getWorkspaceState,
    activeStatus,
    activeDevelopmentRuntime,
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
      mutableState.codexOperationInProgress
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
    if (!status || mutableState.codexOperationInProgress) {
      return undefined;
    }
    mutableState.codexOperationInProgress = true;
    const existing = codexStates.get(status.id);
    if (existing) {
      terminalState.renderCodexState(existing, false);
    }
    try {
      const result = await window.controlPanel.installOrUpdateCodex(status.id);
      terminalState.renderCodexState(result.state);
      if (!result.ok) {
        showToast(resultFailureMessage(result, 'Codex 安装失败。'), 'error');
        return undefined;
      }
      showToast(`Codex CLI ${result.state.installation.version ?? ''} 已就绪。`);
      return result.state;
    } catch {
      showToast('Codex 安装失败，请检查网络后重试。', 'error');
      return undefined;
    } finally {
      mutableState.codexOperationInProgress = false;
      const latest = codexStates.get(status.id);
      if (latest) {
        terminalState.renderCodexState(latest, false);
      }
    }
  };

  const startCodexLogin = async (
    method: CodexLoginMethod,
    launchAfterLogin: boolean,
  ): Promise<void> => {
    const status = activeStatus();
    if (!status || mutableState.codexOperationInProgress) {
      return;
    }
    mutableState.codexOperationInProgress = true;
    if (launchAfterLogin) {
      mutableState.codexAutoLaunchSessionId = status.id;
    }
    const existing = codexStates.get(status.id);
    if (existing) {
      terminalState.renderCodexState(existing, false);
    }
    try {
      const result = await window.controlPanel.startCodexLogin(status.id, method);
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
      mutableState.codexAutoLaunchSessionId = '';
      showToast('无法启动 ChatGPT 登录。', 'error');
    } finally {
      mutableState.codexOperationInProgress = false;
      const latest = codexStates.get(status.id);
      if (latest) {
        terminalState.renderCodexState(latest, false);
        if (
          mutableState.codexAutoLaunchSessionId === latest.sessionId &&
          latest.account &&
          latest.sessionId === getWorkspaceState().activeSessionId &&
          activeDevelopmentRuntime() === 'codex'
        ) {
          mutableState.codexAutoLaunchSessionId = '';
          void launchCodex('new');
        }
      }
    }
  };

  const prepareAndLaunchCodex = async (): Promise<void> => {
    const status = activeStatus();
    if (
      !status ||
      mutableState.codexOperationInProgress ||
      codexLaunchAttempts.isActive(status.id)
    ) {
      return;
    }
    let state = codexStates.get(status.id);
    if (!state) {
      state = await terminalState.loadCodexState(status.id, '无法读取 Codex 环境。');
      if (!state) {
        return;
      }
    }
    if (!state.installation.installed) {
      state = await installOrUpdateCodex();
      if (!state) {
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
