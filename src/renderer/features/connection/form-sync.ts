import type { SaveClaudeConfigInput } from '../../../shared/contracts';
import {
  claudeApiKeyHelperPolicy,
  claudeApiKeyHelperStatus,
  claudeAuthMode,
  claudeConfigForm,
  clearCredentialButton,
  connectionRemedyActions,
  providerGroups,
  providerPicker,
} from './form-elements';
import type { ConnectionFormDeps } from './form-dependencies';
import type { ConnectionFormState } from './form-state';

export interface ConnectionFormSyncActions {
  setAuthOptions: (
    options: Array<{ label: string; value: SaveClaudeConfigInput['authMode'] }>,
    selected?: SaveClaudeConfigInput['authMode'],
  ) => void;
  syncApiKeyHelperPolicyUi: () => void;
  syncConnectionInteractivity: () => void;
}

export const createConnectionFormSyncActions = (
  deps: ConnectionFormDeps,
  formState: ConnectionFormState,
): ConnectionFormSyncActions => {
  const { getActiveSessionId, claudeStates, connectionFeature } = deps;

  const setAuthOptions = (
    options: Array<{ label: string; value: SaveClaudeConfigInput['authMode'] }>,
    selected?: SaveClaudeConfigInput['authMode'],
  ): void => {
    claudeAuthMode.replaceChildren();
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      claudeAuthMode.append(element);
    }
    if (selected && options.some((option) => option.value === selected)) {
      claudeAuthMode.value = selected;
    }
  };

  const syncApiKeyHelperPolicyUi = (): void => {
    const usesExplicitCredential =
      claudeAuthMode.value === 'apiKey' || claudeAuthMode.value === 'authToken';
    claudeApiKeyHelperPolicy.disabled =
      !formState.connectionEnvironmentReady ||
      connectionFeature.isTestInProgress() ||
      connectionFeature.isRemedyInProgress() ||
      !usesExplicitCredential;
    const helperSources =
      connectionFeature
        .getDiagnostics()
        ?.configurationHints.filter((hint) => hint.apiKeyHelperConfigured)
        .map((hint) => hint.label) ?? [];
    const helperDetail =
      helperSources.length > 0
        ? `已检测到：${helperSources.join('、')}。`
        : '当前未检测到 helper。';

    if (!usesExplicitCredential) {
      claudeApiKeyHelperStatus.textContent =
        '当前连接没有注入 ClaudeDock 密钥；apiKeyHelper 继续属于 Claude Code 自己的认证链。';
      return;
    }
    claudeApiKeyHelperStatus.textContent =
      claudeApiKeyHelperPolicy.value === 'prefer-claudedock'
        ? `${helperDetail} 启动时会用临时高优先级设置停用它，只保留本项目加密保存的凭据；原设置文件不变。`
        : `${helperDetail} 将按 Claude Code 官方优先级保留 helper；同时填写静态 API Key 时，Claude Code 可能显示双重认证警告。`;
  };

  const syncConnectionInteractivity = (): void => {
    const busy = connectionFeature.isTestInProgress() || connectionFeature.isRemedyInProgress();
    providerPicker.setAttribute('aria-disabled', String(busy));
    providerPicker.inert = busy;
    claudeConfigForm.inert = !formState.connectionEnvironmentReady || busy;
    connectionRemedyActions.inert = busy;
    for (const button of providerGroups.querySelectorAll<HTMLButtonElement>('.provider-card')) {
      button.disabled = busy;
    }
    for (const control of claudeConfigForm.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >('button, input, select')) {
      control.disabled = !formState.connectionEnvironmentReady || busy;
    }
    for (const button of connectionRemedyActions.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = busy;
    }
    if (formState.connectionEnvironmentReady && !busy) {
      const config = claudeStates.get(getActiveSessionId())?.config;
      clearCredentialButton.disabled = !(
        config?.sourceCredentialConfigured ?? config?.credentialConfigured
      );
    }
    syncApiKeyHelperPolicyUi();
  };

  return {
    setAuthOptions,
    syncApiKeyHelperPolicyUi,
    syncConnectionInteractivity,
  };
};
