import type { ClaudeConnectionTestResult, SaveClaudeConfigInput } from '../../../shared/contracts';
import type { ConnectionActionsDependencies } from './dependencies';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';
import type { ConnectionView } from './view';

export interface ConnectionTestActions {
  runConnectionTest: (
    saveOnSuccess?: boolean,
    configInput?: SaveClaudeConfigInput,
  ) => Promise<void>;
}

export const createConnectionTestActions = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionActionsDependencies,
  view: ConnectionView,
  renderConnectionTest: (result: ClaudeConnectionTestResult) => void,
): ConnectionTestActions => {
  const runConnectionTest = async (
    saveOnSuccess = true,
    configInput?: SaveClaudeConfigInput,
  ): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.connectionTestInProgress) {
      return;
    }
    state.connectionTestInProgress = true;
    view.renderConnectionTestPending();
    const knownState = dependencies.getClaudeState(status.id);
    if (knownState) {
      dependencies.renderClaudeState(knownState, true, false);
    }
    const originalLabel = elements.testClaudeConnectionButton.textContent;
    elements.testClaudeConnectionButton.disabled = true;
    elements.testClaudeConnectionButton.setAttribute('aria-busy', 'true');
    elements.testClaudeConnectionButton.textContent = '正在发送单令牌测试…';
    dependencies.syncConnectionInteractivity();
    try {
      const result = await window.controlPanel.testClaudeConnection(
        status.id,
        configInput ?? dependencies.currentConfigInput('keep'),
      );
      renderConnectionTest(result);
      if (result.ok && saveOnSuccess) {
        await dependencies.saveClaudeConfig('keep');
      } else {
        void dependencies.loadClaudeState(status.id);
      }
    } catch (error) {
      elements.connectionTestResult.dataset.tone = 'error';
      elements.connectionTestTitle.textContent = '连接测试发生异常';
      elements.connectionTestSummary.textContent =
        error instanceof Error ? error.message : '后台测试已结束，请稍后重试。';
      elements.connectionTestStages.replaceChildren();
      elements.connectionRemedy.hidden = true;
      dependencies.showToast(
        error instanceof Error ? error.message : '连接测试发生异常。',
        'error',
      );
    } finally {
      state.connectionTestInProgress = false;
      elements.connectionTestResult.setAttribute('aria-busy', 'false');
      elements.testClaudeConnectionButton.setAttribute('aria-busy', 'false');
      elements.testClaudeConnectionButton.textContent = originalLabel;
      dependencies.syncConnectionInteractivity();
      const latestState = dependencies.getClaudeState(status.id);
      if (latestState) {
        dependencies.renderClaudeState(latestState, true, false);
      }
    }
  };

  return { runConnectionTest };
};
