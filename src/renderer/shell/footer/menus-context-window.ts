import { stripClaudeContextWindowSuffix } from '../../../shared/claude/model-id';
import type { ClaudeProjectState } from '../../../shared/contracts';
import {
  claudeContextWindowCustomField,
  claudeContextWindowCustomInput,
  claudeContextWindowOptions,
  footerContextWindowOptions,
} from './elements';
import { footerState } from './state';

export interface FooterMenusContextWindowActions {
  managedContextWindowSelectable: (
    state: ClaudeProjectState | undefined,
    selectedModel?: string,
  ) => boolean;
  syncManagedChatGptContextWindowSelection: () => void;
  syncClaudeContextWindowSelection: () => void;
  requestedClaudeContextWindowTokens: () => number | undefined;
}

export const createFooterMenusContextWindowActions = (): FooterMenusContextWindowActions => {
  const managedContextWindowSelectable = (
    state: ClaudeProjectState | undefined,
    selectedModel = state?.metrics?.modelId ?? state?.config.model,
  ): boolean => {
    const model = selectedModel ? stripClaudeContextWindowSuffix(selectedModel).toLowerCase() : '';
    return Boolean(
      state?.config.preset === 'chatgpt-subscription' &&
      (model === 'gpt-5.6-sol' || model === 'gpt-5.6'),
    );
  };

  const syncManagedChatGptContextWindowSelection = (): void => {
    for (const button of footerContextWindowOptions.querySelectorAll<HTMLButtonElement>(
      '[data-context-window-mode]',
    )) {
      button.setAttribute(
        'aria-checked',
        String(button.dataset.contextWindowMode === footerState.managedChatGptContextWindowMode),
      );
    }
  };

  const syncClaudeContextWindowSelection = (): void => {
    for (const button of claudeContextWindowOptions.querySelectorAll<HTMLButtonElement>(
      '[data-claude-context-window-mode]',
    )) {
      button.setAttribute(
        'aria-checked',
        String(button.dataset.claudeContextWindowMode === footerState.claudeContextWindowMode),
      );
    }
    claudeContextWindowCustomField.hidden =
      footerState.claudeContextWindowMode !== 'custom' &&
      !footerState.claudeContextWindowCustomDraftOpen;
    if (footerState.claudeContextWindowCustomTokens !== undefined) {
      claudeContextWindowCustomInput.value = String(footerState.claudeContextWindowCustomTokens);
    }
  };

  const requestedClaudeContextWindowTokens = (): number | undefined =>
    footerState.claudeContextWindowMode === 'extended'
      ? 1_000_000
      : footerState.claudeContextWindowMode === 'standard'
        ? 200_000
        : footerState.claudeContextWindowMode === 'custom'
          ? footerState.claudeContextWindowCustomTokens
          : undefined;

  return {
    managedContextWindowSelectable,
    syncManagedChatGptContextWindowSelection,
    syncClaudeContextWindowSelection,
    requestedClaudeContextWindowTokens,
  };
};
