import type { ManagedChatGptGatewayState } from '../../../shared/contracts';
import { recommendedChatModel } from '../../../shared/claude/managed-chatgpt-models';
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
    getNextClaudeConnection,
    managedChatGptOperations,
    setRenderManagedChatGptProgress,
    getSelectedProviderId,
    claudeConfigForm,
  } = deps;

  const renderModels = (models: readonly string[], preferredModel?: string): void => {
    const nextModel = getNextClaudeConnection().config?.model;
    const selected =
      preferredModel && models.includes(preferredModel)
        ? preferredModel
        : nextModel && models.includes(nextModel)
          ? nextModel
          : models.includes(modelSelect.value)
            ? modelSelect.value
            : models.length > 0
              ? recommendedChatModel(models)
              : undefined;
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
    const matchesCurrentScope = progress.sessionId === undefined;
    action.disabled = managedChatGptOperations.busy;
    action.setAttribute('aria-busy', String(managedChatGptOperations.busy));
    modelSelect.disabled = managedChatGptOperations.busy || modelSelect.options.length === 0;
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
    const operationBusy = state.busy || managedChatGptOperations.busy;
    statusCard.dataset.phase = state.phase;
    statusTitle.textContent = operationBusy
      ? '正在自动检测并接入'
      : state.phase === 'ready'
        ? 'ChatGPT 一键接入已就绪'
        : state.phase === 'stopped'
          ? '授权已完成，等待启用'
          : state.phase === 'login-required'
            ? '安装完成，等待 OpenAI 授权'
            : '尚未安装托管网关';
    statusDetail.textContent = `${state.message} 这里的选择将由下个新对话捕获。`;
    renderModels(state.availableModels, preferredModel);
    action.disabled = operationBusy;
    action.setAttribute('aria-busy', String(operationBusy));
    modelSelect.disabled = operationBusy || state.availableModels.length === 0;
    action.textContent = operationBusy
      ? '安装进行中…'
      : state.phase === 'not-installed'
        ? '一键安装并登录'
        : state.phase === 'login-required'
          ? '登录 OpenAI 并自动配置'
          : state.phase === 'stopped'
            ? '启动并设为下个对话接入'
            : '验证并设为下个对话接入';
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
