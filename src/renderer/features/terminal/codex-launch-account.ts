import { resultFailureMessage } from '../../platform/format';
import type { CodexProjectState, DevelopmentRuntime } from '../../../shared/contracts';
import type { CodexLaunchDeps } from './codex-launch-dependencies';
import {
  beginCodexOperation,
  codexOperationPresentation,
  finishCodexOperation,
  type CodexLaunchMutableState,
} from './codex-operation-state';
import { runtimeClaude, runtimeCodex } from './project-state-dom';

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
  mutableState: CodexLaunchMutableState,
): ((runtime: DevelopmentRuntime) => Promise<void>) => {
  const {
    getWorkspaceState,
    activeStatus,
    developmentRuntimeStates,
    runtimeStateLoadGenerations,
    terminalState,
    showToast,
    setWorkbenchOpen,
    preflightFeature,
  } = deps;

  return async (runtime: DevelopmentRuntime): Promise<void> => {
    const status = activeStatus();
    if (!status) {
      return;
    }
    const projectCwd = status.cwd.toLocaleLowerCase('en-US');
    const projectSessions = getWorkspaceState().sessions.filter(
      (session) => session.cwd.toLocaleLowerCase('en-US') === projectCwd,
    );
    if (!projectSessions.some((session) => session.id === status.id)) {
      return;
    }
    const mainOwnedState = projectSessions
      .map((session) => developmentRuntimeStates.get(session.id))
      .find((state) => state?.switchOperation);
    if (
      mainOwnedState ||
      projectSessions.some((session) => mutableState.runtimeSwitchOperations.isActive(session.id))
    ) {
      const currentState = mainOwnedState ?? developmentRuntimeStates.get(status.id);
      if (currentState) {
        terminalState.renderDevelopmentRuntimeState(
          { ...currentState, sessionId: status.id },
          false,
        );
      }
      return;
    }
    const operations = projectSessions.map((session) =>
      mutableState.runtimeSwitchOperations.begin(session.id, runtime),
    );
    const projectOperationsAreCurrent = (): boolean =>
      operations.every((candidate) => mutableState.runtimeSwitchOperations.isCurrent(candidate));
    const activeProjectStatus = (): ReturnType<typeof activeStatus> => {
      if (!projectOperationsAreCurrent()) {
        return undefined;
      }
      const active = activeStatus();
      return active?.cwd.toLocaleLowerCase('en-US') === projectCwd ? active : undefined;
    };
    const currentState = developmentRuntimeStates.get(status.id);
    if (currentState) {
      terminalState.renderDevelopmentRuntimeState(currentState, false);
    }
    try {
      const state = await window.controlPanel.setDevelopmentRuntime(status.id, runtime);
      if (!projectOperationsAreCurrent() || state.sessionId !== status.id) {
        return;
      }
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
      const activeProject = activeProjectStatus();
      if (!activeProject) return;
      terminalState.renderDevelopmentRuntimeState({ ...state, sessionId: activeProject.id });
      if (runtime === 'codex') {
        await terminalState.loadCodexState(activeProject.id);
        if (!activeProjectStatus()) return;
        setWorkbenchOpen(true);
      } else {
        await terminalState.loadClaudeState(activeProject.id);
        if (!activeProjectStatus()) return;
      }
      await preflightFeature.invalidateAndRun('provider-switch');
      if (!activeProjectStatus()) return;
      showToast(
        runtime === 'codex' ? '当前项目已切换到 Codex。' : '当前项目已切换到 Claude Code。',
      );
    } catch (error) {
      if (activeProjectStatus()) {
        showToast(error instanceof Error ? error.message : '无法切换开发引擎。', 'error');
      }
    } finally {
      let finished = false;
      for (const candidate of operations) {
        finished = mutableState.runtimeSwitchOperations.finish(candidate) || finished;
      }
      if (finished) {
        const active = activeStatus();
        const latest =
          active?.cwd.toLocaleLowerCase('en-US') === projectCwd
            ? developmentRuntimeStates.get(active.id)
            : undefined;
        if (latest) {
          terminalState.renderDevelopmentRuntimeState(latest, false);
        }
      }
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
