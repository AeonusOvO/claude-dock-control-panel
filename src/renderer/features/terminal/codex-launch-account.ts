import { requiredElement } from '../../platform/dom';
import { resultFailureMessage } from '../../platform/format';
import type { DevelopmentRuntime } from '../../../shared/contracts';
import type { CodexLaunchDeps, CodexLaunchMutableState } from './codex-launch-dependencies';

const runtimeClaude = requiredElement<HTMLInputElement>('#runtime-claude');
const runtimeCodex = requiredElement<HTMLInputElement>('#runtime-codex');
const runtimePicker = requiredElement<HTMLFieldSetElement>('#runtime-picker');

export interface CodexLaunchAccountActions {
  switchDevelopmentRuntime: (runtime: DevelopmentRuntime) => Promise<void>;
  cancelCodexLogin: () => void;
  logoutCodex: () => void;
}

export const createCodexLaunchAccountActions = (
  deps: CodexLaunchDeps,
  mutableState: CodexLaunchMutableState,
): CodexLaunchAccountActions => {
  const {
    getWorkspaceState,
    activeStatus,
    codexStates,
    developmentRuntimeStates,
    runtimeStateLoadGenerations,
    terminalState,
    requestConfirmation,
    showToast,
    setWorkbenchOpen,
    preflightFeature,
  } = deps;

  const switchDevelopmentRuntime = async (runtime: DevelopmentRuntime): Promise<void> => {
    const status = activeStatus();
    if (!status || runtimePicker.disabled) {
      return;
    }
    runtimePicker.disabled = true;
    try {
      const state = await window.controlPanel.setDevelopmentRuntime(status.id, runtime);
      const normalizedCwd = state.cwd.toLocaleLowerCase('en-US');
      for (const session of getWorkspaceState().sessions) {
        if (session.cwd.toLocaleLowerCase('en-US') === normalizedCwd) {
          runtimeStateLoadGenerations.invalidate(session.id);
          developmentRuntimeStates.set(session.id, {
            ...state,
            sessionId: session.id,
          });
        }
      }
      terminalState.renderDevelopmentRuntimeState({
        ...state,
        sessionId: status.id,
      });
      if (runtime === 'codex') {
        await terminalState.loadCodexState(status.id);
        setWorkbenchOpen(true);
      } else {
        await terminalState.loadClaudeState(status.id);
      }
      await preflightFeature.invalidateAndRun('provider-switch');
      showToast(
        runtime === 'codex' ? '当前项目已切换到 Codex。' : '当前项目已切换到 Claude Code。',
      );
    } catch (error) {
      const current = developmentRuntimeStates.get(status.id)?.runtime ?? 'claude';
      runtimeClaude.checked = current === 'claude';
      runtimeCodex.checked = current === 'codex';
      showToast(error instanceof Error ? error.message : '无法切换开发引擎。', 'error');
    } finally {
      runtimePicker.disabled = false;
    }
  };

  const cancelCodexLogin = (): void => {
    const status = activeStatus();
    if (!status || mutableState.codexOperationInProgress) {
      return;
    }
    mutableState.codexOperationInProgress = true;
    mutableState.codexAutoLaunchSessionId = '';
    void window.controlPanel
      .cancelCodexLogin(status.id)
      .then((result) => {
        terminalState.renderCodexState(result.state);
        if (!result.ok) {
          showToast(resultFailureMessage(result, '无法取消 Codex 登录。'), 'error');
        }
      })
      .catch(() => {
        showToast('无法取消 Codex 登录。', 'error');
      })
      .finally(() => {
        mutableState.codexOperationInProgress = false;
        const latest = codexStates.get(status.id);
        if (latest) {
          terminalState.renderCodexState(latest, false);
        }
      });
  };

  const logoutCodex = (): void => {
    const status = activeStatus();
    if (!status || mutableState.codexOperationInProgress) {
      return;
    }
    void requestConfirmation({
      confirmLabel: '退出账号',
      message: '这会让 Codex CLI 与共用其登录缓存的官方客户端退出当前账号，是否继续？',
      title: '退出 Codex 账号',
    }).then((confirmed) => {
      if (!confirmed) {
        return;
      }
      mutableState.codexOperationInProgress = true;
      void window.controlPanel
        .logoutCodex(status.id)
        .then((result) => {
          terminalState.renderCodexState(result.state);
          showToast(
            result.ok ? '已退出 Codex 账号。' : resultFailureMessage(result, '退出失败。'),
            result.ok ? 'success' : 'error',
          );
        })
        .catch(() => {
          showToast('无法退出 Codex 账号。', 'error');
        })
        .finally(() => {
          mutableState.codexOperationInProgress = false;
          const latest = codexStates.get(status.id);
          if (latest) {
            terminalState.renderCodexState(latest, false);
          }
        });
    });
  };

  runtimeClaude.addEventListener('change', () => {
    if (runtimeClaude.checked) {
      void switchDevelopmentRuntime('claude');
    }
  });
  runtimeCodex.addEventListener('change', () => {
    if (runtimeCodex.checked) {
      void switchDevelopmentRuntime('codex');
    }
  });

  return {
    switchDevelopmentRuntime,
    cancelCodexLogin,
    logoutCodex,
  };
};
