import type {
  ClaudeProjectState,
  CodexProjectState,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
} from '../../../shared/contracts';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import {
  claudeWorkbench,
  runtimeClaude,
  runtimeCodex,
  runtimePicker,
  runtimePickerLabel,
  runtimeSummaryValue,
  workbenchTabs,
  workbenchTitle,
  workbenchTrigger,
  workbenchTriggerLabel,
} from './project-state-dom';

export interface TerminalRuntimeStateActions {
  loadNextDevelopmentRuntime: () => Promise<void>;
  loadDevelopmentRuntime: (sessionId: string) => Promise<void>;
  renderDevelopmentRuntimeState: (
    state: DevelopmentRuntimeState,
    invalidatePendingLoad?: boolean,
  ) => void;
}

let nextDevelopmentRuntime: DevelopmentRuntime = 'claude';
let nextRuntimeMutationBusy = false;

const setOwnedInert = (element: HTMLElement | null, locked: boolean): void => {
  if (!element) return;
  if (locked) {
    element.dataset.sessionTransitionLocked = 'true';
    element.inert = true;
    return;
  }
  if (element.dataset.sessionTransitionLocked === 'true') {
    delete element.dataset.sessionTransitionLocked;
    element.inert = false;
  }
};

/** Locks only the active conversation surface; project rows remain usable for parallel creation. */
export const syncConversationTransitionInteractivity = (
  deps: Pick<
    TerminalProjectStateDeps,
    'claudeLaunchAttempts' | 'codexLaunchAttempts' | 'getWorkspaceState'
  >,
): void => {
  const activeSessionId = deps.getWorkspaceState().activeSessionId;
  const activeBusy = Boolean(
    document.querySelector('.terminal-mask--active') ||
    (activeSessionId &&
      (deps.claudeLaunchAttempts.isBusy(activeSessionId) ||
        deps.codexLaunchAttempts.isActive(activeSessionId))),
  );
  document.body.dataset.conversationTransition = activeBusy ? 'busy' : 'idle';
  for (const element of [
    document.querySelector<HTMLElement>('.terminal-toolbar__actions'),
    document.querySelector<HTMLElement>('.terminal-title'),
    document.querySelector<HTMLElement>('.terminal-footer'),
    document.querySelector<HTMLElement>('.terminal-composer'),
    document.querySelector<HTMLElement>('#claude-workbench'),
    document.querySelector<HTMLElement>('#restart-terminal')?.closest<HTMLElement>('.actions') ??
      null,
  ]) {
    setOwnedInert(element, activeBusy);
  }
};

const RUNTIME_SWITCH_POLL_INTERVAL_MS = 250;
const runtimeProjectKey = (cwd: string): string => cwd.toLocaleLowerCase('en-US');

interface RuntimeSwitchPoll {
  attempt: number;
  handle: number;
}

export const renderRuntimePickerControls = (
  deps: Pick<
    TerminalProjectStateDeps,
    'claudeLaunchAttempts' | 'codexLaunchAttempts' | 'getWorkspaceState'
  >,
  _sessionId?: string,
): void => {
  const conversationBusy = deps
    .getWorkspaceState()
    .sessions.some(
      ({ id }) => deps.claudeLaunchAttempts.isBusy(id) || deps.codexLaunchAttempts.isActive(id),
    );
  const busy =
    nextRuntimeMutationBusy ||
    conversationBusy ||
    Boolean(document.querySelector('.terminal-mask'));
  runtimeClaude.checked = nextDevelopmentRuntime === 'claude';
  runtimeCodex.checked = nextDevelopmentRuntime === 'codex';
  runtimePicker.disabled = busy;
  runtimePicker.setAttribute('aria-busy', String(busy));
  runtimePickerLabel.textContent = nextRuntimeMutationBusy
    ? '正在保存下次新建使用的引擎…'
    : conversationBusy
      ? '有对话正在准备，完成后可更改'
      : '新建项目开发引擎';
  runtimeSummaryValue.textContent = nextRuntimeMutationBusy
    ? `下一个对话将使用 ${nextDevelopmentRuntime === 'codex' ? 'Codex' : 'Claude Code'}…`
    : nextDevelopmentRuntime === 'codex'
      ? 'Codex · 下一个对话'
      : 'Claude Code · 下一个对话';
  syncConversationTransitionInteractivity(deps);
};

export const createTerminalRuntimeStateActions = (
  deps: TerminalProjectStateDeps,
  renderCodexLoadingState: (sessionId: string, errorMessage?: string) => void,
  renderCodexState: (state: CodexProjectState, invalidatePendingLoad?: boolean) => void,
  loadCodexState: (
    sessionId: string,
    errorMessage?: string,
  ) => Promise<CodexProjectState | undefined>,
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void,
  renderClaudeLaunchControls: (sessionId: string, launchBlocked?: boolean) => void,
  loadClaudeState: (sessionId: string) => Promise<void>,
): TerminalRuntimeStateActions => {
  const {
    getWorkspaceState,
    claudeStates,
    codexStates,
    developmentRuntimeStates,
    runtimeStateLoadGenerations,
    showToast,
    preflightFeature,
  } = deps;

  const setNextRuntime = async (runtime: DevelopmentRuntime): Promise<void> => {
    if (nextRuntimeMutationBusy || runtimePicker.disabled) {
      renderRuntimePickerControls(deps);
      return;
    }
    const previous = nextDevelopmentRuntime;
    nextDevelopmentRuntime = runtime;
    nextRuntimeMutationBusy = true;
    renderRuntimePickerControls(deps);
    try {
      nextDevelopmentRuntime = await window.controlPanel.setNextDevelopmentRuntime(runtime);
      showToast(
        `下一个新对话将使用 ${nextDevelopmentRuntime === 'codex' ? 'Codex' : 'Claude Code'}。`,
      );
    } catch (error) {
      nextDevelopmentRuntime = previous;
      showToast(error instanceof Error ? error.message : '无法保存新建项目开发引擎。', 'error');
    } finally {
      nextRuntimeMutationBusy = false;
      renderRuntimePickerControls(deps);
    }
  };

  runtimeClaude.addEventListener('change', () => {
    if (runtimeClaude.checked) void setNextRuntime('claude');
  });
  runtimeCodex.addEventListener('change', () => {
    if (runtimeCodex.checked) void setNextRuntime('codex');
  });
  document.addEventListener('workspace-terminal-preview-change', () => {
    renderRuntimePickerControls(deps);
  });
  document.addEventListener('terminal-mask-change', () => {
    renderRuntimePickerControls(deps);
  });

  const loadNextDevelopmentRuntime = async (): Promise<void> => {
    try {
      nextDevelopmentRuntime = await window.controlPanel.getNextDevelopmentRuntime();
    } catch {
      nextDevelopmentRuntime = 'claude';
    }
    renderRuntimePickerControls(deps);
  };

  const runtimeSwitchPolls = new Map<string, RuntimeSwitchPoll>();
  let disposed = false;

  const clearRuntimeSwitchPoll = (cwd: string): void => {
    const key = runtimeProjectKey(cwd);
    const poll = runtimeSwitchPolls.get(key);
    if (!poll) return;
    window.clearTimeout(poll.handle);
    runtimeSwitchPolls.delete(key);
  };

  const scheduleRuntimeSwitchPoll = (state: DevelopmentRuntimeState): void => {
    const operation = state.switchOperation;
    if (!operation || disposed) {
      clearRuntimeSwitchPoll(state.cwd);
      return;
    }
    const key = runtimeProjectKey(state.cwd);
    const current = runtimeSwitchPolls.get(key);
    if (current?.attempt === operation.attempt) {
      return;
    }
    clearRuntimeSwitchPoll(state.cwd);
    const handle = window.setTimeout(() => {
      const owned = runtimeSwitchPolls.get(key);
      if (disposed || owned?.attempt !== operation.attempt) {
        return;
      }
      runtimeSwitchPolls.delete(key);
      const session = getWorkspaceState().sessions.find(
        (candidate) => runtimeProjectKey(candidate.cwd) === key,
      );
      if (session) {
        void loadDevelopmentRuntime(session.id, true);
      }
    }, RUNTIME_SWITCH_POLL_INTERVAL_MS);
    runtimeSwitchPolls.set(key, { attempt: operation.attempt, handle });
  };

  const disposeRuntimeSwitchPolls = (): void => {
    disposed = true;
    for (const poll of runtimeSwitchPolls.values()) {
      window.clearTimeout(poll.handle);
    }
    runtimeSwitchPolls.clear();
  };
  window.addEventListener('beforeunload', disposeRuntimeSwitchPolls, { once: true });

  const renderDevelopmentRuntimeState = (
    state: DevelopmentRuntimeState,
    invalidatePendingLoad = true,
    runNetworkPreflight = true,
  ): void => {
    const workspace = getWorkspaceState();
    const key = runtimeProjectKey(state.cwd);
    const sourceSession = workspace.sessions.find(
      (session) => session.id === state.sessionId && runtimeProjectKey(session.cwd) === key,
    );
    if (!sourceSession) {
      return;
    }
    if (invalidatePendingLoad) runtimeStateLoadGenerations.invalidate(state.sessionId);
    developmentRuntimeStates.set(state.sessionId, state);
    scheduleRuntimeSwitchPoll(state);

    if (state.sessionId !== workspace.activeSessionId) {
      return;
    }
    const activeState = state;
    const codexSelected = activeState.runtime === 'codex';
    document.body.dataset.agentRuntime = activeState.runtime;
    renderRuntimePickerControls(deps);
    workbenchTabs.hidden = codexSelected;
    workbenchTitle.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    workbenchTriggerLabel.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    workbenchTrigger.title = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
    claudeWorkbench.setAttribute(
      'aria-label',
      codexSelected ? 'Codex 可视化工作台' : 'Claude 可视化工作台',
    );
    if (codexSelected) {
      const codexState = codexStates.get(activeState.sessionId);
      if (codexState) {
        renderCodexState(codexState, false);
      } else {
        renderCodexLoadingState(activeState.sessionId);
        void loadCodexState(activeState.sessionId);
      }
    } else {
      const claudeState = claudeStates.get(activeState.sessionId);
      if (claudeState) {
        renderClaudeState(claudeState, true, false);
      } else {
        renderClaudeLaunchControls(activeState.sessionId);
        void loadClaudeState(activeState.sessionId);
      }
    }
    if (runNetworkPreflight) {
      void preflightFeature.runActiveNetworkPreflight(false);
    }
  };

  async function loadDevelopmentRuntime(sessionId: string, polling = false): Promise<void> {
    const request = runtimeStateLoadGenerations.begin(sessionId);
    let state: DevelopmentRuntimeState;
    try {
      state = await window.controlPanel.getDevelopmentRuntime(sessionId);
    } catch {
      if (runtimeStateLoadGenerations.finish(request)) {
        const pending = developmentRuntimeStates.get(sessionId);
        if (pending?.switchOperation) {
          scheduleRuntimeSwitchPoll(pending);
        }
        if (!polling) {
          showToast('无法读取当前项目的开发引擎。', 'error');
        }
      }
      return;
    }
    if (disposed || !runtimeStateLoadGenerations.finish(request) || state.sessionId !== sessionId) {
      return;
    }
    renderDevelopmentRuntimeState(state, false, !polling || !state.switchOperation);
  }

  return {
    loadNextDevelopmentRuntime,
    loadDevelopmentRuntime,
    renderDevelopmentRuntimeState,
  };
};
