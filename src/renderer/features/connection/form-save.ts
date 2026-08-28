import { resultFailureMessage } from '../../platform/format';
import type {
  ClaudeNextConversationConnectionState,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
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
  applyNextConnection: (state: ClaudeNextConversationConnectionState) => void,
  getNextConnection: () => ClaudeNextConversationConnectionState,
): ConnectionFormSaveActions => {
  const { runGuarded, showToast } = deps;

  const saveClaudeConfig = async (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ): Promise<boolean> => {
    const previous = getNextConnection();
    return (
      (await runGuarded(saveClaudeConfigButton, '正在保存…', async () => {
        try {
          const action =
            credentialAction === 'keep' && claudeCredential.value.trim()
              ? 'replace'
              : credentialAction;
          const result = await window.controlPanel.saveNextClaudeConfig(currentConfigInput(action));
          applyNextConnection(result.state);
          if (!result.ok) {
            showToast(resultFailureMessage(result, '无法保存接入配置。'), 'error');
            return false;
          }
          showToast('已保存');
          return true;
        } catch (error) {
          applyNextConnection(previous);
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
