import type {
  ClaudeConnectionAdvice,
  ClaudeConnectionAdviceAction,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';

export interface ConnectionAdviceActions {
  loadConnectionAdvice: () => Promise<void>;
}

export const createConnectionAdviceActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  runConnectionTest: (
    saveOnSuccess?: boolean,
    configInput?: SaveClaudeConfigInput,
  ) => Promise<void>,
): ConnectionAdviceActions => {
  const adviceActionLabel: Record<ClaudeConnectionAdviceAction, string> = {
    'import-curl': '粘贴中转站 cURL',
    'install-router': '安装路由器',
    'open-router-management': '打开路由器管理页',
    'save-config': '去填写接入配置',
    'start-router': '启动路由器',
    'stop-router': '停止空闲路由器',
    'switch-to-direct': '改用兼容接口',
    'switch-to-router': '改为经过路由器',
    'test-connection': '做一次真实连接测试',
  };

  const focusConnectionForm = (): void => {
    dependencies.selectRailTab('connection');
    dependencies.claudeConfigForm.scrollIntoView({
      behavior: userScrollBehavior(),
      block: 'start',
    });
  };

  const runAdviceAction = (
    action: ClaudeConnectionAdviceAction,
    button: HTMLButtonElement,
  ): void => {
    switch (action) {
      case 'install-router': {
        void dependencies.router.runOperation(
          (sessionId) => window.controlPanel.installClaudeRouter(sessionId),
          '正在下载并校验…',
          button,
        );
        return;
      }
      case 'start-router': {
        void dependencies.router.runOperation(
          (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
          '正在启动…',
          button,
        );
        return;
      }
      case 'stop-router': {
        void dependencies.router.runOperation(
          (sessionId) => window.controlPanel.stopClaudeRouter(sessionId),
          '正在停止…',
          button,
        );
        return;
      }
      case 'open-router-management': {
        void dependencies.router.runOperation(
          (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
          '正在打开…',
          button,
        );
        return;
      }
      case 'import-curl': {
        dependencies.selectRailTab('connection');
        elements.curlInput.scrollIntoView({ behavior: userScrollBehavior(), block: 'center' });
        elements.curlInput.focus();
        return;
      }
      case 'save-config': {
        focusConnectionForm();
        dependencies.claudeCredential.focus();
        return;
      }
      case 'switch-to-direct': {
        dependencies.claudePreset.value = 'custom';
        dependencies.applyPresetUi('custom', true);
        dependencies.claudeBaseUrl.value = '';
        focusConnectionForm();
        dependencies.claudeBaseUrl.focus();
        dependencies.showToast('已切到直连模式；填入中转站地址后保存即可');
        return;
      }
      case 'switch-to-router': {
        dependencies.claudePreset.value = 'gateway';
        dependencies.applyPresetUi('gateway', true);
        dependencies.claudeBaseUrl.value = 'http://127.0.0.1:3456';
        focusConnectionForm();
        dependencies.showToast('已填入本机路由器地址；确认模型后保存');
        return;
      }
      case 'test-connection': {
        dependencies.selectRailTab('connection');
        void runConnectionTest(false);
      }
    }
  };

  const renderConnectionAdvice = (advice: ClaudeConnectionAdvice): void => {
    state.connectionAdviceState = advice;
    dependencies.connectionAdvice.dataset.tone = advice.tone;
    elements.connectionAdviceTitle.textContent = advice.title;
    elements.connectionAdviceDetail.textContent = advice.detail;
    elements.connectionAdviceActions.replaceChildren();

    for (const [index, action] of advice.actions.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `button button--${index === 0 ? 'primary' : 'secondary'} button--small`;
      button.textContent = adviceActionLabel[action];
      button.addEventListener('click', () => {
        runAdviceAction(action, button);
      });
      elements.connectionAdviceActions.append(button);
    }
    dependencies.updates.applyRouterRelevance();
  };

  const loadConnectionAdvice = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.adviceRefreshInProgress) {
      return;
    }
    state.adviceRefreshInProgress = true;
    try {
      renderConnectionAdvice(await window.controlPanel.getClaudeConnectionAdvice(status.id));
    } catch {
      dependencies.connectionAdvice.dataset.tone = 'warning';
      elements.connectionAdviceTitle.textContent = '暂时无法判断接入方式';
      elements.connectionAdviceDetail.textContent = '仍可手动检查下面的路由器与接入配置。';
    } finally {
      state.adviceRefreshInProgress = false;
    }
  };

  return { loadConnectionAdvice };
};
import { userScrollBehavior } from '../../platform/motion';
