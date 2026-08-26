import { projectNameFromPath } from '../../platform/format';
import type { CodexProjectState } from '../../../shared/contracts';
import { notifyCodexAdmissionChange } from '../../platform/runtime-state-events';
import type { CodexOperationPresentation } from './codex-operation-state';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import { renderRuntimePickerControls } from './project-state-runtime';
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

const codexOperationLabel = (operation?: CodexOperationPresentation): string | undefined => {
  switch (operation?.operation) {
    case 'install':
      return '正在安装…';
    case 'update':
      return '正在更新…';
    case 'login-browser':
      return '正在启动浏览器登录…';
    case 'login-device':
      return '正在启动设备码登录…';
    case 'cancel-login':
      return '正在取消登录…';
    case 'logout':
      return '正在退出账号…';
    default:
      return undefined;
  }
};

const renderCodexOperationControls = (
  operation: CodexOperationPresentation | undefined,
  installation: CodexProjectState['installation'],
): { operationInProgress: boolean; operationLabel?: string } => {
  const operationInProgress = Boolean(operation);
  const operationLabel = codexOperationLabel(operation);
  const installOperation = operation?.operation === 'install' || operation?.operation === 'update';
  codexInstallButton.textContent = installOperation
    ? operationLabel!
    : installation.updateAvailable
      ? '更新'
      : '安装';
  codexInstallButton.disabled = operationInProgress;
  codexInstallButton.setAttribute('aria-busy', String(installOperation));

  const controls = [
    [codexLoginButton, 'login-browser', '登录'],
    [codexDeviceLoginAction, 'login-device', '改用设备码登录'],
    [codexCancelLogin, 'cancel-login', '取消登录'],
    [codexLogout, 'logout', '退出 Codex 账号'],
  ] as const;
  for (const [button, kind, idleLabel] of controls) {
    const ownsOperation = operation?.operation === kind;
    button.textContent = ownsOperation ? operationLabel! : idleLabel;
    button.disabled = operationInProgress;
    button.setAttribute('aria-busy', String(ownsOperation));
  }
  return { operationInProgress, operationLabel };
};

const renderCodexLoadingPresentation = (
  deps: Pick<
    TerminalProjectStateDeps,
    | 'activeDevelopmentRuntime'
    | 'claudeLaunchAttempts'
    | 'codexLaunchAttempts'
    | 'getCodexOperation'
    | 'getWorkspaceState'
  >,
  sessionId: string,
  errorMessage?: string,
): void => {
  renderRuntimePickerControls(deps);
  if (
    sessionId !== deps.getWorkspaceState().activeSessionId ||
    deps.activeDevelopmentRuntime() !== 'codex'
  ) {
    return;
  }
  const installation = {
    installed: false,
    message: errorMessage ?? '正在读取 Codex 工作台状态…',
    updateAvailable: false,
  };
  const operation = deps.getCodexOperation();
  const { operationInProgress, operationLabel } = renderCodexOperationControls(
    operation,
    installation,
  );
  const loadingLabel = operationLabel ?? (errorMessage ? 'Codex 状态不可用' : '正在检查 Codex…');

  codexInstallStep.dataset.state = errorMessage ? 'error' : 'pending';
  codexInstallTitle.textContent = errorMessage ? '无法读取 Codex 环境' : '正在检查 Codex 环境';
  codexInstallDetail.textContent = errorMessage ?? installation.message;
  codexInstallButton.hidden = false;
  codexInstallButton.disabled = true;
  codexAccountStep.dataset.state = 'pending';
  codexAccountTitle.textContent = '等待 Codex 状态';
  codexAccountDetail.textContent = '当前项目的账号状态尚未加载。';
  codexLoginButton.hidden = false;
  codexLoginButton.disabled = true;
  codexDeviceLogin.hidden = true;
  codexDeviceLoginAction.hidden = true;
  codexCancelLogin.hidden = true;
  codexLogout.hidden = true;
  codexUsageCard.hidden = true;
  codexProjectStep.dataset.state = 'pending';
  codexProjectTitle.textContent = '等待环境与账号就绪';
  codexProjectDetail.textContent = errorMessage ?? '正在读取当前项目的 Codex 状态。';
  codexPrimaryAction.textContent = loadingLabel;
  codexPrimaryAction.hidden = false;
  codexPrimaryAction.disabled = true;
  codexPrimaryAction.setAttribute('aria-busy', String(!operationInProgress && !errorMessage));
  runAgentLabel.textContent = loadingLabel;
  runClaudeButton.disabled = true;
  runClaudeButton.setAttribute('aria-busy', String(!operationInProgress && !errorMessage));
  for (const [button, idleLabel] of [
    [codexLaunchNew, '启动当前对话'],
    [codexLaunchContinue, '继续最近会话'],
    [codexLaunchResume, '选择历史会话'],
  ] as const) {
    button.textContent = idleLabel;
    button.disabled = true;
    button.setAttribute('aria-busy', 'false');
  }
  codexBoundaryNote.textContent = errorMessage
    ? `${errorMessage} 请重新打开项目或稍后重试。`
    : '正在读取 Codex 安装、账号与额度状态。';
};

export interface TerminalCodexStateActions {
  renderCodexLoadingState: (sessionId: string, errorMessage?: string) => void;
  renderCodexState: (state: CodexProjectState, invalidatePendingLoad?: boolean) => void;
  loadCodexState: (
    sessionId: string,
    errorMessage?: string,
  ) => Promise<CodexProjectState | undefined>;
}

const renderCodexFooter = (
  state: CodexProjectState,
  ready: boolean,
  renderFooterResource: TerminalProjectStateDeps['renderFooterResource'],
): void => {
  routeHealth.hidden = true;
  footerConnection.disabled = false;
  footerConnection.dataset.tone = ready ? 'success' : 'warning';
  footerConnectionLabel.textContent = ready
    ? state.account?.type === 'chatgpt'
      ? 'ChatGPT 已连接'
      : 'Codex 已连接'
    : 'Codex 待准备';
  footerContextLabel.textContent = '上下文 —';
  footerContextRing.style.setProperty('--context-progress', '0%');
  renderFooterResource(state.resourceUsage);
  for (const chip of [footerModel, footerSpeed, footerMode, footerEffort]) {
    chip.dataset.presentationOwner = 'codex';
  }
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
};

export const createTerminalCodexStateActions = (
  deps: TerminalProjectStateDeps,
): TerminalCodexStateActions => {
  const {
    getWorkspaceState,
    activeDevelopmentRuntime,
    codexStates,
    codexStateLoadGenerations,
    codexLaunchAttempts,
    getCodexOperation,
    renderFooterResource,
    showToast,
    preflightFeature,
  } = deps;

  const renderCodexLoadingState = (sessionId: string, errorMessage?: string): void => {
    renderCodexLoadingPresentation(deps, sessionId, errorMessage);
  };

  const renderCodexState = (state: CodexProjectState, invalidatePendingLoad = true): void => {
    renderRuntimePickerControls(deps);
    if (!getWorkspaceState().sessions.some((session) => session.id === state.sessionId)) {
      return;
    }
    const current = codexStates.get(state.sessionId);
    if (
      current &&
      (state.revision < current.revision ||
        (state.revision === current.revision && state !== current))
    ) {
      return;
    }
    if (invalidatePendingLoad) {
      codexStateLoadGenerations.invalidate(state.sessionId);
    }
    codexStates.set(state.sessionId, state);
    notifyCodexAdmissionChange();
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
    const operation = getCodexOperation(state);
    const { operationInProgress, operationLabel } = renderCodexOperationControls(
      operation,
      installation,
    );
    const launchInProgress = codexLaunchAttempts.isActive(state.sessionId);
    const officialNetworkBlocked = preflightFeature.isBlocked('openai-codex');

    codexInstallStep.dataset.state = installed ? 'ready' : 'error';
    codexInstallTitle.textContent = installed
      ? `Codex CLI ${installation.version ?? '已安装'}`
      : '需要安装 Codex CLI';
    codexInstallDetail.textContent = state.operationMessage ?? installation.message;
    codexInstallButton.hidden = installed && !installation.updateAvailable;

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
    codexLoginButton.disabled = !installed || operationInProgress;

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

    const actionLabel = operationLabel
      ? operationLabel
      : launchInProgress
        ? '正在启动 Codex…'
        : !installed
          ? '一键安装、登录并启动'
          : !accountReady
            ? '使用 ChatGPT 登录并启动'
            : 'Codex 已就绪';
    codexPrimaryAction.textContent = actionLabel;
    codexPrimaryAction.hidden = ready;
    codexPrimaryAction.disabled =
      operationInProgress || launchInProgress || waitingForLogin || officialNetworkBlocked;
    codexPrimaryAction.setAttribute('aria-busy', String(launchInProgress));
    runAgentLabel.textContent = operationLabel
      ? operationLabel
      : launchInProgress
        ? '正在启动 Codex…'
        : ready
          ? '新建 Codex 会话'
          : '一键准备 Codex';
    runClaudeButton.disabled =
      operationInProgress || launchInProgress || waitingForLogin || officialNetworkBlocked;
    runClaudeButton.setAttribute('aria-busy', String(launchInProgress));
    runClaudeButton.dataset.routeHealth = ready ? 'success' : 'warning';
    runClaudeButton.title = ready
      ? 'Codex 已就绪；请使用项目旁的 + 新建对话'
      : '自动完成官方安装与 ChatGPT 登录';

    for (const [button, idleLabel] of [
      [codexLaunchNew, '启动当前对话'],
      [codexLaunchContinue, '继续最近会话'],
      [codexLaunchResume, '选择历史会话'],
    ] as const) {
      button.textContent = launchInProgress ? '正在启动…' : idleLabel;
      button.disabled = !ready || operationInProgress || launchInProgress || officialNetworkBlocked;
      button.setAttribute('aria-busy', String(launchInProgress));
    }

    renderCodexFooter(state, ready, renderFooterResource);
    preflightFeature.renderActiveNetworkPreflight();
  };

  const loadCodexState = async (
    sessionId: string,
    errorMessage = '无法读取 Codex 工作台状态。',
  ): Promise<CodexProjectState | undefined> => {
    const request = codexStateLoadGenerations.begin(sessionId);
    renderCodexLoadingState(sessionId);
    let state: CodexProjectState;
    try {
      state = await window.controlPanel.getCodexProjectState(sessionId);
    } catch {
      if (codexStateLoadGenerations.finish(request)) {
        renderCodexLoadingState(sessionId, errorMessage);
        showToast(errorMessage, 'error');
      }
      return;
    }
    if (!codexStateLoadGenerations.finish(request) || state.sessionId !== sessionId) {
      return;
    }
    const current = codexStates.get(sessionId);
    if (current && state.revision <= current.revision) {
      return current;
    }
    renderCodexState(state, false);
    return state;
  };

  return {
    renderCodexLoadingState,
    renderCodexState,
    loadCodexState,
  };
};
