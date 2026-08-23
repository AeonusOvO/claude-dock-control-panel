import { orchestrateClaudeLaunchAttempt } from '../../platform/claude-launch-attempt';
import type { ClaudeRelaunchInput } from '../../../shared/contracts';
import type { TerminalIoDependencies } from './terminal-io-dependencies';

export interface TerminalIoRelaunchActions {
  relaunchClaudeSession: (
    summary: string,
    input: Omit<ClaudeRelaunchInput, 'compactFirst'>,
  ) => Promise<void>;
}

export const createTerminalIoRelaunchActions = (
  dependencies: TerminalIoDependencies,
  beginTerminalMask: (sessionId: string, label: string) => () => void,
): TerminalIoRelaunchActions => {
  /**
   * Restarts the PTY and reattaches with `--continue`. Used by both cross-endpoint model switches and
   * by 「仅预批准」, which Claude Code only accepts as a launch argument. Compaction is offered because
   * the restored history may not fit a model whose context window is narrower than the current one's.
   */
  const relaunchClaudeSession = async (
    summary: string,
    input: Omit<ClaudeRelaunchInput, 'compactFirst'>,
  ): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || dependencies.claudeLaunchAttempts.isBusy(status.id)) {
      return;
    }
    const attempt = dependencies.beginClaudeLaunchAttempt(status);
    let endMask = (): void => undefined;
    let loadStateAfterCompletion = false;
    try {
      const outcome = await orchestrateClaudeLaunchAttempt({
        applyResult: (launchOutcome) =>
          launchOutcome.status === 'paused' ||
          dependencies.renderClaudeLaunchResult(
            attempt,
            launchOutcome.result.state,
            launchOutcome.result.ok ? 'success' : 'failure',
          ),
        confirmation: () =>
          dependencies.requestConfirmation({
            confirmLabel: '压缩并重启',
            message: `${summary}\n\n这需要重启 Claude Code 会话。对话历史会通过 --continue 恢复，但终端画面会重绘。\n\n确定后会先压缩上下文再重启。`,
            title: '重启 Claude Code 会话',
          }),
        onRelease: () => dependencies.refreshClaudeLaunchControls(attempt.sessionId),
        prepare: () => {
          endMask = beginTerminalMask(status.id, '正在压缩上下文并恢复会话');
        },
        registry: dependencies.claudeLaunchAttempts,
        start: () =>
          window.controlPanel.relaunchClaudeSession(status.id, {
            ...input,
            compactFirst: true,
          }),
        token: attempt,
      });
      if (outcome.status === 'rejected') {
        loadStateAfterCompletion = true;
        dependencies.showToast('重启会话时发生异常。', 'error');
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
      loadStateAfterCompletion = true;
      if (!result.ok) {
        dependencies.failClaudeLaunchAttempt(attempt);
      }
      dependencies.showToast(
        result.ok
          ? '会话已重启并恢复上下文。'
          : dependencies.resultFailureMessage(result, '重启会话失败。'),
        result.ok ? 'success' : 'error',
      );
    } finally {
      endMask();
      if (loadStateAfterCompletion) {
        void dependencies.loadClaudeState(status.id);
      }
    }
  };

  return { relaunchClaudeSession };
};
