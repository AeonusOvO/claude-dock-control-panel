import { resultFailureMessage } from '../../platform/format';
import type { CodexProjectState, DevelopmentRuntime } from '../../../shared/contracts';
import type { CodexLaunchDeps } from './codex-launch-dependencies';
import {
  beginCodexOperation,
  codexOperationPresentation,
  finishCodexOperation,
  type CodexLaunchMutableState,
} from './codex-operation-state';

export interface CodexLaunchAccountActions {
  switchDevelopmentRuntime: (runtime: DevelopmentRuntime) => Promise<void>;
  cancelCodexLogin: () => void;
  logoutCodex: () => void;
}

const renderActiveCodexState = (
  deps: Pick<CodexLaunchDeps, 'activeStatus' | 'codexStates' | 'terminalState'>,
): void => {
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
};

const codexResultIsCurrent = (
  states: ReadonlyMap<string, CodexProjectState>,
  sessionId: string,
  revision: number,
): boolean => {
  const current = states.get(sessionId);
  return !current || revision >= current.revision;
};

const createRuntimeSwitchAction = (
  deps: CodexLaunchDeps,
  _mutableState: CodexLaunchMutableState,
): ((runtime: DevelopmentRuntime) => Promise<void>) => {
  return async (runtime: DevelopmentRuntime): Promise<void> => {
    try {
      await window.controlPanel.setNextDevelopmentRuntime(runtime);
      await deps.terminalState.loadNextDevelopmentRuntime();
      deps.showToast(`下一个新对话将使用 ${runtime === 'codex' ? 'Codex' : 'Claude Code'}。`);
    } catch (error) {
      deps.showToast(
        error instanceof Error ? error.message : '无法保存新建项目开发引擎。',
        'error',
      );
    }
  };
};

export const createCodexLaunchAccountActions = (
  deps: CodexLaunchDeps,
  mutableState: CodexLaunchMutableState,
): CodexLaunchAccountActions => {
  const { activeStatus, codexStates, terminalState, requestConfirmation, showToast } = deps;

  const switchDevelopmentRuntime = createRuntimeSwitchAction(deps, mutableState);

  const cancelCodexLogin = (): void => {
    const status = activeStatus();
    if (!status || Boolean(codexOperationPresentation(mutableState, codexStates))) {
      return;
    }
    const operation = beginCodexOperation(mutableState, codexStates, status.id, 'cancel-login');
    mutableState.codexAutoLaunchSessionId = '';
    const existing = codexStates.get(status.id);
    if (existing) {
      terminalState.renderCodexState(existing, false);
    }
    void window.controlPanel
      .cancelCodexLogin(status.id)
      .then((result) => {
        if (
          !mutableState.codexOperations.isCurrent(operation) ||
          result.state.sessionId !== operation.sessionId
        ) {
          return;
        }
        terminalState.renderCodexState(result.state);
        if (!result.ok) {
          showToast(resultFailureMessage(result, '无法取消 Codex 登录。'), 'error');
        }
      })
      .catch(() => {
        if (mutableState.codexOperations.isCurrent(operation)) {
          showToast('无法取消 Codex 登录。', 'error');
        }
      })
      .finally(() => {
        if (finishCodexOperation(mutableState, operation)) {
          renderActiveCodexState(deps);
        }
      });
  };

  const logoutCodex = (): void => {
    const status = activeStatus();
    if (!status || Boolean(codexOperationPresentation(mutableState, codexStates))) {
      return;
    }
    void requestConfirmation({
      confirmLabel: '退出账号',
      message: '这会让 Codex CLI 与共用其登录缓存的官方客户端退出当前账号，是否继续？',
      title: '退出 Codex 账号',
    }).then((confirmed) => {
      if (
        !confirmed ||
        activeStatus()?.id !== status.id ||
        Boolean(codexOperationPresentation(mutableState, codexStates))
      ) {
        return;
      }
      const operation = beginCodexOperation(mutableState, codexStates, status.id, 'logout');
      const existing = codexStates.get(status.id);
      if (existing) {
        terminalState.renderCodexState(existing, false);
      }
      void window.controlPanel
        .logoutCodex(status.id)
        .then((result) => {
          if (
            !mutableState.codexOperations.isCurrent(operation) ||
            result.state.sessionId !== operation.sessionId ||
            !codexResultIsCurrent(codexStates, operation.sessionId, result.state.revision)
          ) {
            return;
          }
          terminalState.renderCodexState(result.state);
          showToast(
            result.ok ? '已退出 Codex 账号。' : resultFailureMessage(result, '退出失败。'),
            result.ok ? 'success' : 'error',
          );
        })
        .catch(() => {
          if (mutableState.codexOperations.isCurrent(operation)) {
            showToast('无法退出 Codex 账号。', 'error');
          }
        })
        .finally(() => {
          if (finishCodexOperation(mutableState, operation)) {
            renderActiveCodexState(deps);
          }
        });
    });
  };

  return {
    switchDevelopmentRuntime,
    cancelCodexLogin,
    logoutCodex,
  };
};
