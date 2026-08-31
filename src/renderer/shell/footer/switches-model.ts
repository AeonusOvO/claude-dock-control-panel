import { orchestrateSessionOperation } from '../../platform/session-generation';
import type { ClaudeModelOption, ModelSpeedMode } from '../../../shared/contracts';
import { footerModel } from './elements';
import type { FooterMenus } from './menus';
import { footerState } from './state';
import type { FooterSwitchesDeps } from './switches-dependencies';

export interface FooterSwitchesModelActions {
  switchClaudeModel: (option: ClaudeModelOption) => Promise<void>;
  switchClaudeModelSpeed: (mode: ModelSpeedMode) => Promise<void>;
}

export const createFooterSwitchesModelActions = (
  deps: FooterSwitchesDeps,
  menus: FooterMenus,
): FooterSwitchesModelActions => {
  const {
    activeStatus,
    beginClaudeLaunchAttempt,
    beginTerminalMask,
    claudeLaunchAttempts,
    claudeSpeedOperations,
    claudeStates,
    failClaudeLaunchAttempt,
    loadClaudeState,
    refreshClaudeLaunchControls,
    relaunchClaudeSession,
    renderClaudeState,
    requestConfirmation,
    resultFailureMessage,
    showToast,
  } = deps;
  const { modelSpeedFastLabel } = menus;

  const switchClaudeModel = async (option: ClaudeModelOption): Promise<void> => {
    const status = activeStatus();
    if (!status || footerState.modelSwitchInProgress) {
      return;
    }
    if (option.requiresRelaunch) {
      const summary =
        option.relaunchReason === 'connection'
          ? `切换到「${option.providerLabel} · ${option.model}」需要更换接口地址与凭据。`
          : option.relaunchReason === 'speed-profile'
            ? `切换到「${option.providerLabel} · ${option.model}」会同时应用该模型已保存的服务速度配置。`
            : `切换到「${option.providerLabel} · ${option.model}」需要重启当前会话。`;
      await relaunchClaudeSession(summary, { modelOptionId: option.id });
      return;
    }

    footerState.modelSwitchInProgress = true;
    footerModel.disabled = true;
    footerModel.setAttribute('aria-busy', 'true');
    const endMask = beginTerminalMask(status.id, '正在切换模型');
    try {
      const result = await window.controlPanel.switchClaudeModel(status.id, option.id);
      renderClaudeState(result.state);
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法切换模型。'), 'error');
      }
    } catch {
      showToast('切换模型时发生异常。', 'error');
    } finally {
      endMask();
      footerState.modelSwitchInProgress = false;
      footerModel.disabled = false;
      footerModel.setAttribute('aria-busy', 'false');
      const knownState = claudeStates.get(status.id);
      if (knownState) {
        renderClaudeState(knownState, true, false);
      }
      void loadClaudeState(status.id);
    }
  };

  const switchClaudeModelSpeed = async (mode: ModelSpeedMode): Promise<void> => {
    const status = activeStatus();
    const state = status ? claudeStates.get(status.id) : undefined;
    if (
      !status ||
      !state ||
      claudeSpeedOperations.isActive(status.id) ||
      claudeLaunchAttempts.isBusy(status.id)
    ) {
      return;
    }
    if (mode === 'fast' && !state.speed.canSelectFast) {
      showToast(state.speed.detail, 'error');
      return;
    }

    const operation = claudeSpeedOperations.begin(status.id);
    const attempt = beginClaudeLaunchAttempt(status, state);
    deps.setClaudeLaunchPresentationPhase(attempt, 'awaiting-restart-confirmation');
    renderClaudeState(state, false, false);
    const fastLabel = modelSpeedFastLabel(state);
    const speedDetail =
      mode === 'standard'
        ? `将「${state.speed.model}」恢复为标准服务速度。`
        : state.speed.mechanism === 'claude-native-fast'
          ? `将「${state.speed.model}」切换为 ${fastLabel}。Claude Fast 仅适用于受支持的模型，并可能按更高单价计费；组织资格、额度和实际加速仍由 Anthropic 判定。`
          : `将为「${state.speed.model}」请求 ${fastLabel}（service_tier=fast）。该档位的额度消耗或计价可能更高；ClaudeDock 只能确认请求已发送，无法确认 ChatGPT 上游最终采用。`;
    const lifecycleDetail =
      '如果主进程确认 Claude Code 仍在运行，ClaudeDock 会重启当前 PowerShell，并通过 --resume 精确恢复当前对话；不会压缩上下文。如果会话已经停止，则只保存此接入与模型的速度偏好，供下次新建或恢复时使用。';
    let endMask = (): void => undefined;
    try {
      const outcome = await orchestrateSessionOperation({
        applyResult: (result) => {
          if (result.state.sessionId !== operation.sessionId) {
            return false;
          }
          return deps.renderClaudeLaunchResult(
            attempt,
            result.state,
            result.ok ? 'success' : 'failure',
          );
        },
        confirmation: () =>
          requestConfirmation({
            confirmLabel: '确认切换',
            message: `${speedDetail}\n\n${lifecycleDetail}`,
            title: '切换服务速度',
          }),
        onCancel: () => {
          if (claudeLaunchAttempts.cancel(attempt)) {
            refreshClaudeLaunchControls(attempt.sessionId);
          }
        },
        registry: claudeSpeedOperations,
        start: () => {
          if (!claudeLaunchAttempts.isCurrent(attempt)) {
            throw new Error('确认期间会话状态已经变化。');
          }
          deps.setClaudeLaunchPresentationPhase(attempt, 'relaunching-conversation');
          endMask = beginTerminalMask(status.id, '正在应用服务速度设置');
          return window.controlPanel.setClaudeModelSpeed(status.id, mode);
        },
        token: operation,
      });
      if (outcome.status === 'rejected') {
        failClaudeLaunchAttempt(attempt);
        showToast('切换服务速度时发生异常。', 'error');
        return;
      }
      if (outcome.status !== 'resolved') {
        return;
      }

      const { result } = outcome;
      if (!result.ok) {
        failClaudeLaunchAttempt(attempt);
        showToast(resultFailureMessage(result, '无法切换服务速度。'), 'error');
        return;
      }
      if (!result.state.active) {
        if (claudeLaunchAttempts.cancel(attempt)) {
          refreshClaudeLaunchControls(attempt.sessionId);
        }
        showToast('速度偏好已保存；下次新建或恢复会话时生效。', 'success');
      } else if (mode === 'standard') {
        showToast('已按标准速度恢复当前对话。', 'success');
      } else if (result.state.speed.mechanism === 'gpt-service-tier') {
        showToast('已为当前对话请求 GPT Fast；上游是否采用仍由服务端决定。', 'success');
      } else {
        showToast('已请求 Claude Fast；是否生效将由 Claude Code 状态行确认。', 'success');
      }
    } finally {
      endMask();
      if (claudeSpeedOperations.finish(operation)) {
        const knownState = claudeStates.get(status.id);
        if (knownState) {
          renderClaudeState(knownState, true, false);
        }
        void loadClaudeState(status.id);
      }
    }
  };

  return {
    switchClaudeModel,
    switchClaudeModelSpeed,
  };
};
