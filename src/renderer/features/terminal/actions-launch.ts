import { orchestrateClaudeLaunchAttempt } from '../../platform/claude-launch-attempt';
import type { ClaudeLaunchMode } from '../../../shared/contracts';
import type { TerminalActionsDependencies } from './actions-dependencies';
import type { TerminalLayout } from './terminal-layout';
import type { TerminalState } from './state';

export interface TerminalLaunchActions {
  launchClaudeTerminal: (mode: ClaudeLaunchMode) => Promise<void>;
}

export const createTerminalLaunchActions = (
  state: TerminalState,
  layout: TerminalLayout,
  dependencies: TerminalActionsDependencies,
): TerminalLaunchActions => {
  const launchClaudeTerminal = async (mode: ClaudeLaunchMode): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || dependencies.claudeLaunchAttempts.isBusy(status.id)) {
      return;
    }

    // Capture the lifecycle baseline and paint the busy state before the first await, including when
    // the renderer has not loaded a ClaudeProjectState for this session yet.
    const attempt = dependencies.beginClaudeLaunchAttempt(status);
    const outcome = await orchestrateClaudeLaunchAttempt({
      applyResult: (launchOutcome) =>
        launchOutcome.status === 'paused'
          ? dependencies.setClaudeLaunchPaused(attempt)
          : dependencies.renderClaudeLaunchResult(
              attempt,
              launchOutcome.result.state,
              launchOutcome.result.ok ? 'success' : 'failure',
            ),
      onRelease: () => dependencies.refreshClaudeLaunchControls(attempt.sessionId),
      prepare: () => state.terminalViews.get(status.id)?.terminal.clear(),
      registry: dependencies.claudeLaunchAttempts,
      start: () => window.controlPanel.launchClaude(status.id, mode),
      token: attempt,
    });
    if (outcome.status === 'rejected') {
      dependencies.showToast('无法启动 Claude Code。', 'error');
      return;
    }
    if (outcome.status !== 'resolved') {
      return;
    }

    let launchOutcome = outcome.result;
    if (launchOutcome.status === 'paused') {
      const decision = await dependencies.resolveClaudeLaunchDecision(attempt, launchOutcome);
      if (decision.status !== 'completed') return;
      launchOutcome = decision;
      if (
        !dependencies.renderClaudeLaunchResult(
          attempt,
          launchOutcome.result.state,
          launchOutcome.result.ok ? 'success' : 'failure',
        )
      ) {
        return;
      }
    }

    const { result } = launchOutcome;
    if (!result.ok) {
      dependencies.failClaudeLaunchAttempt(attempt);
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '无法启动 Claude Code。'),
        'error',
      );
      return;
    }
    dependencies.setNativePanelVisible(false);
    dependencies.showToast(
      mode === 'new'
        ? `已在 ${dependencies.projectNameFromPath(status.cwd)} 启动新会话`
        : mode === 'continue'
          ? '正在续接当前项目最近的会话'
          : '已打开当前项目的历史会话选择器',
    );
    // `resume` opens Claude's own arrow-key picker, which needs the raw keystrokes.
    if (mode === 'resume') {
      state.terminalViews.get(status.id)?.terminal.focus();
    } else {
      layout.requestComposerFocus(status.id);
    }
  };

  return {
    launchClaudeTerminal,
  };
};
