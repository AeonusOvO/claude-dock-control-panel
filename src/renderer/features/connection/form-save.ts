import { resultFailureMessage } from '../../platform/format';
import type { ClaudeProjectState, SaveClaudeConfigInput } from '../../../shared/contracts';
import { claudeCredential, saveClaudeConfigButton } from './form-elements';
import type { ConnectionFormDeps } from './form-dependencies';

export interface ConnectionFormSaveActions {
  saveClaudeConfig: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => Promise<boolean>;
}

export const createConnectionFormSaveActions = (
  deps: ConnectionFormDeps,
  currentConfigInput: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => SaveClaudeConfigInput,
  populateClaudeConfigForm: (state: ClaudeProjectState) => void,
): ConnectionFormSaveActions => {
  const { activeStatus, runGuarded, renderClaudeState, showToast, loadConnectionHistory } = deps;

  const saveClaudeConfig = async (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ): Promise<boolean> => {
    const status = activeStatus();
    if (!status) {
      return false;
    }
    return (
      (await runGuarded(saveClaudeConfigButton, '正在保存…', async () => {
        try {
          const action =
            credentialAction === 'keep' && claudeCredential.value.trim()
              ? 'replace'
              : credentialAction;
          const result = await window.controlPanel.saveClaudeConfig(
            status.id,
            currentConfigInput(action),
          );
          renderClaudeState(result.state);
          if (!result.ok) {
            showToast(resultFailureMessage(result, '无法保存接入配置。'), 'error');
            return false;
          }
          populateClaudeConfigForm(result.state);
          showToast('当前项目的模型与接口接入已保存');
          void loadConnectionHistory();
          return true;
        } catch (error) {
          showToast(error instanceof Error ? error.message : '无法保存接入配置。', 'error');
          return false;
        }
      })) ?? false
    );
  };

  return {
    saveClaudeConfig,
  };
};
