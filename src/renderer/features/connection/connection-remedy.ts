import type { ClaudeConnectionTestResult, SaveClaudeConfigInput } from '../../../shared/contracts';
import {
  diagnoseClaudeConnection,
  type ClaudeConnectionRemedyAction,
} from '../../../shared/claude/connection-remedy';
import { findClaudeProvider } from '../../../shared/claude/providers';
import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';

export interface ConnectionRemedyActions {
  renderConnectionTest: (result: ClaudeConnectionTestResult) => void;
}

export const createConnectionRemedyActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  runConnectionTest: (
    saveOnSuccess?: boolean,
    configInput?: SaveClaudeConfigInput,
  ) => Promise<void>,
): ConnectionRemedyActions => {
  const renderConnectionTest = (result: ClaudeConnectionTestResult): void => {
    elements.connectionTestResult.hidden = false;
    elements.connectionTestResult.dataset.tone = result.tone;
    elements.connectionTestResult.setAttribute('aria-busy', 'false');
    elements.connectionTestTitle.textContent =
      result.tone === 'success'
        ? '连接测试通过'
        : result.tone === 'warning'
          ? '部分通过，还需处理'
          : '连接测试未通过';
    const message = result.ok
      ? result.message
      : dependencies.resultFailureMessage(result, result.message);
    elements.connectionTestSummary.textContent = `${message}${
      result.latencyMs === undefined ? '' : ` · ${result.latencyMs} ms`
    }`;
    elements.connectionTestStages.replaceChildren();
    for (const resultStage of result.stages) {
      const item = document.createElement('div');
      item.dataset.status = resultStage.status;
      const icon = document.createElement('span');
      icon.textContent =
        resultStage.status === 'passed'
          ? '✓'
          : resultStage.status === 'failed'
            ? '×'
            : resultStage.status === 'warning'
              ? '!'
              : '–';
      const copy = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = resultStage.label;
      const detail = document.createElement('span');
      detail.textContent = resultStage.detail;
      copy.append(label, detail);
      item.append(icon, copy);
      elements.connectionTestStages.append(item);
    }

    const projectState = dependencies.getClaudeState(dependencies.getActiveSessionId());
    const remedy = diagnoseClaudeConnection(result, {
      installationSecurity: projectState?.installation.security,
      provider: findClaudeProvider(dependencies.getSelectedProviderId()),
      routerInstalled: dependencies.router.getManagementState()?.installed,
      routerRunning: dependencies.router.getManagementState()?.gatewayState === 'running',
    });
    elements.connectionRemedy.hidden = !remedy;
    dependencies.connectionRemedyActions.replaceChildren();
    if (!remedy) {
      return;
    }
    elements.connectionRemedyTitle.textContent = remedy.title;
    elements.connectionRemedyCause.textContent = `原因：${remedy.cause}`;
    elements.connectionRemedyFix.textContent = `建议：${remedy.fix}`;
    for (const action of remedy.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        void runConnectionRemedyAction(button, action);
      });
      dependencies.connectionRemedyActions.append(button);
    }
  };

  const runConnectionRemedyAction = async (
    button: HTMLButtonElement,
    action: ClaudeConnectionRemedyAction,
  ): Promise<void> => {
    if (state.connectionRemedyInProgress || state.connectionTestInProgress) {
      return;
    }
    state.connectionRemedyInProgress = true;
    elements.connectionRemedy.setAttribute('aria-busy', 'true');
    const originalLabel = button.textContent;
    button.textContent = '处理中…';
    dependencies.syncConnectionInteractivity();
    try {
      await handleConnectionRemedyAction(action);
    } finally {
      state.connectionRemedyInProgress = false;
      elements.connectionRemedy.setAttribute('aria-busy', 'false');
      button.textContent = originalLabel;
      dependencies.syncConnectionInteractivity();
    }
  };

  const handleConnectionRemedyAction = async (
    action: ClaudeConnectionRemedyAction,
  ): Promise<void> => {
    switch (action.kind) {
      case 'open-console':
      case 'open-docs':
        if (action.url) {
          await dependencies.openExternal(action.url);
        }
        break;
      case 'switch-auth-mode':
        if (
          action.authMode &&
          Array.from(dependencies.claudeAuthMode.options).some(
            (option) => option.value === action.authMode,
          )
        ) {
          dependencies.claudeAuthMode.value = action.authMode;
        } else {
          dependencies.setAuthOptions(
            [
              { label: '接口密钥（X-Api-Key）', value: 'apiKey' },
              { label: '持有者令牌（Authorization / Bearer）', value: 'authToken' },
            ],
            action.authMode,
          );
        }
        dependencies.credentialField.hidden = false;
        dependencies.claudeCredential.focus();
        break;
      case 'use-fast-model': {
        const provider = findClaudeProvider(dependencies.getSelectedProviderId());
        if (provider?.modelFast) {
          dependencies.claudeModel.value = provider.modelFast;
          dependencies.claudeModelFast.value = provider.modelFast;
        }
        break;
      }
      case 'install-claude':
        dependencies.environmentSetup.hidden = false;
        dependencies.environmentSetup.scrollIntoView({
          behavior: userScrollBehavior(),
          block: 'start',
        });
        await dependencies.updates.runClaudeInstallUpdate();
        break;
      case 'install-router':
        await dependencies.router.runOperation(
          (sessionId) => window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
          '正在安装…',
          dependencies.installRouterButton,
        );
        break;
      case 'start-router':
        await dependencies.router.runOperation(
          (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
          '正在启动…',
          dependencies.startRouterButton,
        );
        break;
      case 'retry':
        await runConnectionTest(false);
        break;
      case 'switch-provider':
        dependencies.clearProviderSelection();
        dependencies.providerPicker.scrollIntoView({
          behavior: userScrollBehavior(),
          block: 'start',
        });
        break;
    }
  };

  return { renderConnectionTest };
};
import { userScrollBehavior } from '../../platform/motion';
