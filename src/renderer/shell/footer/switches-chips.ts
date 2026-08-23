import { claudeEffortLabel } from '../../../shared/claude/effort';
import type { ClaudeProjectState } from '../../../shared/contracts';
import { footerEffort, footerMode, footerModel, footerSpeed } from './elements';
import type { FooterMenus } from './menus';
import { footerState } from './state';
import type { FooterSwitchesDeps } from './switches-dependencies';

export interface FooterSwitchesChipsActions {
  renderTerminalFooterChips: (state: ClaudeProjectState) => void;
}

export const createFooterSwitchesChipsActions = (
  deps: FooterSwitchesDeps,
  menus: FooterMenus,
): FooterSwitchesChipsActions => {
  const { claudeSpeedOperations, claudeLaunchAttempts, effortRecoveryNotifications, showToast } =
    deps;
  const { modelSpeedFooterLabel, permissionModeLabel } = menus;

  const renderTerminalFooterChips = (state: ClaudeProjectState): void => {
    const metrics = state.metrics;
    for (const chip of [footerModel, footerSpeed, footerMode, footerEffort]) {
      chip.dataset.presentationOwner = 'terminal';
    }
    footerModel.textContent = `模型 ${metrics?.modelDisplayName ?? metrics?.modelId ?? '—'}`;
    footerModel.disabled = footerState.modelSwitchInProgress;
    footerModel.setAttribute('aria-busy', String(footerState.modelSwitchInProgress));
    footerModel.title = state.active ? '点击切换模型' : '启动 Claude Code 后可切换模型';
    const speedOperationActive = claudeSpeedOperations.isActive(state.sessionId);
    footerSpeed.textContent = modelSpeedFooterLabel(state);
    footerSpeed.dataset.availability = state.speed.availability;
    footerSpeed.dataset.mechanism = state.speed.mechanism;
    footerSpeed.dataset.status = state.speed.status;
    delete footerSpeed.dataset.state;
    footerSpeed.disabled =
      speedOperationActive ||
      claudeLaunchAttempts.isBusy(state.sessionId) ||
      footerState.modelSwitchInProgress;
    footerSpeed.setAttribute('aria-busy', String(speedOperationActive));
    footerSpeed.title = state.speed.detail;
    const requestedPermissionMode = state.permissionModeRequest ?? state.permissionMode;
    footerMode.textContent = `模式 ${permissionModeLabel(state.permissionMode)}`;
    footerMode.dataset.mode = state.permissionMode ?? 'unknown';
    footerMode.dataset.requestedMode = requestedPermissionMode ?? 'unknown';
    footerMode.disabled = footerState.modeSwitchInProgress;
    footerMode.title = state.active
      ? requestedPermissionMode !== state.permissionMode
        ? `请求：${permissionModeLabel(requestedPermissionMode)} · 实际：${permissionModeLabel(state.permissionMode)}；点击切换权限模式`
        : '点击切换权限模式，或在终端按 Shift+Tab'
      : '启动 Claude Code 后可切换权限模式';
    // The status line reports what Claude Code applied, which can sit below a request the model caps.
    const effortApplied = state.metrics?.effortLevel;
    const effortShown =
      state.effortRequest === 'ultracode'
        ? 'ultracode'
        : state.effortCompatibility?.recovery === 'recovered'
          ? (state.effortRequest ?? effortApplied)
          : (effortApplied ?? state.effortRequest);
    footerEffort.textContent = `思考 ${claudeEffortLabel(effortShown)}`;
    footerEffort.dataset.effort = effortShown ?? 'unknown';
    footerEffort.dataset.requestedEffort = state.effortRequest ?? 'unknown';
    footerEffort.dataset.appliedEffort = effortApplied ?? 'unknown';
    footerEffort.disabled =
      footerState.effortSwitchInProgress || state.effortCompatibility?.recovery === 'pending';
    footerEffort.setAttribute(
      'aria-busy',
      String(
        footerState.effortSwitchInProgress || state.effortCompatibility?.recovery === 'pending',
      ),
    );
    footerEffort.title = !state.active
      ? '启动 Claude Code 后可调整思考程度'
      : state.effortCompatibility
        ? state.effortCompatibility.recovery === 'failed'
          ? '自动回退失败；请打开菜单手动选择"均衡"或更低档位'
          : '搜索兼容重试期间暂用"均衡"；成功后会自动恢复原思考档位'
        : state.effortRequest === 'ultracode'
          ? `Ultra Code 已请求：工作流编排 · 实际思考档 ${effortApplied?.toUpperCase() ?? '等待上报'}`
          : effortApplied === undefined
            ? '点击调整思考程度；当前模型未上报思考档位，可能不支持该参数'
            : '点击调整思考程度，或在终端运行 /effort';
    footerEffort.removeAttribute('aria-description');
    if (
      state.effortCompatibility?.recovery === 'recovered' &&
      effortRecoveryNotifications.get(state.sessionId) !== state.effortCompatibility.detectedAt
    ) {
      effortRecoveryNotifications.set(state.sessionId, state.effortCompatibility.detectedAt);
      showToast('搜索任务已临时切到"均衡"；重试完成后会自动恢复原思考档位。');
    }
  };

  return {
    renderTerminalFooterChips,
  };
};
