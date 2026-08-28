import type { ClaudePreset } from '../../../shared/contracts';
import {
  CLAUDE_PROVIDERS,
  findClaudeProvider,
  type ClaudeProviderId,
} from '../../../shared/claude/providers';
import { enhanceSelect } from '../../platform/components';
import { claudeCredential, providerGroups } from './form-elements';
import type { ConnectionFormDeps } from './form-dependencies';
import type { ConnectionFormState } from './form-state';
import { connectionModelSourceForProvider, type ConnectionModelSource } from './history-source';

const ACCESS_CHOICES: ReadonlyArray<{
  detail: string;
  id: ConnectionModelSource;
  label: string;
  providerId: ClaudeProviderId;
}> = [
  {
    detail: '使用 Claude Code 已有的官方登录',
    id: 'claude-subscription',
    label: 'Claude 官方订阅',
    providerId: 'anthropic',
  },
  {
    detail: '登录 ChatGPT 账号',
    id: 'chatgpt-subscription',
    label: 'ChatGPT 官方订阅',
    providerId: 'chatgpt-subscription',
  },
  {
    detail: 'DeepSeek、千问、GLM 等国内服务',
    id: 'domestic',
    label: '国产模型',
    providerId: 'deepseek',
  },
  {
    detail: '填写网址和密钥',
    id: 'api',
    label: 'API / 中转站',
    providerId: 'custom',
  },
];

export const accessChoiceForProvider = connectionModelSourceForProvider;

export interface ConnectionFormPickerActions {
  applyDefaultProviderGroupExpansion: (providerId?: ClaudeProviderId) => void;
  renderProviderPicker: () => void;
}

export const createConnectionFormPickerActions = (
  deps: ConnectionFormDeps,
  formState: ConnectionFormState,
  _clearProviderSelection: (clearDraft?: boolean) => void,
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void,
): ConnectionFormPickerActions => {
  const { connectionFeature } = deps;

  const applyDefaultProviderGroupExpansion = (): void => {
    formState.collapsedProviderGroups.clear();
  };

  const selectProvider = (providerId: ClaudeProviderId): void => {
    if (
      connectionFeature.isTestInProgress() ||
      connectionFeature.isRemedyInProgress() ||
      formState.subscriptionPending ||
      formState.subscription?.busy ||
      formState.managedChatGptOperations.busy
    )
      return;
    applyPresetUi(providerId, false);
    claudeCredential.value = '';
    connectionFeature.clearTestResult();
    formState.renderWizard?.();
  };

  const renderProviderPicker = (): void => {
    providerGroups.replaceChildren();
    const configuredPreset = formState.nextConnection?.config?.preset;
    const selectedAccess = accessChoiceForProvider(formState.selectedProviderId);
    const grid = document.createElement('div');
    grid.className = 'access-choice-grid';

    for (const choice of ACCESS_CHOICES) {
      const card = document.createElement('button');
      card.className = 'access-choice-card';
      card.type = 'button';
      card.dataset.accessChoice = choice.id;
      card.dataset.providerId =
        choice.id === 'domestic' &&
        findClaudeProvider(formState.selectedProviderId)?.group === 'domestic'
          ? (formState.selectedProviderId ?? choice.providerId)
          : choice.providerId;
      const selected = choice.id === selectedAccess;
      card.classList.toggle('access-choice-card--selected', selected);
      card.setAttribute('aria-pressed', String(selected));
      card.disabled =
        connectionFeature.isTestInProgress() ||
        connectionFeature.isRemedyInProgress() ||
        formState.subscriptionPending ||
        formState.subscription?.busy === true ||
        formState.managedChatGptOperations.busy;

      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = choice.label;
      const detail = document.createElement('small');
      detail.textContent = choice.detail;
      copy.append(title, detail);
      const check = document.createElement('span');
      check.className = 'access-choice-card__check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      card.append(copy, check);

      if (configuredPreset && accessChoiceForProvider(configuredPreset) === choice.id) {
        const current = document.createElement('small');
        current.className = 'access-choice-card__current';
        current.textContent = '下个对话';
        card.append(current);
      }
      card.addEventListener('click', () => {
        const providerId: ClaudeProviderId =
          choice.id === 'domestic' &&
          findClaudeProvider(formState.selectedProviderId)?.group === 'domestic'
            ? (formState.selectedProviderId ?? 'deepseek')
            : choice.providerId;
        selectProvider(providerId);
      });
      grid.append(card);
    }
    providerGroups.append(grid);

    if (selectedAccess === 'domestic') {
      const picker = document.createElement('div');
      picker.className = 'domestic-model-picker';
      const label = document.createElement('label');
      label.htmlFor = 'connection-domestic-model';
      label.textContent = '选择国产模型';
      const select = document.createElement('select');
      select.id = 'connection-domestic-model';
      const domesticProviders = CLAUDE_PROVIDERS.filter(
        (provider) =>
          provider.group === 'domestic' &&
          (!['glm-cn', 'kimi-code'].includes(provider.id) ||
            formState.selectedProviderId === provider.id),
      );
      select.replaceChildren(
        ...domesticProviders.map((provider) => {
          const option = document.createElement('option');
          option.value = provider.id;
          option.textContent = provider.label;
          option.dataset.badge = provider.codingPlan ? '订阅' : 'API';
          option.setAttribute('aria-label', `${option.dataset.badge} · ${provider.label}`);
          return option;
        }),
      );
      const selectedDomestic: ClaudeProviderId =
        findClaudeProvider(formState.selectedProviderId)?.group === 'domestic'
          ? (formState.selectedProviderId ?? 'deepseek')
          : 'deepseek';
      select.value = selectedDomestic;
      select.disabled =
        connectionFeature.isTestInProgress() ||
        connectionFeature.isRemedyInProgress() ||
        formState.subscriptionPending ||
        formState.subscription?.busy === true ||
        formState.managedChatGptOperations.busy;
      const hint = document.createElement('small');
      hint.textContent = `当前已选择 ${findClaudeProvider(selectedDomestic)?.label ?? 'DeepSeek'}`;
      select.addEventListener('change', () => {
        selectProvider(select.value as ClaudeProviderId);
      });
      picker.append(label, select, hint);
      providerGroups.append(picker);
      enhanceSelect(select);
    }
  };

  return {
    applyDefaultProviderGroupExpansion,
    renderProviderPicker,
  };
};
