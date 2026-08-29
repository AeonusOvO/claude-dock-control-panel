import { resultFailureMessage } from '../../platform/format';
import { runManagedChatGptOperation } from './managed-chatgpt-operation';
import type { ChatGptGuideElements } from './chatgpt-guide-elements';
import type { ChatGptSubscriptionGuideDeps } from './chatgpt-guide-dependencies';
import type { ChatGptGuideRenderActions } from './chatgpt-guide-render';

export interface ChatGptGuideSetupActions {
  runLogout: (button: HTMLButtonElement) => Promise<void>;
  runSetup: (button: HTMLButtonElement) => Promise<void>;
}

const loadInitialGatewayState = (
  elements: ChatGptGuideElements,
  renderState: ChatGptGuideRenderActions['renderState'],
): void => {
  void window.controlPanel
    .getManagedChatGptGatewayState()
    .then((state) => {
      if (elements.guide.isConnected) renderState(state);
    })
    .catch(() => {
      elements.statusCard.dataset.phase = 'error';
      elements.statusTitle.textContent = '无法读取托管网关状态';
      elements.statusDetail.textContent = '请稍后重试。';
      elements.action.disabled = false;
    });
};

export const createChatGptGuideSetupActions = (
  elements: ChatGptGuideElements,
  deps: ChatGptSubscriptionGuideDeps,
  renderActions: ChatGptGuideRenderActions,
): ChatGptGuideSetupActions => {
  const { guide, statusCard, statusTitle, statusDetail, action, modelSelect } = elements;
  const {
    applyNextClaudeConnection,
    getNextClaudeConnection,
    managedChatGptOperations,
    getSelectedProviderId,
    applyPresetUi,
    showToast,
  } = deps;
  const { renderState } = renderActions;

  const runSetup = async (button: HTMLButtonElement): Promise<void> => {
    const sessionId = undefined;
    const previous = getNextClaudeConnection();
    const original = button.textContent;
    let restoreOriginalLabel = true;
    let resultStateRendered = false;
    let operationStarted = false;
    try {
      const execution = await runManagedChatGptOperation(
        managedChatGptOperations,
        sessionId,
        async (operationSessionId) => {
          operationStarted = true;
          button.disabled = true;
          modelSelect.disabled = true;
          statusCard.dataset.phase = 'installing';
          statusTitle.textContent = '正在安装并配置托管网关';
          button.textContent = '正在安装并打开授权页…';
          statusDetail.textContent =
            '如果需要登录，浏览器会自动打开 OpenAI 官方页面；完成授权后无需复制任何代码。';
          return window.controlPanel.setupManagedChatGptGateway(operationSessionId);
        },
      );
      if (!execution.started) {
        showToast('托管网关正在安装或配置，请等待当前操作完成。');
        return;
      }
      const result = execution.result;
      renderState(result.state, result.nextConnection?.config?.model);
      resultStateRendered = true;
      if (!result.ok) {
        deps.invalidateManagedChatGptAccount();
        if (result.nextConnection) {
          applyNextClaudeConnection(result.nextConnection);
        }

        statusCard.dataset.phase = 'error';
        statusTitle.textContent = '配置未完成';
        statusDetail.textContent = resultFailureMessage(result, result.message);
        if (button === action) {
          action.textContent = '重试';
          restoreOriginalLabel = false;
        }
        showToast(resultFailureMessage(result, result.message), 'error');
        return;
      }
      deps.invalidateManagedChatGptAccount();
      if (result.nextConnection) {
        applyNextClaudeConnection(result.nextConnection);
      }
      if (result.connectionTest) {
        statusDetail.textContent = result.connectionTest.message;
      }
      if (result.nextConnection?.config) deps.connectionSucceeded();
    } catch {
      deps.invalidateManagedChatGptAccount();
      applyNextClaudeConnection(previous);
      statusCard.dataset.phase = 'error';
      statusTitle.textContent = '配置未完成';
      statusDetail.textContent = '无法完成 ChatGPT 托管网关配置，请稍后重试。';
      if (button === action) {
        action.textContent = '重试';
        restoreOriginalLabel = false;
      }
      showToast('无法完成 ChatGPT 托管网关配置。', 'error');
    } finally {
      if (operationStarted) {
        if (button.isConnected) {
          button.disabled = managedChatGptOperations.busy;
          if (restoreOriginalLabel && !resultStateRendered) {
            button.textContent = original;
          }
        } else if (getSelectedProviderId() === 'chatgpt-subscription') {
          applyPresetUi('chatgpt-subscription', true);
        }
        if (guide.isConnected) {
          modelSelect.disabled = managedChatGptOperations.busy || modelSelect.options.length === 0;
        }
      }
    }
  };

  const runLogout = async (button: HTMLButtonElement): Promise<void> => {
    const sessionId = undefined;
    let operationFinished = false;
    if (!managedChatGptOperations.begin(sessionId)) {
      showToast('托管网关正在处理其他操作，请等待当前操作完成。');
      return;
    }
    button.disabled = true;
    button.textContent = '正在退出…';
    modelSelect.disabled = true;
    try {
      const result = await window.controlPanel.logoutManagedChatGptGateway();
      managedChatGptOperations.finish(sessionId);
      operationFinished = true;
      renderState(result.state);
      // A failed or partially-applied logout can leave the committed account binding uncertain.
      deps.invalidateManagedChatGptAccount();
      if (!result.ok) {
        statusCard.dataset.phase = 'error';
        statusTitle.textContent = '退出未完成';
        statusDetail.textContent = resultFailureMessage(result, result.message);
        showToast(resultFailureMessage(result, result.message), 'error');
        return;
      }
      showToast(result.message);
    } catch {
      deps.invalidateManagedChatGptAccount();
      statusCard.dataset.phase = 'error';
      statusTitle.textContent = '退出未完成';
      statusDetail.textContent = '无法退出 ClaudeDock 托管的 OpenAI 账号，请稍后重试。';
      showToast('无法退出 ClaudeDock 托管的 OpenAI 账号。', 'error');
    } finally {
      if (!operationFinished) {
        managedChatGptOperations.finish(sessionId);
      }
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = '退出当前账号';
      } else if (getSelectedProviderId() === 'chatgpt-subscription') {
        applyPresetUi('chatgpt-subscription', true);
      }
      if (guide.isConnected) {
        modelSelect.disabled = managedChatGptOperations.busy || modelSelect.options.length === 0;
      }
    }
  };

  action.addEventListener('click', () => {
    void runSetup(action);
  });
  modelSelect.addEventListener('change', () => {
    const sessionId = undefined;
    const previous = getNextClaudeConnection();
    const previousModel = previous.config?.model;
    const requestedModel = modelSelect.value;
    if (!requestedModel || !managedChatGptOperations.begin(sessionId)) {
      return;
    }
    modelSelect.disabled = true;
    void window.controlPanel
      .setManagedChatGptGatewayModel(sessionId, requestedModel)
      .then((result) => {
        managedChatGptOperations.finish(sessionId);
        renderState(result.state, result.nextConnection?.config?.model);
        if (result.nextConnection) {
          applyNextClaudeConnection(result.nextConnection);
        }
        if (!result.ok) {
          if (previousModel && result.state.availableModels.includes(previousModel)) {
            modelSelect.value = previousModel;
          }
          statusCard.dataset.phase = 'error';
          statusTitle.textContent = '模型切换未完成';
          statusDetail.textContent = resultFailureMessage(result, result.message);
          showToast(resultFailureMessage(result, result.message), 'error');
          return;
        }
        statusTitle.textContent = '下个对话模型已验证并切换';
        statusDetail.textContent = result.message;
        if (result.nextConnection?.config) deps.connectionSucceeded();
      })
      .catch(() => {
        applyNextClaudeConnection(previous);
        if (previousModel) {
          modelSelect.value = previousModel;
        }
        statusCard.dataset.phase = 'error';
        statusTitle.textContent = '模型切换未完成';
        statusDetail.textContent = '无法验证并切换所选模型。';
        showToast('无法验证并切换所选模型。', 'error');
      })
      .finally(() => {
        managedChatGptOperations.finish(sessionId);
        modelSelect.disabled = managedChatGptOperations.busy || modelSelect.options.length === 0;
      });
  });
  loadInitialGatewayState(elements, renderState);

  return {
    runLogout,
    runSetup,
  };
};
