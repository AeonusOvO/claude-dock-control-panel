import { officialNetworkProviderForClaudePreset } from '../../../shared/claude/providers';
import { orchestrateClaudeLaunchAttempt } from '../../platform/claude-launch-attempt';
import type { ClaudeLaunchMode } from '../../../shared/contracts';
import type { TerminalActionsDependencies } from './actions-dependencies';
import type { TerminalLayout } from './terminal-layout';
import type { TerminalState } from './state';

export type ClaudeLaunchProgressListener = (label: string) => void;

export interface TerminalLaunchActions {
  launchClaudeTerminal: (mode: ClaudeLaunchMode) => Promise<void>;
  launchClaudeSession: (
    sessionId: string,
    mode: ClaudeLaunchMode,
    announce?: boolean,
    onProgress?: ClaudeLaunchProgressListener,
  ) => Promise<boolean>;
}

export const createTerminalLaunchActions = (
  state: TerminalState,
  layout: TerminalLayout,
  dependencies: TerminalActionsDependencies,
): TerminalLaunchActions => {
  const launchAuthorizationPhase = (sessionId: string): 'authorizing-launch' | 'starting' => {
    const config = dependencies.getClaudeState?.(sessionId)?.config;
    const preset = config?.preset;
    const networkAccessRequired =
      Boolean(preset && officialNetworkProviderForClaudePreset(preset)) ||
      (config?.protocol !== 'openai' && Boolean(config?.baseUrl.trim()));
    return networkAccessRequired ? 'authorizing-launch' : 'starting';
  };

  const launchClaudeSession = async (
    sessionId: string,
    mode: ClaudeLaunchMode,
    announce = true,
    onProgress?: ClaudeLaunchProgressListener,
  ): Promise<boolean> => {
    const status = dependencies
      .getWorkspaceState()
      .sessions.find((candidate) => candidate.id === sessionId);
    if (!status || dependencies.claudeLaunchAttempts.isBusy(status.id)) {
      return false;
    }

    // Capture the lifecycle baseline and paint the busy state before the first await, including when
    // the renderer has not loaded a ClaudeProjectState for this session yet.
    onProgress?.('正在读取配置…');
    const attempt = dependencies.beginClaudeLaunchAttempt(status);
    const outcome = await orchestrateClaudeLaunchAttempt({
      applyResult: (launchOutcome) => {
        if (launchOutcome.status === 'paused') {
          onProgress?.('等待网络确认…');
          return dependencies.setClaudeLaunchPaused(attempt);
        }
        return dependencies.renderClaudeLaunchResult(
          attempt,
          launchOutcome.result.state,
          launchOutcome.result.ok ? 'success' : 'failure',
        );
      },
      onRelease: () => dependencies.refreshClaudeLaunchControls(attempt.sessionId),
      prepare: () => {
        dependencies.setClaudeLaunchPresentationPhase(attempt, 'preparing-terminal');
        onProgress?.('正在准备 Claude Code 终端…');
        state.terminalViews.get(status.id)?.terminal.clear();
      },
      registry: dependencies.claudeLaunchAttempts,
      start: () => {
        const phase = launchAuthorizationPhase(status.id);
        dependencies.setClaudeLaunchPresentationPhase(attempt, phase);
        onProgress?.(phase === 'authorizing-launch' ? '正在准备网络访问…' : '正在启动 Claude Code…');
        return window.controlPanel.launchClaude(status.id, mode);
      },
      token: attempt,
    });
    if (outcome.status === 'rejected') {
      if (announce) dependencies.showToast('无法启动 Claude Code。', 'error');
      return false;
    }
    if (outcome.status !== 'resolved') {
      return false;
    }

    let launchOutcome = outcome.result;
    if (launchOutcome.status === 'paused') {
      const decision = await dependencies.resolveClaudeLaunchDecision(attempt, launchOutcome);
      if (decision.status !== 'completed') return false;
      launchOutcome = decision;
      if (
        !dependencies.renderClaudeLaunchResult(
          attempt,
          launchOutcome.result.state,
          launchOutcome.result.ok ? 'success' : 'failure',
        )
      ) {
        return false;
      }
    }

    const { result } = launchOutcome;
    if (!result.ok) {
      dependencies.failClaudeLaunchAttempt(attempt);
      if (announce) {
        dependencies.showToast(
          dependencies.resultFailureMessage(result, '无法启动 Claude Code。'),
          'error',
        );
      }
      return false;
    }
    const stillActive = dependencies.getWorkspaceState().activeSessionId === status.id;
    if (stillActive) dependencies.setNativePanelVisible(false);
    if (announce) {
      dependencies.showToast(
        mode === 'new'
          ? `已在 ${dependencies.projectNameFromPath(status.cwd)} 启动新会话`
          : mode === 'continue'
            ? '正在续接当前项目最近的会话'
            : '已打开当前项目的历史会话选择器',
      );
    }
    // `resume` opens Claude's own arrow-key picker, which needs the raw keystrokes.
    if (!stillActive) return true;
    if (mode === 'resume') {
      state.terminalViews.get(status.id)?.terminal.focus();
    } else {
      layout.requestComposerFocus(status.id);
    }
    return true;
  };

  const launchClaudeTerminal = async (mode: ClaudeLaunchMode): Promise<void> => {
    const status = dependencies.activeStatus();
    if (status) await launchClaudeSession(status.id, mode);
  };

  return {
    launchClaudeTerminal,
    launchClaudeSession,
  };
};
