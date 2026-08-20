import type {
  ClaudeContextWindowMode,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
} from '../../../shared/contracts';
import { footerResource } from './elements';
import type { FooterMenus } from './menus';
import { footerState } from './state';
import type { FooterSwitchesDeps } from './switches-dependencies';

export interface FooterSwitchesPreferencesActions {
  applyClaudeContextWindowMode: (mode: ClaudeContextWindowMode, customTokens?: number) => void;
  applyManagedChatGptContextWindowMode: (mode: ManagedChatGptContextWindowMode) => void;
  applyFooterResourcePreference: (preference: FooterResourcePreference) => void;
}

export const createFooterSwitchesPreferencesActions = (
  deps: FooterSwitchesDeps,
  menus: FooterMenus,
): FooterSwitchesPreferencesActions => {
  const {
    activeDevelopmentRuntime,
    activeStatus,
    claudeStates,
    codexStates,
    hasActiveConversation,
    renderActiveConversation,
    showToast,
  } = deps;
  const {
    hideFooterMenus,
    managedContextWindowSelectable,
    renderFooterResource,
    syncClaudeContextWindowSelection,
    syncManagedChatGptContextWindowSelection,
  } = menus;

  const applyClaudeContextWindowMode = (
    mode: ClaudeContextWindowMode,
    customTokens?: number,
  ): void => {
    void window.controlPanel
      .setClaudeContextWindowMode(mode, customTokens)
      .then((settings) => {
        footerState.claudeContextWindowMode = settings.claudeContextWindowMode;
        footerState.claudeContextWindowCustomTokens = settings.claudeContextWindowCustomTokens;
        footerState.claudeContextWindowCustomDraftOpen = false;
        syncClaudeContextWindowSelection();
        // Refresh footer resource view with updated context window configuration
        const status = activeStatus();
        // If native conversation is active, re-render its footer with new config
        if (hasActiveConversation()) {
          renderActiveConversation();
        } else if (status) {
          // Otherwise refresh from terminal Claude state
          const codexSelected = activeDevelopmentRuntime() === 'codex';
          const claudeState = !codexSelected ? claudeStates.get(status.id) : undefined;
          if (claudeState) {
            renderFooterResource(
              claudeState.resourceUsage,
              managedContextWindowSelectable(claudeState),
            );
          }
        }
        hideFooterMenus();
        footerResource.focus();
        showToast('上下文窗口已保存；下次新建或重启 Claude 会话生效。');
      })
      .catch(() => showToast('无法保存 Claude 上下文窗口选择。', 'error'));
  };

  const applyManagedChatGptContextWindowMode = (
    contextWindowMode: ManagedChatGptContextWindowMode,
  ): void => {
    void window.controlPanel
      .setManagedChatGptContextWindowMode(contextWindowMode)
      .then((settings) => {
        footerState.managedChatGptContextWindowMode = settings.managedChatGptContextWindowMode;
        syncManagedChatGptContextWindowSelection();
        // If native conversation is active, re-render its footer with new config
        if (hasActiveConversation()) {
          renderActiveConversation();
        }
        hideFooterMenus();
        footerResource.focus();
        showToast('上下文窗口选择已保存；下次新建或重启托管 ChatGPT 会话生效。');
      })
      .catch(() => showToast('无法保存 ChatGPT 上下文窗口选择。', 'error'));
  };

  const applyFooterResourcePreference = (preference: FooterResourcePreference): void => {
    void window.controlPanel
      .setFooterResourcePreference(preference)
      .then((settings) => {
        footerState.footerResourcePreference = settings.footerResourcePreference;
        // If native conversation is active, re-render its footer with new preference
        if (hasActiveConversation()) {
          renderActiveConversation();
        } else {
          // Otherwise refresh from terminal state
          const status = activeStatus();
          const codexSelected = activeDevelopmentRuntime() === 'codex';
          const claudeState = status && !codexSelected ? claudeStates.get(status.id) : undefined;
          const usage = status
            ? codexSelected
              ? codexStates.get(status.id)?.resourceUsage
              : claudeState?.resourceUsage
            : undefined;
          renderFooterResource(usage, managedContextWindowSelectable(claudeState));
        }
        hideFooterMenus();
        footerResource.focus();
      })
      .catch(() => showToast('无法保存底栏资源偏好。', 'error'));
  };

  return {
    applyClaudeContextWindowMode,
    applyManagedChatGptContextWindowMode,
    applyFooterResourcePreference,
  };
};
