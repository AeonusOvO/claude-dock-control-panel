import type {
  ClaudeProjectState,
  ClaudeRouterManagementState,
  ClaudeRouterProviderView,
  RouterKernelState,
  RouterOperationProgress,
  TerminalStatus,
} from '../../../shared/contracts';
import type { RouterElements } from './elements';
import type { RouterState } from './state';

export interface RouterViewDependencies {
  activeStatus: () => TerminalStatus | undefined;
  getActiveProjectState: () => ClaudeProjectState | undefined;
}

export interface RouterView {
  projectUsesDefaultRouter: (baseUrl: string) => boolean;
  projectUsesHttpsGateway: (baseUrl: string) => boolean;
  renderRouterKernelState: (kernelState: RouterKernelState) => void;
  renderRouterRemediation: (managementState: ClaudeRouterManagementState) => void;
  routerOperationLabel: (progress: RouterOperationProgress) => string;
  routerProtocolLabel: (protocol: ClaudeRouterProviderView['protocol']) => string;
  setRouterOperationStage: (stage: string, detail: string, percent?: number) => void;
}

export const createRouterView = (
  elements: RouterElements,
  state: RouterState,
  dependencies: RouterViewDependencies,
): RouterView => {
  const routerProtocolLabel = (protocol: ClaudeRouterProviderView['protocol']): string =>
    protocol === 'anthropic_messages'
      ? 'Anthropic 消息协议'
      : protocol === 'openai_responses'
        ? 'OpenAI 响应协议'
        : 'OpenAI 对话补全协议';

  const projectUsesDefaultRouter = (baseUrl: string): boolean => {
    try {
      const parsed = new URL(baseUrl);
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      return (
        parsed.protocol === 'http:' &&
        ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname.toLowerCase()) &&
        port === 3456
      );
    } catch {
      return false;
    }
  };

  const projectUsesHttpsGateway = (baseUrl: string): boolean => {
    try {
      return new URL(baseUrl).protocol === 'https:';
    } catch {
      return false;
    }
  };

  const renderRouterRemediation = (managementState: ClaudeRouterManagementState): void => {
    const projectState = dependencies.getActiveProjectState();
    const config = projectState?.config;
    const runtimeMismatch = managementState.runtimeMismatch === true;
    const noProviders =
      managementState.managementAvailable && managementState.providers.length === 0;
    const providerError =
      managementState.managementAvailable &&
      managementState.providers.length > 0 &&
      managementState.gatewayState === 'error';
    elements.routerRemediation.hidden = !runtimeMismatch && !noProviders && !providerError;
    if (elements.routerRemediation.hidden) {
      return;
    }
    elements.configureRouterProviderButton.hidden = runtimeMismatch;
    if (runtimeMismatch) {
      elements.repairRouterFromProjectButton.hidden = true;
      elements.routerRemediationTitle.textContent = '解决办法：切换到 CCR 配套的 Node.js';
      elements.routerRemediationDetail.textContent =
        'CCR 数据库没有损坏；它只是被 Electron 内置 Node.js 错误启动。点击上方“修复运行环境并重启”，ClaudeDock 会停止这个错误进程，再用 CCR 安装时的系统 Node.js 重启。服务提供方、密钥和 Codex 配置都不会被修改。';
      return;
    }
    elements.configureRouterProviderButton.hidden = false;

    const projectUsesRouter = Boolean(
      config?.provider === 'gateway' && projectUsesDefaultRouter(config.baseUrl),
    );
    const projectHasRemoteDirect = Boolean(
      config?.provider === 'gateway' &&
      config.baseUrl &&
      projectUsesHttpsGateway(config.baseUrl) &&
      !projectUsesDefaultRouter(config.baseUrl),
    );
    const canRepairFromProject = Boolean(
      noProviders &&
      projectHasRemoteDirect &&
      config?.authMode === 'apiKey' &&
      config.credentialConfigured,
    );

    elements.repairRouterFromProjectButton.hidden = !canRepairFromProject;
    elements.repairRouterFromProjectButton.disabled = state.routerOperationInProgress;
    elements.configureRouterProviderButton.disabled = state.routerOperationInProgress;
    if (noProviders) {
      elements.routerRemediationTitle.textContent = '解决办法：先创建第一个服务提供方';
      elements.configureRouterProviderButton.textContent = '手动添加第一个服务提供方';
      if (canRepairFromProject && config) {
        elements.routerRemediationDetail.textContent = `可将当前项目已加密保存的 ${config.baseUrl} 接入信息导入为 Anthropic 消息协议服务提供方，随后启动 3456 并应用路由器配置。`;
      } else if (projectUsesRouter) {
        elements.routerRemediationDetail.textContent =
          '当前项目依赖 3456，因此必须先添加服务提供方。点击下方按钮，依次填写上游协议、接口地址、模型标识和上游密钥；保存后再启动路由器。';
      } else if (projectHasRemoteDirect) {
        elements.routerRemediationDetail.textContent =
          '已保存兼容接口，但当前认证方式无法安全自动导入。请手动添加服务提供方，保存后再启动路由器。';
      } else {
        elements.routerRemediationDetail.textContent =
          '没有可自动导入的网关配置。点击下方按钮，依次填写上游协议、接口地址、模型标识和上游密钥；保存后再启动路由器。';
      }
      return;
    }

    elements.repairRouterFromProjectButton.hidden = true;
    elements.routerRemediationTitle.textContent = '解决办法：检查已有服务提供方';
    elements.routerRemediationDetail.textContent =
      '路由器已有服务提供方，但 3456 仍未启动。请检查首选服务提供方的接口、模型和上游密钥，保存后再次点击“启动路由器”。';
    elements.configureRouterProviderButton.textContent = '检查服务提供方';
  };

  const routerOperationLabel = (progress: RouterOperationProgress): string => {
    const labels: Record<RouterOperationProgress['stage'], string> = {
      checking: '检查环境',
      complete: '操作完成',
      configuring: '写入配置',
      downloading: '下载 CLI',
      error: '操作未完成',
      installing: '安装 CLI',
      recovering: '恢复中断任务',
      starting: '启动后台',
      stopping: '停止后台',
      verifying: '校验安装',
    };
    return labels[progress.stage];
  };

  const renderRouterKernelState = (kernelState: RouterKernelState): void => {
    state.routerKernelState = kernelState;
    const activeLabel =
      kernelState.active === 'ccr'
        ? 'CCR'
        : kernelState.active === 'cc-switch'
          ? 'CC Switch'
          : '无';
    elements.routerKernelStatus.textContent = kernelState.conflict
      ? '检测到 CCR 与 CC Switch 同时运行；请停止其中一个，避免接入状态相互覆盖。'
      : `当前活跃内核：${activeLabel}。${kernelState.ccSwitch.message}`;
    elements.routerKernelStatus.dataset.tone = kernelState.conflict ? 'danger' : 'neutral';
    elements.installCcSwitchButton.disabled =
      state.routerOperationInProgress || kernelState.ccSwitch.installed;
    elements.exportCcSwitchButton.disabled =
      state.routerOperationInProgress ||
      !kernelState.ccSwitch.installed ||
      !kernelState.ccSwitch.protocolRegistered ||
      !dependencies.activeStatus();
    elements.uninstallCcSwitchButton.disabled =
      state.routerOperationInProgress ||
      (!kernelState.ccSwitch.installed && kernelState.ccSwitch.residuals.length === 0);
    elements.ccSwitchResiduals.replaceChildren(
      ...kernelState.ccSwitch.residuals.map((residual) => {
        const item = document.createElement('li');
        item.textContent = residual;
        return item;
      }),
    );
  };

  const setRouterOperationStage = (stage: string, detail: string, percent?: number): void => {
    elements.routerOperationProgress.hidden = false;
    elements.routerOperationStage.textContent = stage;
    elements.routerOperationDetail.textContent = detail;
    if (percent === undefined) {
      elements.routerOperationMeter.removeAttribute('value');
    } else {
      elements.routerOperationMeter.value = Math.max(0, Math.min(100, percent));
    }
  };

  return {
    projectUsesDefaultRouter,
    projectUsesHttpsGateway,
    renderRouterKernelState,
    renderRouterRemediation,
    routerOperationLabel,
    routerProtocolLabel,
    setRouterOperationStage,
  };
};
