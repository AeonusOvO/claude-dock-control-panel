import type { ManagedChatGptGatewayState } from '../../../shared/contracts';
import type { ChatGptGuideElements } from './chatgpt-guide-elements';
import type { ChatGptSubscriptionGuideDeps } from './chatgpt-guide-dependencies';

export interface ChatGptGuideRenderActions {
  renderState: (state: ManagedChatGptGatewayState, preferredModel?: string) => void;
}

export const createChatGptGuideRenderActions = (
  elements: ChatGptGuideElements,
  deps: ChatGptSubscriptionGuideDeps,
  runLogout: (button: HTMLButtonElement) => Promise<void>,
): ChatGptGuideRenderActions => {
  const {
    guide,
    statusCard,
    statusTitle,
    statusDetail,
    action,
    progressCard,
    progressTitle,
    progressDetail,
    progressMeter,
    modelField,
    modelSelect,
    secondaryActions,
  } = elements;
  const {
    getActiveSessionId,
    claudeStates,
    managedChatGptOperations,
    setRenderManagedChatGptProgress,
    getSelectedProviderId,
    claudeConfigForm,
  } = deps;

  const renderModels = (models: readonly string[], preferredModel?: string): void => {
    const currentModel = claudeStates.get(getActiveSessionId())?.config.model;
    const selected = models.includes(modelSelect.value)
      ? modelSelect.value
      : preferredModel && models.includes(preferredModel)
        ? preferredModel
        : currentModel && models.includes(currentModel)
          ? currentModel
          : models[0];
    modelSelect.replaceChildren(
      ...models.map((model) => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        return option;
      }),
    );
    if (selected) {
      modelSelect.value = selected;
    }
    modelField.hidden = models.length === 0;
  };

  setRenderManagedChatGptProgress((progress): void => {
    const matchesCurrentScope = progress.sessionId === (getActiveSessionId() || undefined);
    action.disabled = managedChatGptOperations.busy;
    action.setAttribute('aria-busy', String(managedChatGptOperations.busy));
    modelSelect.disabled = managedChatGptOperations.busy || !getActiveSessionId();
    if (!matchesCurrentScope) {
      if (!progress.active) {
        void window.controlPanel
          .getManagedChatGptGatewayState()
          .then((state) => {
            if (guide.isConnected) renderState(state);
          })
          .catch(() => undefined);
      }
      return;
    }
    progressCard.hidden = false;
    progressTitle.textContent = `第 ${progress.step}/${progress.totalSteps} 步`;
    progressDetail.textContent = progress.detail;
    progressMeter.max = progress.totalSteps;
    progressMeter.value = progress.step;
    if (progress.active) {
      action.textContent = '正在自动接入…';
    } else {
      void window.controlPanel
        .getManagedChatGptGatewayState()
        .then((state) => {
          if (guide.isConnected) renderState(state);
        })
        .catch(() => undefined);
    }
  });

  const renderState = (state: ManagedChatGptGatewayState, preferredModel?: string): void => {
    const hasProject = Boolean(getActiveSessionId());
    const operationBusy = state.busy || managedChatGptOperations.busy;
    statusCard.dataset.phase = state.phase;
    statusTitle.textContent = operationBusy
      ? '正在自动检测并接入'
      : state.phase === 'ready'
        ? hasProject
          ? 'ChatGPT 一键接入已就绪'
          : '安装与 OpenAI 授权已就绪'
        : state.phase === 'stopped'
          ? '授权已完成，等待启用'
          : state.phase === 'login-required'
            ? '安装完成，等待 OpenAI 授权'
            : '尚未安装托管网关';
    statusDetail.textContent = hasProject
      ? state.message
      : `${state.message} 安装与授权不需要先打开项目；项目打开后再执行模型验证和保存。`;
    renderModels(state.availableModels, preferredModel);
    action.disabled = operationBusy;
    action.setAttribute('aria-busy', String(operationBusy));
    modelSelect.disabled = operationBusy || !hasProject;
    action.textContent = operationBusy
      ? '安装进行中…'
      : state.phase === 'not-installed'
        ? '一键安装并登录'
        : state.phase === 'login-required'
          ? '登录 OpenAI 并自动配置'
          : state.phase === 'stopped'
            ? hasProject
              ? '启动并用于当前项目'
              : '检查安装与登录状态'
            : hasProject
              ? '验证并用于当前项目'
              : '检查安装与登录状态';
    secondaryActions.replaceChildren();
    if (state.authenticated && !operationBusy) {
      const account = document.createElement('span');
      account.className = 'subscription-gateway-account';
      account.textContent = `当前账号：${state.accountEmail ?? '已授权账号（邮箱暂不可用）'}`;
      const relogin = document.createElement('button');
      relogin.type = 'button';
      relogin.className = 'button--danger';
      relogin.textContent = '退出当前账号';
      relogin.title = '只退出 ClaudeDock 托管账号；不会退出浏览器、Google 或其他网站账号';
      relogin.addEventListener('click', () => {
        void runLogout(relogin);
      });
      secondaryActions.append(account, relogin);
    }
    claudeConfigForm.hidden = getSelectedProviderId() === 'chatgpt-subscription';
  };

  return {
    renderState,
  };
};
