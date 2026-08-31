import { formatDuration, formatTokenCount } from '../../platform/format';
import { findClaudeProvider } from '../../../shared/claude/providers';
import type { ClaudeProjectState } from '../../../shared/contracts';
import { ClaudeLaunchAttemptRegistry } from '../../platform/claude-launch-attempt';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import {
  allowBypassPermissions,
  claudeInstallationDetail,
  claudeInstallationTitle,
  claudeLiveIndicator,
  claudeRouteEndpoint,
  claudeRouteModel,
  claudeRouteName,
  claudeRuntimeWarning,
  claudeSecurityBanner,
  contextPercentage,
  contextProgressBar,
  contextProgress,
  contextSize,
  contextUsed,
  footerConnection,
  footerConnectionLabel,
  footerContextLabel,
  footerContextRing,
  metricCost,
  metricDuration,
  metricInput,
  metricModel,
  metricOutput,
  metricSession,
  routeHealth,
  routeHealthAction,
  routeHealthBadge,
  routeHealthDetail,
  routeHealthTitle,
  runClaudeButton,
} from './project-state-dom';

const renderClaudeRouteHealthPanel = (
  state: ClaudeProjectState,
  health: NonNullable<ClaudeProjectState['routeHealth']>,
  routeHealthNotifications: Map<string, string>,
  claudeLaunchAttempts: ClaudeLaunchAttemptRegistry,
  showToast: TerminalProjectStateDeps['showToast'],
): void => {
  routeHealth.dataset.tone = health.tone;
  routeHealthBadge.textContent =
    health.source === 'runtime'
      ? '真实会话'
      : health.source === 'router'
        ? '路由器状态'
        : '连接测试';
  routeHealthTitle.textContent = health.headline;
  routeHealthDetail.textContent = health.detail;
  routeHealthAction.hidden = health.tone === 'success';
  const notificationKey = `${health.source}:${health.tone}:${health.checkedAt}`;
  if (
    health.tone === 'error' &&
    routeHealthNotifications.get(state.sessionId) !== notificationKey
  ) {
    routeHealthNotifications.set(state.sessionId, notificationKey);
    if (!claudeLaunchAttempts.isBusy(state.sessionId)) {
      showToast(health.headline, 'error');
    }
  }
};

const renderClaudeContextReadout = (
  state: ClaudeProjectState,
  metrics: ClaudeProjectState['metrics'],
  conversationFeature: TerminalProjectStateDeps['conversationFeature'],
  renderFooterResource: TerminalProjectStateDeps['renderFooterResource'],
  managedContextWindowSelectable: TerminalProjectStateDeps['managedContextWindowSelectable'],
  renderTerminalFooterChips: TerminalProjectStateDeps['renderTerminalFooterChips'],
  maybeOfferClaudeContextDowngrade: (state: ClaudeProjectState) => void,
): void => {
  claudeLiveIndicator.dataset.active = String(state.active);
  claudeLiveIndicator.textContent = state.active ? '实时同步' : '未运行';
  const used = metrics?.contextWindowUsed;
  const size = metrics?.contextWindowSize;
  /*
   * `resourceUsage` already resolved the clamp: when the declared window is smaller than what the
   * endpoint serves it reports the real ratio from the unclamped input total. Reuse it so this
   * readout and the footer never disagree, and so a stuck 100% here is corrected too.
   */
  const anomaly = state.resourceUsage?.contextCountingAnomaly;
  const percentage = anomaly
    ? state.resourceUsage?.contextUsedPercent
    : used !== undefined && size
      ? Math.min(100, Math.max(0, (used / size) * 100))
      : undefined;
  contextPercentage.textContent =
    percentage === undefined ? '等待首个响应' : `${Math.min(100, percentage).toFixed(1)}%`;
  contextProgressBar.style.width = `${Math.min(100, percentage ?? 0)}%`;
  contextProgress.setAttribute('aria-valuenow', String(Math.round(Math.min(100, percentage ?? 0))));
  contextProgress.dataset.level =
    percentage !== undefined && percentage >= 85
      ? 'danger'
      : percentage !== undefined && percentage >= 65
        ? 'warning'
        : 'normal';
  contextUsed.textContent = `${formatTokenCount(anomaly?.reportedTokens ?? used)} 已用`;
  contextSize.textContent = `窗口 ${formatTokenCount(size)}`;
  const clampedPercentageForFooter =
    percentage === undefined ? 0 : Math.min(100, Math.max(0, percentage));
  footerContextRing.style.setProperty('--context-progress', `${clampedPercentageForFooter}%`);
  footerContextRing.dataset.level = contextProgress.dataset.level;
  footerContextLabel.textContent =
    percentage === undefined ? '上下文 —' : `上下文 ${Math.min(100, percentage).toFixed(0)}%`;
  // Suppress the terminal-side footer update while a native conversation is displayed: the Agent
  // SDK snapshot is the only truth there, and the background terminal session would otherwise
  // overwrite all five readouts on every status-line tick.
  if (conversationFeature.hasActiveConversation()) {
    conversationFeature.renderActiveFooter();
  } else {
    renderFooterResource(state.resourceUsage, managedContextWindowSelectable(state));
    renderTerminalFooterChips(state);
  }
  maybeOfferClaudeContextDowngrade(state);
  allowBypassPermissions.checked = state.allowBypassPermissions;
  metricInput.textContent = formatTokenCount(metrics?.inputTokens);
  metricOutput.textContent = formatTokenCount(metrics?.outputTokens);
  metricCost.textContent =
    metrics?.sessionCostUsd === undefined ? '—' : `$${metrics.sessionCostUsd.toFixed(4)}`;
  metricDuration.textContent = formatDuration(metrics?.sessionDurationMs);
  metricModel.textContent = metrics?.modelDisplayName ?? metrics?.modelId ?? '等待状态行';
  metricModel.title = metrics?.modelId ?? '';
  metricSession.textContent = metrics?.sessionName ?? metrics?.sessionId ?? '新会话尚未创建';
  metricSession.title = metrics?.sessionId ?? '';
};

export interface TerminalClaudeStateActions {
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void;
}

export const createTerminalClaudeStateActions = (
  deps: TerminalProjectStateDeps,
  claudeStateCanApply: (state: ClaudeProjectState) => boolean,
  renderClaudeLaunchControls: (sessionId: string, launchBlocked?: boolean) => void,
  claudeLaunchBlocked: (state: ClaudeProjectState) => boolean,
): TerminalClaudeStateActions => {
  const {
    getWorkspaceState,
    activeDevelopmentRuntime,
    claudeStates,
    claudeStateLoadGenerations,
    claudeLaunchAttempts,
    terminalFeature,
    connectionForm,
    requestConfirmation,
    showToast,
    conversationFeature,
    renderFooterResource,
    managedContextWindowSelectable,
    renderTerminalFooterChips,
    getClaudeContextWindowMode,
    getClaudeContextWindowCustomTokens,
    applyContextWindowSettings,
    connectionFeature,
    routerFeature,
    preflightFeature,
  } = deps;
  const claudeContextDowngradePrompted = new Set<string>();
  const routeHealthNotifications = new Map<string, string>();

  /** Only a real upstream context rejection justifies recommending a smaller window. A mismatch
   * between status-line counters is diagnostic evidence, but cannot establish endpoint capacity. */
  const maybeOfferClaudeContextDowngrade = (state: ClaudeProjectState): void => {
    const contextWindowMode = getClaudeContextWindowMode();
    if (contextWindowMode !== 'extended' && contextWindowMode !== 'custom') return;
    const rejectedByEndpoint = state.routeHealth?.headline === '当前对话已超过上下文上限';
    if (!rejectedByEndpoint) return;
    const promptKey = [
      state.sessionId,
      String(state.ptyGeneration ?? 'unknown'),
      contextWindowMode,
      String(getClaudeContextWindowCustomTokens() ?? ''),
    ].join(':');
    if (claudeContextDowngradePrompted.has(promptKey)) return;
    claudeContextDowngradePrompted.add(promptKey);
    void requestConfirmation({
      confirmLabel: '切到 20 万并重启',
      message:
        '当前端点拒绝了这次请求，通常表示它的实际窗口小于所选档位。\n\n是否切换到 20 万窗口？切换后需要重启会话，对话历史会通过 --continue 恢复。',
      title: '上下文窗口可能设置过大',
    }).then((confirmed) => {
      if (!confirmed) return;
      void window.controlPanel
        .setClaudeContextWindowMode('standard')
        .then(async (settings) => {
          applyContextWindowSettings(settings);
          await terminalFeature.relaunchClaudeSession('上下文窗口已切换到 20 万。', {});
        })
        .catch(() => showToast('无法切换 Claude 上下文窗口。', 'error'));
    });
  };

  /**
   * Writes the four footer chips from PowerShell status-line truth. Extracted so the native path can
   * replace all four at once: leaving any of them on this renderer would make them flicker between
   * the Agent SDK's capabilities and the background terminal's status line on every PTY tick.
   */
  const renderClaudeState = (
    state: ClaudeProjectState,
    observeLaunch = true,
    invalidatePendingLoad = true,
  ): void => {
    if (!claudeStateCanApply(state)) {
      return;
    }
    if (invalidatePendingLoad) {
      claudeStateLoadGenerations.invalidate(state.sessionId);
    }
    if (observeLaunch) {
      claudeLaunchAttempts.observeClaude({
        active: state.active,
        conversationId: state.metrics?.sessionId,
        sessionId: state.sessionId,
      });
    }
    claudeStates.set(state.sessionId, state);
    if (state.permissionMode === undefined) {
      const view = terminalFeature.getTerminalView(state.sessionId);
      if (view) {
        view.observedPermissionMode = undefined;
      }
    }
    if (state.sessionId !== getWorkspaceState().activeSessionId) {
      return;
    }

    const { config, installation, metrics } = state;
    if (activeDevelopmentRuntime() !== 'claude') {
      connectionForm.renderProviderPicker();
      connectionForm.syncConnectionInteractivity();
      return;
    }
    const installationReady = installation.security === 'ready';
    connectionForm.setConnectionEnvironmentReady(installationReady);
    connectionForm.environmentSetup.hidden = installationReady;
    claudeSecurityBanner.dataset.tone = installationReady
      ? 'ready'
      : installation.security === 'unknown'
        ? 'checking'
        : 'blocked';
    claudeInstallationTitle.textContent = installationReady
      ? `安全版本 · ${installation.version ?? '已识别'}`
      : installation.installed
        ? '需要更新 Claude Code'
        : '未找到 Claude Code';
    claudeInstallationDetail.textContent = installation.message;

    claudeRouteName.textContent =
      findClaudeProvider(config.preset)?.label ??
      (config.provider === 'anthropic' ? 'Anthropic 官方' : 'Anthropic 兼容网关');
    claudeRouteModel.textContent = config.model === 'default' ? '默认' : config.model;
    claudeRouteEndpoint.textContent =
      config.provider === 'anthropic'
        ? config.authMode === 'existing'
          ? '使用官方登录与默认端点'
          : '使用官方接口密钥与默认端点'
        : config.baseUrl;

    const health = state.routeHealth;
    routeHealth.hidden = !health;
    if (health) {
      renderClaudeRouteHealthPanel(
        state,
        health,
        routeHealthNotifications,
        claudeLaunchAttempts,
        showToast,
      );
    }
    runClaudeButton.dataset.routeHealth = health?.tone ?? 'unknown';
    const launchBlocked = claudeLaunchBlocked(state);
    renderClaudeLaunchControls(state.sessionId, launchBlocked);
    runClaudeButton.title = !installationReady
      ? installation.message
      : health?.blocking
        ? health.detail
        : '使用当前已验证配置新建独立 Claude 会话';
    // Rendered before the tone branch so a running test always wins: the footer must show progress
    // the instant the button is clicked, whatever the last recorded route health was.
    if (connectionFeature.isTestInProgress()) {
      footerConnection.dataset.tone = 'pending';
      footerConnection.disabled = true;
      footerConnection.setAttribute('aria-busy', 'true');
      footerConnectionLabel.textContent = '正在检测连接';
    } else {
      footerConnection.disabled = false;
      footerConnection.setAttribute('aria-busy', 'false');
      const readiness = state.connection?.readiness ?? 'unknown';
      footerConnection.dataset.tone =
        readiness === 'connected'
          ? 'success'
          : readiness === 'failed'
            ? 'error'
            : installationReady
              ? 'warning'
              : 'error';
      footerConnectionLabel.textContent =
        readiness === 'connected'
          ? '连接正常'
          : readiness === 'failed'
            ? '连接异常'
            : installationReady
              ? '连接待测试'
              : '环境未就绪';
    }

    renderClaudeContextReadout(
      state,
      metrics,
      conversationFeature,
      renderFooterResource,
      managedContextWindowSelectable,
      renderTerminalFooterChips,
      maybeOfferClaudeContextDowngrade,
    );

    claudeRuntimeWarning.hidden = !state.warning;
    claudeRuntimeWarning.textContent = state.warning ?? '';

    if (connectionForm.getProviderGroupExpansionPending()) {
      connectionForm.applyDefaultProviderGroupExpansion(connectionForm.getSelectedProviderId());
      connectionForm.setProviderGroupExpansionPending(false);
    }
    connectionForm.renderProviderPicker();
    connectionForm.syncConnectionInteractivity();
    const routerManagement = routerFeature.getManagementState();
    if (routerManagement) {
      routerFeature.renderRemediation(routerManagement);
    }
    connectionFeature.updateSmartGuidance();
    preflightFeature.renderActiveNetworkPreflight();
    connectionFeature.scheduleAutomaticConnectionTest(state);
  };

  return {
    renderClaudeState,
  };
};
