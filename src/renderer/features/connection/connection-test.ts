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
    if (state.connectionTestInProgress) {
      return;
    }
    const activeStatus = configInput ? dependencies.activeStatus() : undefined;
    state.connectionTestInProgress = true;
    view.renderConnectionTestPending();
    const activeState = activeStatus ? dependencies.getClaudeState(activeStatus.id) : undefined;
    if (activeState) {
      dependencies.renderClaudeState(activeState, true, false);
    }
    const originalLabel = elements.testClaudeConnectionButton.textContent;
    elements.testClaudeConnectionButton.disabled = true;
    elements.testClaudeConnectionButton.setAttribute('aria-busy', 'true');
    elements.testClaudeConnectionButton.textContent = '正在连接…';
    dependencies.syncConnectionInteractivity();
    try {
      const input = configInput ?? dependencies.currentConfigInput('keep');
      if (
        !activeStatus &&
        saveOnSuccess &&
        (input.autoDetect || (input.preset === 'anthropic' && input.authMode === 'existing'))
      ) {
        const result = await window.controlPanel.saveNextClaudeConfig(input);
        if (result.ok) dependencies.applyNextClaudeConnection(result.state);
        const message = result.ok ? '已连接。' : (result.error ?? '连接失败，请重试。');
        renderConnectionTest(
          result.connectionTest ?? {
            message,
            ok: result.ok,
            stages: [],
            testedAt: Date.now(),
            tone: result.ok ? 'success' : 'error',
          },
        );
        if (result.ok) dependencies.connectionSucceeded();
        else dependencies.showToast(message, 'error');
        return;
      }
      const result =
        activeStatus && configInput
          ? await window.controlPanel.testClaudeConnection(activeStatus.id, configInput)
          : await window.controlPanel.testNextClaudeConnection(input);
      renderConnectionTest(result);
      if (result.ok && saveOnSuccess) {
        if (await dependencies.saveClaudeConfig('keep')) dependencies.connectionSucceeded();
      } else if (activeStatus) {
        await dependencies.loadClaudeState(activeStatus.id);
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
      if (activeStatus) {
        await dependencies.loadClaudeState(activeStatus.id);
        const latestState = dependencies.getClaudeState(activeStatus.id);
        if (latestState) {
          dependencies.renderClaudeState(latestState, true, false);
        }
      }
    }
  };

  return { runConnectionTest };
};
