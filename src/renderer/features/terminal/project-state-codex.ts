import { projectNameFromPath } from '../../platform/format';
import type { CodexProjectState } from '../../../shared/contracts';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import {
  codexAccountDetail,
  codexAccountStep,
  codexAccountTitle,
  codexBoundaryNote,
  codexCancelLogin,
  codexDeviceCode,
  codexDeviceLogin,
  codexDeviceLoginAction,
  codexInstallButton,
  codexInstallDetail,
  codexInstallStep,
  codexInstallTitle,
  codexLaunchContinue,
  codexLaunchNew,
  codexLaunchResume,
  codexLoginButton,
  codexLogout,
  codexPlan,
  codexPrimaryAction,
  codexProjectDetail,
  codexProjectStep,
  codexProjectTitle,
  codexQuotaBar,
  codexQuotaLabel,
  codexQuotaValue,
  codexUsageCard,
  footerConnection,
  footerConnectionLabel,
  footerContextLabel,
  footerContextRing,
  footerEffort,
  footerMode,
  footerModel,
  footerSpeed,
  routeHealth,
  runAgentLabel,
  runClaudeButton,
} from './project-state-dom';

export interface TerminalCodexStateActions {
  renderCodexState: (state: CodexProjectState, invalidatePendingLoad?: boolean) => void;
  loadCodexState: (
    sessionId: string,
    errorMessage?: string,
  ) => Promise<CodexProjectState | undefined>;
}

export const createTerminalCodexStateActions = (
  deps: TerminalProjectStateDeps,
): TerminalCodexStateActions => {
  const {
    getWorkspaceState,
    activeDevelopmentRuntime,
    codexStates,
    codexStateLoadGenerations,
    codexLaunchAttempts,
    isCodexOperationInProgress,
    renderFooterResource,
    showToast,
    preflightFeature,
  } = deps;

  const renderCodexState = (state: CodexProjectState, invalidatePendingLoad = true): void => {
    if (!getWorkspaceState().sessions.some((session) => session.id === state.sessionId)) {
      return;
    }
    if (invalidatePendingLoad) {
      codexStateLoadGenerations.invalidate(state.sessionId);
    }
    codexStates.set(state.sessionId, state);
    if (
      state.sessionId !== getWorkspaceState().activeSessionId ||
      activeDevelopmentRuntime() !== 'codex'
    ) {
      return;
    }

    const { account, installation, login, rateLimits } = state;
    const installed = installation.installed;
    const accountReady = Boolean(account) || !state.requiresOpenaiAuth;
    const ready = installed && accountReady;
    const waitingForLogin = login.phase === 'waiting' || login.phase === 'starting';
    const launchInProgress = codexLaunchAttempts.isActive(state.sessionId);
    const officialNetworkBlocked = preflightFeature.isBlocked('openai-codex');

    codexInstallStep.dataset.state = installed ? 'ready' : 'error';
    codexInstallTitle.textContent = installed
      ? `Codex CLI ${installation.version ?? '已安装'}`
      : '需要安装 Codex CLI';
    codexInstallDetail.textContent = state.operationMessage ?? installation.message;
    codexInstallButton.hidden = installed && !installation.updateAvailable;
    codexInstallButton.textContent = installation.updateAvailable ? '更新' : '安装';
    codexInstallButton.disabled = isCodexOperationInProgress();

    codexAccountStep.dataset.state = accountReady
      ? 'ready'
      : login.phase === 'error'
        ? 'error'
        : 'pending';
    codexAccountTitle.textContent = account
      ? account.type === 'chatgpt'
        ? 'ChatGPT 账号已连接'
        : account.type === 'apiKey'
          ? 'Codex 已使用 API Key'
          : 'Codex 账号已连接'
      : waitingForLogin
        ? '等待完成 ChatGPT 登录'
        : '尚未登录 ChatGPT';
    codexAccountDetail.textContent = account
      ? [account.email, account.planType].filter(Boolean).join(' · ') || '凭据由 Codex 官方管理'
      : (login.error ?? '浏览器登录可直接使用 ChatGPT 订阅额度');
    codexLoginButton.hidden = accountReady || waitingForLogin;
    codexLoginButton.disabled = !installed || isCodexOperationInProgress();

    codexProjectStep.dataset.state = ready ? 'ready' : 'pending';
    codexProjectTitle.textContent = ready ? '当前项目已就绪' : '等待环境与账号就绪';
    codexProjectDetail.textContent = ready
      ? `将在 ${projectNameFromPath(state.cwd)} 中以工作区写入沙箱启动`
      : '完成安装和登录后，不需要再填写 Token 或配置路由';

    codexDeviceLogin.hidden = !(
      login.phase === 'waiting' &&
      login.method === 'device-code' &&
      login.userCode
    );
    codexDeviceCode.textContent = login.userCode ?? '—';
    codexDeviceLoginAction.hidden = accountReady || waitingForLogin || !installed;
    codexCancelLogin.hidden = !waitingForLogin;
    codexLogout.hidden = !account;

    codexUsageCard.hidden = !account;
    codexPlan.textContent =
      account?.type === 'chatgpt'
        ? `${account.planType ? account.planType.toUpperCase() : 'ChatGPT'} · ${account.email ?? '已登录'}`
        : account?.type === 'apiKey'
          ? 'OpenAI API Key'
          : 'Codex 账号';
    const quota = rateLimits?.primary;
    codexQuotaLabel.textContent = quota?.windowDurationMins
      ? `${quota.windowDurationMins} 分钟窗口`
      : '当前额度窗口';
    codexQuotaValue.textContent = quota ? `已用 ${quota.usedPercent.toFixed(0)}%` : '等待额度数据';
    codexQuotaBar.style.width = `${quota?.usedPercent ?? 0}%`;

    const actionLabel =
      isCodexOperationInProgress() || launchInProgress
        ? '正在准备 Codex…'
        : !installed
          ? '一键安装、登录并启动'
          : !accountReady
            ? '使用 ChatGPT 登录并启动'
            : '新建 Codex 安全会话';
    codexPrimaryAction.textContent = actionLabel;
    codexPrimaryAction.disabled =
      isCodexOperationInProgress() || launchInProgress || waitingForLogin || officialNetworkBlocked;
    codexPrimaryAction.setAttribute(
      'aria-busy',
      String(isCodexOperationInProgress() || launchInProgress),
    );
    runAgentLabel.textContent = launchInProgress
      ? '正在启动 Codex…'
      : ready
        ? '新建 Codex 会话'
        : '一键准备 Codex';
    runClaudeButton.disabled =
      isCodexOperationInProgress() || launchInProgress || waitingForLogin || officialNetworkBlocked;
    runClaudeButton.setAttribute(
      'aria-busy',
      String(isCodexOperationInProgress() || launchInProgress),
    );
    runClaudeButton.dataset.routeHealth = ready ? 'success' : 'warning';
    runClaudeButton.title = ready
      ? '在当前项目启动官方 Codex 安全会话'
      : '自动完成官方安装与 ChatGPT 登录';

    for (const button of [codexLaunchNew, codexLaunchContinue, codexLaunchResume]) {
      button.disabled =
        !ready || isCodexOperationInProgress() || launchInProgress || officialNetworkBlocked;
      button.setAttribute('aria-busy', String(launchInProgress));
    }

    routeHealth.hidden = true;
    footerConnection.disabled = false;
    footerConnection.dataset.tone = ready ? 'success' : 'warning';
    footerConnectionLabel.textContent = ready
      ? account?.type === 'chatgpt'
        ? 'ChatGPT 已连接'
        : 'Codex 已连接'
      : 'Codex 待准备';
    footerContextLabel.textContent = '上下文 —';
    footerContextRing.style.setProperty('--context-progress', '0%');
    renderFooterResource(state.resourceUsage);
    footerModel.textContent = '模型 Codex 自动';
    footerModel.disabled = true;
    footerSpeed.textContent = '速度 Codex 内管理';
    footerSpeed.disabled = true;
    footerSpeed.title = '原生 Codex 的速度设置由 Codex 自己管理，ClaudeDock 不接管。';
    footerSpeed.setAttribute('aria-busy', 'false');
    footerMode.textContent = '模式 工作区写入';
    footerMode.disabled = true;
    footerEffort.textContent = '思考 Codex 自动';
    footerEffort.disabled = true;
    codexBoundaryNote.textContent = state.warning
      ? `${state.warning} 首版任务界面仍可回退到官方 Codex TUI。`
      : '首版任务界面使用官方 Codex TUI：默认仅写当前工作区，模型需要更高权限时仍会向你确认。App Server 只用于结构化登录和账号状态，不会读取或转存 ChatGPT 令牌。';
    preflightFeature.renderActiveNetworkPreflight();
  };

  const loadCodexState = async (
    sessionId: string,
    errorMessage = '无法读取 Codex 工作台状态。',
  ): Promise<CodexProjectState | undefined> => {
    const request = codexStateLoadGenerations.begin(sessionId);
    let state: CodexProjectState;
    try {
      state = await window.controlPanel.getCodexProjectState(sessionId);
    } catch {
      if (codexStateLoadGenerations.finish(request)) {
        showToast(errorMessage, 'error');
      }
      return;
    }
    if (!codexStateLoadGenerations.finish(request) || state.sessionId !== sessionId) {
      return;
    }
    renderCodexState(state, false);
    return state;
  };

  return {
    renderCodexState,
    loadCodexState,
  };
};
