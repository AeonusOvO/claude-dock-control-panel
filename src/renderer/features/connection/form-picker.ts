import type { ClaudePreset } from '../../../shared/contracts';
import {
  CLAUDE_PROVIDER_GROUPS,
  CLAUDE_PROVIDERS,
  collapsedClaudeProviderGroups,
  type ClaudeProviderId,
} from '../../../shared/claude/providers';
import { claudeCredential, providerGroups } from './form-elements';
import type { ConnectionFormDeps } from './form-dependencies';
import type { ConnectionFormState } from './form-state';

export interface ConnectionFormPickerActions {
  applyDefaultProviderGroupExpansion: (providerId?: ClaudeProviderId) => void;
  renderProviderPicker: () => void;
}

export const createConnectionFormPickerActions = (
  deps: ConnectionFormDeps,
  formState: ConnectionFormState,
  clearProviderSelection: (clearDraft?: boolean) => void,
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void,
): ConnectionFormPickerActions => {
  const { getActiveSessionId, claudeStates, connectionFeature, showToast } = deps;

  const applyDefaultProviderGroupExpansion = (providerId?: ClaudeProviderId): void => {
    formState.collapsedProviderGroups.clear();
    for (const groupId of collapsedClaudeProviderGroups(providerId)) {
      formState.collapsedProviderGroups.add(groupId);
    }
  };

  function renderProviderPicker(): void {
    providerGroups.replaceChildren();
    const configuredPreset = claudeStates.get(getActiveSessionId())?.config.preset;
    for (const group of CLAUDE_PROVIDER_GROUPS) {
      const providers = CLAUDE_PROVIDERS.filter((provider) => provider.group === group.id);
      const collapsed = formState.collapsedProviderGroups.has(group.id);
      const section = document.createElement('section');
      section.className = 'provider-group';
      section.dataset.collapsed = String(collapsed);

      const toggle = document.createElement('button');
      toggle.className = 'provider-group__toggle';
      toggle.type = 'button';
      toggle.setAttribute('aria-controls', `provider-group-${group.id}`);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      const heading = document.createElement('span');
      heading.className = 'provider-group__title';
      heading.textContent = group.label;
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      arrow.setAttribute('class', 'provider-group__arrow');
      arrow.setAttribute('viewBox', '0 0 24 24');
      arrow.setAttribute('aria-hidden', 'true');
      const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arrowPath.setAttribute('d', 'm9 5 7 7-7 7');
      arrow.append(arrowPath);
      toggle.append(heading, arrow);

      const content = document.createElement('div');
      content.className = 'provider-group__content';
      content.id = `provider-group-${group.id}`;
      content.inert = collapsed;
      content.setAttribute('aria-hidden', String(collapsed));
      const grid = document.createElement('div');
      grid.className = 'provider-card-grid';
      for (const provider of providers) {
        const card = document.createElement('button');
        card.className = 'provider-card';
        card.type = 'button';
        card.dataset.providerId = provider.id;
        card.classList.toggle(
          'provider-card--selected',
          provider.id === formState.selectedProviderId,
        );
        card.setAttribute('aria-pressed', String(provider.id === formState.selectedProviderId));
        card.disabled =
          connectionFeature.isTestInProgress() || connectionFeature.isRemedyInProgress();

        const title = document.createElement('strong');
        title.textContent = provider.label;
        const detail = document.createElement('span');
        detail.textContent = provider.description;
        card.append(title, detail);
        if (provider.group === 'subscription') {
          const badge = document.createElement('small');
          badge.textContent = '本地转换 · 非官方直连';
          card.append(badge);
        }
        if (provider.id === configuredPreset) {
          const badge = document.createElement('small');
          badge.textContent = '当前配置';
          card.append(badge);
        }
        card.addEventListener('click', () => {
          if (!formState.connectionEnvironmentReady && provider.id !== 'chatgpt-subscription') {
            showToast('请先安装或更新 Claude Code。', 'error');
            return;
          }
          if (formState.selectedProviderId === provider.id) {
            clearProviderSelection();
            showToast('已取消服务商选择');
            return;
          }
          applyPresetUi(provider.id, false);
          claudeCredential.value = '';
          connectionFeature.clearTestResult();
          renderProviderPicker();
        });
        grid.append(card);
      }
      content.append(grid);
      toggle.addEventListener('click', () => {
        const nextCollapsed = !formState.collapsedProviderGroups.has(group.id);
        if (nextCollapsed) {
          formState.collapsedProviderGroups.add(group.id);
        } else {
          formState.collapsedProviderGroups.delete(group.id);
        }
        section.dataset.collapsed = String(nextCollapsed);
        toggle.setAttribute('aria-expanded', String(!nextCollapsed));
        content.inert = nextCollapsed;
        content.setAttribute('aria-hidden', String(nextCollapsed));
      });
      section.append(toggle, content);
      providerGroups.append(section);
    }
  }

  return {
    applyDefaultProviderGroupExpansion,
    renderProviderPicker,
  };
};
